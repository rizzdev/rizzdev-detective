#!/usr/bin/env node
import { readFileSync, writeFileSync, realpathSync } from 'node:fs';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// ---------------------------------------------------------------------------
// Input handling: validate, normalize, load
// ---------------------------------------------------------------------------

export function validateQuestions(doc) {
  if (!doc || typeof doc !== 'object') throw new Error('questions JSON must be an object');
  const hasSections = Array.isArray(doc.sections);
  const hasFlat = Array.isArray(doc.questions);
  if (!hasSections && !hasFlat) {
    throw new Error('questions JSON must have a "sections" array or a "questions" array');
  }
  const sections = hasSections ? doc.sections : [{ questions: doc.questions }];
  const seen = new Set();
  for (const sec of sections) {
    if (!sec || !Array.isArray(sec.questions)) throw new Error('each section must have a "questions" array');
    for (const q of sec.questions) {
      if (!q || typeof q.id !== 'string' || !q.id) throw new Error('each question needs a non-empty string "id"');
      if (seen.has(q.id)) throw new Error(`duplicate question id: ${q.id}`);
      seen.add(q.id);
      if (typeof q.text !== 'string' || !q.text) throw new Error(`question ${q.id} needs "text"`);
      if (q.type !== undefined && q.type !== 'single' && q.type !== 'multi' && q.type !== 'yesno') {
        throw new Error(`question ${q.id} type must be "single", "multi", or "yesno"`);
      }
      // "yesno" questions auto-generate Yes/No options, so options are optional there.
      if (q.type !== 'yesno' && (!Array.isArray(q.options) || q.options.length === 0)) {
        throw new Error(`question ${q.id} needs a non-empty "options" array`);
      }
      if (Array.isArray(q.options)) {
        const optSeen = new Set();
        for (const o of q.options) {
          if (!o || typeof o.id !== 'string' || !o.id) throw new Error(`question ${q.id} has an option missing "id"`);
          if (optSeen.has(o.id)) throw new Error(`question ${q.id} has duplicate option id: ${o.id}`);
          optSeen.add(o.id);
          if (typeof o.label !== 'string' || !o.label) throw new Error(`question ${q.id} option ${o.id} needs "label"`);
        }
      }
    }
  }
  return doc;
}

export function normalizeQuestions(doc) {
  validateQuestions(doc);
  const rawSections = Array.isArray(doc.sections)
    ? doc.sections
    : [{ title: undefined, questions: doc.questions }];
  const sections = rawSections.map((sec) => ({
    title: typeof sec.title === 'string' ? sec.title : undefined,
    questions: sec.questions.map((q) => {
      const isYesNo = q.type === 'yesno';
      const rawOptions = Array.isArray(q.options) && q.options.length ? q.options : null;
      const options = isYesNo && !rawOptions
        ? [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }]
        : rawOptions.map((o) => ({ id: o.id, label: o.label, pro: o.pro, con: o.con }));
      return {
        id: q.id,
        text: q.text,
        why: typeof q.why === 'string' ? q.why : undefined,
        // yesno shares single-select semantics; `render` drives the layout.
        type: q.type === 'multi' ? 'multi' : 'single',
        render: isYesNo ? 'pills' : 'list',
        recommendation: q.recommendation && typeof q.recommendation === 'object'
          ? { optionId: q.recommendation.optionId, why: q.recommendation.why }
          : undefined,
        options,
        // Other box is off by default for yesno, on by default otherwise.
        allowOther: isYesNo ? q.allowOther === true : q.allowOther !== false,
      };
    }),
  }));
  return { title: typeof doc.title === 'string' ? doc.title : undefined, sections };
}

export function loadQuestions(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    throw new Error(`cannot read questions file ${path}: ${e.message}`);
  }
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    throw new Error(`questions file ${path} is not valid JSON: ${e.message}`);
  }
  return normalizeQuestions(doc);
}

// ---------------------------------------------------------------------------
// Rendering: normalized questions -> single-page HTML form
// ---------------------------------------------------------------------------

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function renderOption(q, o) {
  const inputType = q.type === 'multi' ? 'checkbox' : 'radio';
  const recommended = q.recommendation && q.recommendation.optionId === o.id;
  const pro = o.pro ? `<div class="pro">👍 ${esc(o.pro)}</div>` : '';
  const con = o.con ? `<div class="con">👎 ${esc(o.con)}</div>` : '';
  const star = recommended ? ' <span class="rec-star">★ recommended</span>' : '';
  return `
    <label class="option${recommended ? ' recommended' : ''}">
      <input type="${inputType}" name="q__${esc(q.id)}" data-qid="${esc(q.id)}" value="${esc(o.id)}">
      <div class="option-body">
        <div class="option-label">${esc(o.label)}${star}</div>
        ${pro}${con}
      </div>
    </label>`;
}

function renderPill(q, o) {
  const inputType = q.type === 'multi' ? 'checkbox' : 'radio';
  const recommended = q.recommendation && q.recommendation.optionId === o.id;
  const star = recommended ? ' <span class="rec-star">★</span>' : '';
  return `<label class="pill${recommended ? ' recommended' : ''}"><input type="${inputType}" name="q__${esc(q.id)}" data-qid="${esc(q.id)}" value="${esc(o.id)}">${esc(o.label)}${star}</label>`;
}

function renderQuestion(q) {
  const why = q.why ? `<p class="why"><span class="why-tag">The problem</span> ${esc(q.why)}</p>` : '';
  const rec = q.recommendation && q.recommendation.why
    ? `<div class="rec">💡 <strong>My recommendation:</strong> ${esc(q.recommendation.why)}</div>` : '';
  const other = q.allowOther
    ? `<input type="text" class="other" id="other__${esc(q.id)}" placeholder="Other / add nuance…">` : '';
  // A long list of short, pro/con-free options flows into two columns.
  const shortEnough = q.options.every((o) => !o.pro && !o.con && String(o.label).length <= 28);
  const twoCol = q.render === 'list' && q.options.length >= 6 && shortEnough;
  const controls = q.render === 'pills'
    ? `<div class="pills">${q.options.map((o) => renderPill(q, o)).join('')}</div>`
    : `<div class="options${twoCol ? ' two-col' : ''}">${q.options.map((o) => renderOption(q, o)).join('')}</div>`;
  return `
    <section class="question" data-qid="${esc(q.id)}">
      <h3>${esc(q.text)}</h3>
      ${why}
      ${rec}
      ${controls}
      ${other}
    </section>`;
}

function renderSection(sec) {
  const heading = sec.title ? `<h2 class="section-title">${esc(sec.title)}</h2>` : '';
  return `<div class="section">${heading}${sec.questions.map(renderQuestion).join('')}</div>`;
}

export function renderPage(questions) {
  const title = questions.title ? esc(questions.title) : 'rizzdev-detective';
  const body = questions.sections.map(renderSection).join('');
  const dataIsland = JSON.stringify(questions).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;font:14px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;background:#0d1117;color:#c9d1d9}
.wrap{max-width:680px;margin:0 auto;padding:18px 16px 76px}
h1{font-size:1.25rem;margin:0 0 12px;color:#e6edf3}
.section-title{font-size:.98rem;color:#e6edf3;border-bottom:1px solid #21262d;padding-bottom:3px;margin:16px 0 6px}
.question{background:#161b22;border:1px solid #30363d;border-radius:9px;padding:10px 12px;margin:8px 0}
.question h3{margin:0 0 4px;font-size:.95rem;color:#e6edf3}
.why{margin:0 0 6px;color:#8b949e;font-size:.82rem}
.why-tag{display:inline-block;background:rgba(187,128,9,.15);color:#d29922;border-radius:4px;padding:0 6px;font-size:.7rem;margin-right:5px}
.rec{background:rgba(46,160,67,.12);border:1px solid rgba(46,160,67,.4);color:#3fb950;border-radius:6px;padding:5px 9px;margin:0 0 7px;font-size:.82rem}
.rec strong{color:#56d364}
.options{display:flex;flex-direction:column;gap:4px}
.options.two-col{display:grid;grid-template-columns:1fr 1fr;gap:4px 10px}
@media(max-width:460px){.options.two-col{grid-template-columns:1fr}}
.option{display:flex;gap:8px;align-items:flex-start;background:#0d1117;border:1px solid #30363d;border-radius:7px;padding:6px 10px;cursor:pointer}
.option:hover{border-color:#8b949e}
.option.recommended{border-color:#238636}
.option input{margin-top:3px;accent-color:#2f81f7}
.option-label{font-weight:600;color:#e6edf3}
.rec-star{color:#3fb950;font-weight:600;font-size:.75rem;margin-left:5px}
.pro{color:#3fb950;font-size:.78rem;margin-top:1px}
.con{color:#f85149;font-size:.78rem;margin-top:1px}
.pills{display:flex;gap:6px;flex-wrap:wrap}
.pill{display:inline-flex;align-items:center;gap:7px;background:#21262d;border:1px solid #30363d;border-radius:7px;padding:5px 14px;cursor:pointer;font-weight:600;color:#c9d1d9}
.pill:hover{border-color:#8b949e}
.pill:has(input:checked){background:#1f6feb;border-color:#1f6feb;color:#fff}
.pill.recommended{border-color:#238636}
.pill input{margin:0;accent-color:#fff}
.other{width:100%;margin-top:6px;background:#0d1117;border:1px solid #30363d;color:#c9d1d9;border-radius:6px;padding:6px 9px;font-size:.85rem}
.other:focus,textarea#__global:focus{outline:0;border-color:#2f81f7;box-shadow:0 0 0 2px rgba(47,129,247,.35)}
textarea#__global{width:100%;min-height:56px;background:#0d1117;border:1px solid #30363d;color:#c9d1d9;border-radius:7px;padding:8px;font-size:.85rem}
.global{background:#161b22;border:1px solid #30363d;border-radius:9px;padding:10px 12px;margin:12px 0}
.global h3{margin:0 0 5px;font-size:.95rem;color:#e6edf3}
.bar{position:fixed;bottom:0;left:0;right:0;background:#161b22;border-top:1px solid #30363d;padding:9px 16px;display:flex;justify-content:center}
.bar button{background:#238636;color:#fff;border:1px solid rgba(240,246,252,.1);border-radius:7px;padding:8px 24px;font-size:.92rem;font-weight:600;cursor:pointer}
.bar button:hover{background:#2ea043}
.done{max-width:600px;margin:100px auto;text-align:center}
</style></head>
<body>
<div class="wrap">
  <h1>${title}</h1>
  ${body}
  <div class="global">
    <h3>Anything else?</h3>
    <textarea id="__global" placeholder="Any overall notes not tied to a specific question…"></textarea>
  </div>
</div>
<div class="bar"><button id="submit" type="button">Submit answers</button></div>
<script>
const DETECTIVE = ${dataIsland};
function collect(){
  const answers = {};
  for (const sec of DETECTIVE.sections) for (const q of sec.questions) {
    const sel = [...document.querySelectorAll('input[data-qid="'+q.id+'"]:checked')].map(el => el.value);
    const otherEl = document.getElementById('other__'+q.id);
    answers[q.id] = { selected: sel, other: otherEl ? otherEl.value : '' };
  }
  const g = document.getElementById('__global');
  return { answers, globalNote: g ? g.value : '' };
}
document.getElementById('submit').addEventListener('click', async () => {
  try {
    await fetch('/submit', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(collect()) });
  } catch (e) {}
  document.body.innerHTML = '<div class="done"><h1>Answers sent ✓</h1><p>You can close this tab and return to Claude.</p></div>';
});
</script>
</body></html>`;
}

// ---------------------------------------------------------------------------
// Results: raw client payload -> canonical results object
// ---------------------------------------------------------------------------

export function normalizeResults(payload, questions, submittedAt) {
  const meta = [];
  for (const sec of questions.sections) for (const q of sec.questions) meta.push({ id: q.id, type: q.type });
  const src = payload && typeof payload.answers === 'object' && payload.answers ? payload.answers : {};
  const answers = {};
  for (const { id, type } of meta) {
    const a = src[id] && typeof src[id] === 'object' ? src[id] : {};
    let selected = Array.isArray(a.selected) ? a.selected.filter((s) => typeof s === 'string') : [];
    if (type === 'single' && selected.length > 1) selected = selected.slice(0, 1);
    answers[id] = { selected, other: typeof a.other === 'string' ? a.other : '' };
  }
  return {
    answers,
    globalNote: payload && typeof payload.globalNote === 'string' ? payload.globalNote : '',
    submittedAt: submittedAt || new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Server + CLI
// ---------------------------------------------------------------------------

const CONFIRM_HTML = `<!doctype html><meta charset="utf-8"><title>Sent</title>
<body style="font:16px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;background:#0d1117;color:#c9d1d9;text-align:center;padding-top:120px">
<h1>Answers sent ✓</h1><p>You can close this tab and return to Claude.</p></body>`;

export function serve(questions, opts = {}) {
  const html = renderPage(questions);
  const maxTries = opts.maxTries || 20;
  let port = opts.port || 8787;
  let tries = 0;
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/?'))) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
      }
      if (req.method === 'POST' && req.url === '/submit') {
        let body = '';
        req.on('data', (c) => { body += c; if (body.length > 5_000_000) req.destroy(); });
        req.on('end', () => {
          let payload = {};
          try { payload = JSON.parse(body || '{}'); } catch { payload = {}; }
          const results = normalizeResults(payload, questions);
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(CONFIRM_HTML);
          server.close(() => resolve(results));
        });
        return;
      }
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
    });
    server.on('error', (e) => {
      if (e.code === 'EADDRINUSE' && tries < maxTries) { tries++; port++; server.listen(port, '127.0.0.1'); }
      else reject(e);
    });
    server.on('listening', () => { if (opts.onListen) opts.onListen(`http://127.0.0.1:${port}/`); });
    server.listen(port, '127.0.0.1');
  });
}

function openBrowser(url) {
  const cmds = [['wslview', [url]], ['explorer.exe', [url]], ['xdg-open', [url]], ['open', [url]]];
  const tryNext = (i) => {
    if (i >= cmds.length) return;
    const [cmd, a] = cmds[i];
    const child = spawn(cmd, a, { stdio: 'ignore', detached: true });
    child.on('error', () => tryNext(i + 1));
    child.unref();
  };
  tryNext(0);
}

async function main() {
  const args = process.argv.slice(2);
  const path = args.find((a) => !a.startsWith('--'));
  const outIdx = args.indexOf('--out');
  const outPath = outIdx >= 0 ? args[outIdx + 1] : null;
  if (!path) {
    console.error('usage: node detective.mjs <questions.json> [--out <results.json>]');
    process.exit(2);
  }
  let questions;
  try {
    questions = loadQuestions(path);
  } catch (e) {
    console.error(`error: ${e.message}`);
    process.exit(1);
  }
  const results = await serve(questions, {
    onListen: (url) => {
      console.error(`\nrizzdev-detective ready → ${url}`);
      console.error('Waiting for you to submit your answers…\n');
      openBrowser(url);
    },
  });
  if (outPath) writeFileSync(outPath, JSON.stringify(results, null, 2));
  process.stdout.write(JSON.stringify(results, null, 2) + '\n');
  process.exit(0);
}

// Resolve argv[1] through realpath so this still runs when invoked via a
// symlink (Node resolves import.meta.url to the real path, not the link).
function isEntryPoint() {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main();
}
