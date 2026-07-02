#!/usr/bin/env node
import { readFileSync, writeFileSync, realpathSync, mkdirSync } from 'node:fs';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';

// ---------------------------------------------------------------------------
// Input handling: validate, normalize, load
// ---------------------------------------------------------------------------

export function validateQuestions(doc, opts = {}) {
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
      if (q.type !== undefined && !['single', 'multi', 'yesno', 'rank'].includes(q.type)) {
        throw new Error(`question ${q.id} type must be "single", "multi", "yesno", or "rank"`);
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
      if (opts.requireHints) {
        if (typeof q.why !== 'string' || !q.why) throw new Error(`question ${q.id} needs a "why" (requireHints)`);
        if (q.type !== 'yesno' && Array.isArray(q.options)) {
          for (const o of q.options) {
            if (!o.pro && !o.hint) throw new Error(`question ${q.id} option ${o.id} needs a "pro" or "hint" (requireHints)`);
          }
        }
      }
      if (opts.forceVisual && (q.type === undefined || q.type === 'single' || q.type === 'multi')) {
        const hasVisual = typeof q.visual === 'string' && q.visual.trim() !== '';
        if (!hasVisual && q.visual !== false) {
          throw new Error(`question ${q.id} needs a "visual" (forceVisual) — set visual:false only if a diagram truly adds nothing`);
        }
      }
    }
  }
  return doc;
}

export function normalizeQuestions(doc, opts = {}) {
  validateQuestions(doc, opts);
  const rawSections = Array.isArray(doc.sections)
    ? doc.sections
    : [{ title: undefined, questions: doc.questions }];
  const sections = rawSections.map((sec) => ({
    title: typeof sec.title === 'string' ? sec.title : undefined,
    questions: sec.questions.map((q) => {
      const isYesNo = q.type === 'yesno';
      const isRank = q.type === 'rank';
      const rawOptions = Array.isArray(q.options) && q.options.length ? q.options : null;
      const options = isYesNo && !rawOptions
        ? [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }]
        : rawOptions.map((o) => ({ id: o.id, label: o.label, pro: o.pro, con: o.con, hint: o.hint }));
      return {
        id: q.id,
        text: q.text,
        why: typeof q.why === 'string' ? q.why : undefined,
        visual: typeof q.visual === 'string' ? q.visual : (q.visual === false ? false : undefined),
        // `type` drives result semantics; `render` drives the layout.
        // yesno → single-select semantics; rank → its own ordered semantics.
        type: isRank ? 'rank' : q.type === 'multi' ? 'multi' : 'single',
        render: isYesNo ? 'pills' : isRank ? 'rank' : 'list',
        recommendation: q.recommendation && typeof q.recommendation === 'object'
          ? { optionId: q.recommendation.optionId, why: q.recommendation.why }
          : undefined,
        options,
        // rank-only: colour positions by severity/goodness gradient.
        priority: isRank ? q.priority === true : undefined,
        // Other box is off by default for yesno/rank, on by default otherwise.
        allowOther: isYesNo || isRank ? q.allowOther === true : q.allowOther !== false,
      };
    }),
  }));
  return { title: typeof doc.title === 'string' ? doc.title : undefined, findings: normalizeFindings(doc.findings), sections };
}

// Optional research briefing shown at the top of the form. Lenient: anything
// malformed just drops to undefined (no panel) rather than erroring.
export function normalizeFindings(f) {
  if (!f || typeof f !== 'object' || typeof f.summary !== 'string' || !f.summary.trim()) return undefined;
  const sources = Array.isArray(f.sources)
    ? f.sources
        .filter((s) => s && typeof s.ref === 'string' && s.ref)
        .map((s) => ({ label: typeof s.label === 'string' && s.label ? s.label : s.ref, ref: s.ref }))
    : [];
  return { summary: f.summary, sources };
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

// Tag `path/to/file.ext:12` (or :12-20) style code references.
function codeRefs(s) {
  return s.replace(/([\w/.-]+\.\w+:\d+(?:-\d+)?)/g, '<span class="ref">$1</span>');
}

// Turn an already-escaped string into HTML: linkify URLs (clickable) and tag
// code refs — but never let code-ref tagging run inside a URL.
function linkify(escaped) {
  const urlRe = /(https?:\/\/[^\s<]+)/g;
  let out = '';
  let last = 0;
  let m;
  while ((m = urlRe.exec(escaped))) {
    out += codeRefs(escaped.slice(last, m.index));
    out += `<a href="${m[1]}" target="_blank" rel="noreferrer">${m[1]}</a>`;
    last = m.index + m[1].length;
  }
  out += codeRefs(escaped.slice(last));
  return out;
}

// Escape then linkify — for fields where Claude may cite sources.
function fmt(s) {
  return linkify(esc(s));
}

function renderFindings(f) {
  if (!f) return '';
  const sources = f.sources && f.sources.length
    ? `<ul class="sources">${f.sources.map((s) => {
        const isUrl = /^https?:\/\//.test(s.ref);
        return `<li>${isUrl
          ? `<a href="${esc(s.ref)}" target="_blank" rel="noreferrer">${esc(s.label)}</a>`
          : `<span class="ref">${esc(s.label)}</span>`}</li>`;
      }).join('')}</ul>`
    : '';
  return `<div class="findings"><h3>findings</h3><div class="findings-body">${fmt(f.summary)}</div>${sources}</div>`;
}

function renderOption(q, o) {
  const inputType = q.type === 'multi' ? 'checkbox' : 'radio';
  const recommended = q.recommendation && q.recommendation.optionId === o.id;
  const pro = o.pro ? `<div class="pro">${fmt(o.pro)}</div>` : '';
  const con = o.con ? `<div class="con">${fmt(o.con)}</div>` : '';
  const hint = !o.pro && !o.con && o.hint ? `<div class="ohint">${fmt(o.hint)}</div>` : '';
  const star = recommended ? ' <span class="rec-star">★ recommended</span>' : '';
  return `
    <label class="option${recommended ? ' recommended' : ''}">
      <input type="${inputType}" name="q__${esc(q.id)}" data-qid="${esc(q.id)}" value="${esc(o.id)}">
      <div class="option-body">
        <div class="option-label">${esc(o.label)}${star}</div>
        ${pro}${con}${hint}
      </div>
    </label>`;
}

function renderPill(q, o) {
  const inputType = q.type === 'multi' ? 'checkbox' : 'radio';
  const recommended = q.recommendation && q.recommendation.optionId === o.id;
  const star = recommended ? ' <span class="rec-star">★</span>' : '';
  return `<label class="pill${recommended ? ' recommended' : ''}"><input type="${inputType}" name="q__${esc(q.id)}" data-qid="${esc(q.id)}" value="${esc(o.id)}">${esc(o.label)}${star}</label>`;
}

function renderRankItems(q) {
  const cls = q.priority ? 'rank rank-prio' : 'rank';
  return `<ol class="${cls}" data-qid="${esc(q.id)}">${q.options.map((o) =>
    `<li class="rankrow" draggable="true" data-oid="${esc(o.id)}"><span class="grip">⠿</span><span class="rlabel">${esc(o.label)}</span>${o.pro ? `<span class="rpro">${fmt(o.pro)}</span>` : ''}</li>`,
  ).join('')}</ol>`;
}

function renderQuestion(q) {
  const why = q.why ? `<p class="why"><span class="why-tag">The problem</span> ${esc(q.why)}</p>` : '';
  const rec = q.recommendation && q.recommendation.why
    ? `<div class="rec">${fmt(q.recommendation.why)}</div>` : '';
  const other = q.allowOther
    ? (q.type === 'multi'
        ? `<div class="ownwrap" data-qid="${esc(q.id)}"><div class="ownchips"></div>`
          + `<input type="text" class="ownadd" placeholder="Add your own… (Enter)"></div>`
        : `<input type="text" class="other" id="other__${esc(q.id)}" placeholder="Other / add nuance…">`)
    : '';
  // A long list of short, pro/con-free options flows into two columns.
  const shortEnough = q.options.every((o) => !o.pro && !o.con && String(o.label).length <= 28);
  const twoCol = q.render === 'list' && q.options.length >= 6 && shortEnough;
  const controls = q.render === 'pills'
    ? `<div class="pills">${q.options.map((o) => renderPill(q, o)).join('')}</div>`
    : q.render === 'rank'
      ? renderRankItems(q)
      : `<div class="options${twoCol ? ' two-col' : ''}">${q.options.map((o) => renderOption(q, o)).join('')}</div>`;
  const recAttr = q.recommendation && q.recommendation.optionId ? ` data-rec="${esc(q.recommendation.optionId)}"` : '';
  const visual = (typeof q.visual === 'string' && q.visual.trim())
    ? `<div class="visual">${/^\s*<svg[\s>]/i.test(q.visual) ? q.visual : `<pre>${esc(q.visual)}</pre>`}</div>`
    : '';
  return `
    <section class="question" data-qid="${esc(q.id)}"${recAttr}>
      <h3>${esc(q.text)}</h3>
      ${why}
      ${rec}
      ${visual}
      ${controls}
      ${other}
    </section>`;
}

// Each section gets a random vibrant accent (legend + a thin left bar), fresh
// per render — a light touch, not a screen fill.
const SECTION_COLORS = ['#6cb6ff', '#a78bfa', '#f472b6', '#5eead4', '#fbbf24', '#f97316', '#a3e635', '#22d3ee', '#fb7185', '#c084fc', '#38bdf8', '#e879f9'];
function sectionColors(n) {
  const p = SECTION_COLORS.slice();
  for (let i = p.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [p[i], p[j]] = [p[j], p[i]]; }
  return Array.from({ length: n }, (_, i) => p[i % p.length]);
}

function renderSection(sec, color) {
  const heading = sec.title ? `<h2 class="section-title">${esc(sec.title)}</h2>` : '';
  const style = color ? ` style="--sc:${color}"` : '';
  return `<div class="section"${style}>${heading}${sec.questions.map(renderQuestion).join('')}</div>`;
}

const STYLES = `
:root{color-scheme:dark;
--fs-h1:16px;--fs-h3:15px;--fs-body:13px;--fs-meta:12.5px;--fs-micro:11.5px;
--tx1:#c6cedb;--tx2:#a7b0c0;--tx3:#828da0;--tx4:#5b6577;--tx5:#3d4757;
--grn:#7ee787;--grn2:#8fd694;--blu:#6cb6ff;--amb:#e2b86b;--red:#e58f8f;
--panel:#26324a;--line:#141b29;--indent:18px}
*{box-sizing:border-box}
::selection{background:#2d4b6e;color:#fff}
body{margin:0;background:#05070b;color:var(--tx2);font:var(--fs-body)/1.4 "JetBrains Mono","Fira Code","SFMono-Regular",ui-monospace,Menlo,Consolas,monospace;-webkit-font-smoothing:antialiased;padding:26px 16px 40px}
::-webkit-scrollbar{width:11px;height:11px}
::-webkit-scrollbar-thumb{background:#1b2130}
::-webkit-scrollbar-thumb:hover{background:#273044}

/* terminal window */
.wrap{max-width:780px;margin:0 auto;background:#0b0e14;border:1px solid #232c40;border-radius:8px;box-shadow:0 26px 70px rgba(0,0,0,.6),0 0 46px rgba(126,231,135,.05);overflow:hidden}
.titlebar{display:flex;align-items:center;gap:8px;padding:11px 14px;background:#0d1219;border-bottom:1px solid #1a2230;box-shadow:inset 0 1px 0 rgba(255,255,255,.03)}
.titlebar .dot{width:11px;height:11px;border-radius:50%;box-shadow:inset 0 0 1px rgba(0,0,0,.5),inset 0 1px 1px rgba(255,255,255,.14)}
.dot.r{background:#ff5f56}.dot.y{background:#ffbd2e}.dot.g{background:#27c93f}
.titlebar .tt{margin-left:8px;color:var(--tx4);font-size:var(--fs-micro)}
#gear{margin-inline-start:auto;background:transparent;border:0;color:var(--tx4);font-size:1rem;cursor:pointer;line-height:1}
#gear:hover{color:var(--tx2)}
.settings{padding:12px 16px;background:#0b0f16;border-bottom:1px solid #1a2230;display:flex;flex-direction:column;gap:8px}
.settings label{display:flex;align-items:center;gap:8px;color:var(--tx3);font-size:var(--fs-meta)}
.settings .ctxrow{display:flex;flex-direction:column;gap:4px;margin-top:4px}
.settings textarea{background:#080b11;border:1px solid #222a3a;color:var(--tx2);font:inherit;font-size:var(--fs-meta);padding:6px 9px;resize:vertical}
.setbtns{display:flex;align-items:center;gap:10px}
.setbtns button{font:inherit;background:#0f1c13;color:var(--grn);border:1px solid #2c8f45;padding:4px 12px;font-size:var(--fs-micro);font-weight:700;cursor:pointer}
#setmsg{color:var(--grn);font-size:var(--fs-micro)}
.screen{padding:20px}

.prompt{color:var(--tx4);font-size:var(--fs-meta);padding:0;margin:0}
.prompt .sym{color:var(--blu)}
.cursor{display:inline-block;width:7px;height:14px;background:var(--grn);margin-left:5px;vertical-align:-2px;animation:blink 1.1s steps(1) infinite}
@keyframes blink{50%{opacity:0}}
h1{font-size:var(--fs-h1);color:var(--tx1);margin:2px 0 8px;font-weight:700;line-height:1.35}
h1::before{content:"» ";color:var(--tx4)}

/* section = TUI panel with a legend on its top border */
.section{position:relative;border:1px solid var(--panel);padding:16px 14px 14px;margin:18px 0 0;box-shadow:inset 2px 0 0 var(--sc,transparent)}
.section-title{position:absolute;top:-8px;left:12px;margin:0;padding:0 7px;background:#0b0e14;color:var(--sc,var(--tx2));font-size:var(--fs-micro);letter-spacing:.14em;text-transform:lowercase;font-weight:700;border:0}

/* research briefing panel (blue, to distinguish from question panels) */
.findings{position:relative;border:1px solid #24344e;padding:16px 14px 14px;margin:18px 0 0;background:rgba(108,182,255,.03)}
.findings h3{position:absolute;top:-8px;left:12px;margin:0;padding:0 7px;background:#0b0e14;color:var(--blu);font-size:var(--fs-micro);letter-spacing:.14em;text-transform:lowercase;font-weight:700}
.findings-body{color:var(--tx2);font-size:var(--fs-meta);white-space:pre-wrap}
.findings .sources{margin:9px 0 0;padding:0;list-style:none}
.findings .sources li{color:var(--tx4);font-size:var(--fs-micro);margin:2px 0}
.findings .sources li::before{content:"- ";color:var(--blu)}
a{color:var(--blu);text-decoration:none;border-bottom:1px dotted #395574}
a:hover{color:#9ecbff;border-bottom-color:var(--blu)}
.ref{color:var(--amb)}

.question{position:relative;margin:0;padding:0}
.question + .question{margin-top:13px;padding-top:13px;border-top:1px solid var(--line)}
.question h3{margin:0 0 6px;font-size:var(--fs-h3);color:var(--tx1);font-weight:700;line-height:1.35}
.question h3::before{content:"? ";color:var(--tx4)}
.why{margin:0 0 6px;padding-left:var(--indent);color:var(--tx3);font-size:var(--fs-meta)}
.why-tag{color:var(--amb);font-weight:700;text-transform:lowercase}
.why-tag::after{content:":"}
.rec{padding:0 0 0 var(--indent);margin:0 0 8px;color:var(--grn2);font-size:var(--fs-meta)}
.rec::before{content:"» rec: ";color:var(--grn);font-weight:700}

.options{display:flex;flex-direction:column;gap:2px;padding-left:0}
.options.two-col{display:grid;grid-template-columns:1fr 1fr;gap:2px 14px}
@media(max-width:480px){.options.two-col{grid-template-columns:1fr}}
.option{position:relative;display:flex;gap:8px;align-items:flex-start;padding:3px 8px 3px 32px;cursor:pointer;color:var(--tx2)}
.option input{position:absolute;opacity:0;pointer-events:none}
.option::before{position:absolute;left:8px;top:1px;color:#616c82}
.option:has(input[type=radio])::before{content:"( )"}
.option:has(input[type=radio]:checked)::before{content:"(•)";color:var(--grn);font-weight:700}
.option:has(input[type=checkbox])::before{content:"[ ]"}
.option:has(input[type=checkbox]:checked)::before{content:"[×]";color:var(--grn)}
.option:hover{background:#121826;color:var(--tx1)}
.option:hover::before{color:var(--blu)}
.option:has(input:checked){color:var(--tx1)}
.option-label{font-weight:500;color:inherit}
.rec-star{color:var(--amb);font-weight:700;font-size:var(--fs-micro);margin-left:6px}
.pro,.con{padding-left:0;font-size:var(--fs-micro);margin-top:1px}
.pro{color:var(--grn2)}.pro::before{content:"+ ";font-weight:700}
.con{color:var(--red)}.con::before{content:"- ";font-weight:700}
.ohint{padding-left:0;font-size:var(--fs-micro);margin-top:1px;color:var(--tx4)}
.visual{margin:8px 0;padding:8px;border:1px solid #222a3a;border-radius:6px;overflow:auto}
.visual pre{margin:0;white-space:pre;font-size:var(--fs-micro);color:var(--tx3)}
.visual svg{max-width:100%;height:auto}

/* drag-to-rank */
.rank{list-style:none;counter-reset:rk;margin:2px 0 0;padding-left:0;display:flex;flex-direction:column;gap:2px}
.rankrow{counter-increment:rk;display:flex;align-items:center;gap:9px;padding:3px 8px;cursor:grab}
.rankrow:hover{background:#121826}
.rankrow::before{content:counter(rk);color:var(--blu);font-weight:700;min-width:14px;text-align:right}
.rankrow.drag{opacity:.35}
.rankrow .grip{color:var(--tx5);cursor:grab;letter-spacing:-2px}
.rankrow .rlabel{font-weight:500;color:var(--tx1)}
.rankrow .rpro{color:var(--tx4);font-size:var(--fs-micro);margin-left:auto}
.rankrow.grabbed{background:#15120a;box-shadow:inset 2px 0 0 var(--amb)}
/* priority ranking: colored severity/goodness indicator per position */
.rank-prio .rankrow::before{color:var(--pc,var(--blu))}
.rank-prio .rankrow .grip{color:var(--pc,var(--tx5))}

.pills{display:flex;gap:8px;flex-wrap:wrap;padding-left:var(--indent);margin-top:2px}
.pill{position:relative;display:inline-flex;align-items:center;border:1px solid #2a3346;padding:2px 12px;cursor:pointer;font-weight:600;color:#7d8799}
.pill:hover{border-color:#3a4a63;color:var(--tx1)}
.pill:has(input:checked){border-color:var(--grn);color:var(--grn);background:rgba(126,231,135,.07)}
.pill:has(input:checked)::before{content:"‹ ";color:var(--grn)}
.pill:has(input:checked)::after{content:" ›";color:var(--grn)}
.pill input{position:absolute;opacity:0;pointer-events:none}

.other{width:calc(100% - var(--indent));margin:6px 0 0 var(--indent);background:#080b11;border:1px solid #222a3a;color:var(--tx2);padding:5px 9px;font:inherit;font-size:var(--fs-meta)}
.other::placeholder,textarea#__global::placeholder{color:var(--tx4)}
.ownwrap{margin:6px 0 0 var(--indent)}
.ownadd{width:calc(100% - var(--indent));background:#080b11;border:1px solid #222a3a;color:var(--tx2);padding:5px 9px;font:inherit;font-size:var(--fs-meta)}
.ownadd::placeholder{color:var(--tx4)}
.ownchips{display:flex;flex-wrap:wrap;gap:5px;margin-bottom:5px}
.ownchip{background:#0f1c13;border:1px solid #2c8f45;color:var(--grn);padding:2px 8px;border-radius:10px;font-size:var(--fs-micro)}
.other:focus,textarea#__global:focus{outline:0;border-color:var(--blu);box-shadow:0 0 0 1px rgba(108,182,255,.35)}

/* global note = its own panel */
.global{position:relative;border:1px solid var(--panel);padding:16px 14px 14px;margin:18px 0 0}
.global h3{position:absolute;top:-8px;left:12px;margin:0;padding:0 7px;background:#0b0e14;color:var(--tx3);font-size:var(--fs-micro);letter-spacing:.14em;text-transform:lowercase;font-weight:700}
textarea#__global{width:100%;background:#080b11;border:1px solid #222a3a;color:var(--tx2);padding:8px 10px;font:inherit;font-size:var(--fs-meta);min-height:52px;resize:vertical}

.bar{display:flex;justify-content:flex-end;padding:16px 0 2px}
.bar button,.cont button{font:inherit;background:#0f1c13;color:var(--grn);border:1px solid #2c8f45;padding:5px 16px;font-size:var(--fs-meta);font-weight:700;letter-spacing:.03em;cursor:pointer}
.bar button::before{content:"⏎ "}
.bar button:hover,.bar button:focus-visible,.cont button:hover,.cont button:focus-visible{background:var(--grn);color:#0b0e14;border-color:var(--grn)}
.done{max-width:560px;margin:110px auto;text-align:center}
.done .ok{color:var(--grn);font-size:18px;font-weight:700}
.done p{color:var(--tx4)}

/* live mode */
.statusline{display:flex;align-items:center;gap:8px;color:var(--tx4);font-size:var(--fs-meta);margin:18px 0 2px}
.statusline .dotp{width:8px;height:8px;border-radius:50%;background:var(--blu);box-shadow:0 0 8px var(--blu)}
.statusline.think .dotp{background:var(--amb);box-shadow:0 0 8px var(--amb);animation:pulse 1s ease-in-out infinite}
.statusline.done .dotp{background:var(--grn);box-shadow:0 0 8px var(--grn)}
@keyframes pulse{50%{opacity:.3}}
.batch{animation:reveal .28s ease-out}
@keyframes reveal{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
.batch.spent{opacity:.55}
.cont{display:flex;justify-content:flex-end;margin-top:10px}
.cont button{padding:4px 14px;font-size:var(--fs-micro)}
.cont button:disabled{color:var(--tx5);border-color:#222a3a;cursor:default;background:transparent}
.cont button:disabled:hover{color:var(--tx5);background:transparent;border-color:#222a3a}
.cont .sent{color:var(--grn);font-weight:700;font-size:var(--fs-micro);margin-right:8px}
.cont .revise{font:inherit;background:transparent;color:#7d8799;border:1px solid #2a3346;padding:3px 10px;font-size:var(--fs-micro);cursor:pointer}
.cont .revise:hover{border-color:var(--blu);color:var(--blu)}
.batch.spent .option,.batch.spent .pill{cursor:default}
.endbar{display:flex;justify-content:flex-end;gap:8px;margin-top:16px}
.endbar button{font:inherit;background:transparent;color:#7d8799;border:1px solid #2a3346;padding:4px 12px;font-size:var(--fs-micro);cursor:pointer}
.endbar button:hover{border-color:var(--red);color:var(--red)}

/* keyboard-first navigation */
.kfocus{background:#141b2b}
.option.kfocus,.rankrow.kfocus{box-shadow:inset 2px 0 0 var(--blu)}
.pill.kfocus{border-color:var(--blu)}
.kbhint{color:var(--tx5);font-size:var(--fs-micro);margin-top:14px}
.kbhint b{color:var(--blu);font-weight:700}
#kbhelp{display:none;position:fixed;left:50%;bottom:18px;transform:translateX(-50%);max-width:560px;background:#0d1219;border:1px solid var(--panel);padding:12px 16px;font-size:var(--fs-meta);line-height:1.7;color:var(--tx2);box-shadow:0 14px 44px rgba(0,0,0,.6);z-index:20}
#kbhelp .kh{color:var(--grn);font-weight:700;margin-bottom:4px}
#kbhelp b{color:var(--grn)}

/* response-action bar (live mode) */
.qactions{display:flex;gap:6px;flex-wrap:wrap;margin-top:9px;padding-left:var(--indent)}
.qactions button{font:inherit;background:transparent;color:#7d8799;border:1px solid #222a3a;padding:2px 9px;font-size:var(--fs-micro);cursor:pointer}
.qactions button:hover{border-color:var(--blu);color:var(--blu)}
.question.delegated>h3::after{content:" · delegated to claude ✓";color:var(--grn2);font-weight:600;font-size:var(--fs-micro)}
.question.awaiting{opacity:.55}

/* a single question locked while claude reworks it (in place, no reload) */
.question.working{box-shadow:inset 2px 0 0 var(--amb)}
.question.working>h3::after{content:" · reworking…";color:var(--amb);font-weight:600;font-size:var(--fs-micro)}
.batch.locked-rework .cont::after{content:" · finish reworking first";color:var(--amb);font-size:var(--fs-micro)}
.qago{margin-inline-start:8px;font-size:var(--fs-micro);color:var(--amb);font-weight:400}
.qbadge{display:flex;align-items:center;gap:8px;margin:6px 0 0 var(--indent);padding:5px 9px;border-radius:5px;font-size:var(--fs-micro);background:#1c1608;border:1px solid #5a4410}
.qbadge.serious{background:#231010;border-color:#7a2626}
.qbadge .btext{color:var(--amb);flex:1}
.qbadge button{font:inherit;background:transparent;border:1px solid #3a4256;color:var(--tx3);padding:2px 8px;font-size:var(--fs-micro);cursor:pointer}
.qbadge button:hover{border-color:var(--blu);color:var(--blu)}
.auditbtn{display:none;margin:6px 0 0 auto;font:inherit;background:transparent;border:1px dashed #3a4256;color:var(--tx4);padding:3px 10px;font-size:var(--fs-micro);cursor:pointer}
.auditbtn:hover{border-color:var(--amb);color:var(--amb)}
body.audit-on .auditbtn{display:inline-block}
.question.working .option,.question.working .pill,.question.working .rankrow{cursor:default;opacity:.7}
.question.working .qactions{opacity:.35;pointer-events:none}
.qworking{display:flex;align-items:center;gap:7px;margin:8px 0 0 var(--indent);color:var(--amb);font-size:var(--fs-micro);font-weight:600}
.qworking .dotp{width:7px;height:7px;border-radius:50%;background:var(--amb);box-shadow:0 0 8px var(--amb);animation:pulse 1s ease-in-out infinite}
.qflash{animation:qflash 1.1s ease-out}
@keyframes qflash{0%{background:rgba(126,231,135,.10)}100%{background:transparent}}

/* toasts */
#toasts{position:fixed;right:16px;bottom:16px;display:flex;flex-direction:column;gap:8px;z-index:40}
.toast{background:#0d1219;border:1px solid var(--panel);border-left:3px solid var(--blu);color:var(--tx1);padding:9px 13px;font-size:var(--fs-micro);line-height:1.4;box-shadow:0 12px 34px rgba(0,0,0,.55);opacity:0;transform:translateY(8px);transition:opacity .2s,transform .2s;max-width:320px}
.toast.show{opacity:1;transform:none}
.toast.good{border-left-color:var(--grn)}
.toast.warn{border-left-color:var(--amb)}
`;

// Shared client script: drag-to-reorder for every .rank list (idempotent).
const RANK_JS = `
function paintPrio(list){
  if(!list.classList.contains('rank-prio'))return;
  var rows=[].slice.call(list.querySelectorAll('.rankrow')),n=rows.length;
  rows.forEach(function(r,i){var t=n<2?0:i/(n-1);var h=Math.round(120-120*t);r.style.setProperty('--pc','hsl('+h+',72%,62%)');});
}
window.paintRank=paintPrio;
function initRank(root){
  root.querySelectorAll('.rank').forEach(function(list){
    if(list.dataset.rankInit)return; list.dataset.rankInit='1';
    paintPrio(list);
    list.querySelectorAll('.rankrow').forEach(function(row){
      row.addEventListener('dragstart',function(e){window.__drag=row;row.classList.add('drag');if(e.dataTransfer)e.dataTransfer.effectAllowed='move';});
      row.addEventListener('dragend',function(){row.classList.remove('drag');window.__drag=null;});
      row.addEventListener('dragover',function(e){e.preventDefault();var d=window.__drag;if(!d||d===row||d.parentNode!==list)return;var r=row.getBoundingClientRect();var after=(e.clientY-r.top)/r.height>0.5;list.insertBefore(d,after?row.nextSibling:row);paintPrio(list);});
    });
  });
}`;

// Keyboard-first navigation: focus ring over options/pills/rank rows, with
// vim-style keys. Shared verbatim by the one-shot and live pages.
const NAV_HTML = `<div class="kbhint"><b>j/k</b> move · <b>space</b> select · <b>1-9</b> pick · <b>o</b> other · <b>⏎</b> submit · <b>?</b> keys</div>
<div id="kbhelp"><div class="kh"><b>keyboard</b></div>j / k &nbsp;or&nbsp; ↑ / ↓ — move focus<br>space — select · on a rank row: grab, then j/k to move, space to drop<br>1–9 — pick an option in the focused question<br>o — jump to the "other" box · ⏎ — submit / continue · ? — toggle · esc — cancel</div>`;

const NAV_JS = `
(function(){
  var grabbed=null;
  function foci(){return [].slice.call(document.querySelectorAll('.option,.pill,.rankrow'));}
  function cur(){return document.querySelector('.kfocus');}
  function setFocus(el){var c=cur();if(c)c.classList.remove('kfocus');if(el){el.classList.add('kfocus');el.scrollIntoView({block:'nearest'});}}
  function move(dir){
    if(grabbed){var lst=grabbed.parentNode,rows=[].slice.call(lst.querySelectorAll('.rankrow')),i=rows.indexOf(grabbed),j=i+dir;if(j<0||j>=rows.length)return;if(dir>0)lst.insertBefore(grabbed,rows[j].nextSibling);else lst.insertBefore(grabbed,rows[j]);if(window.paintRank)window.paintRank(lst);grabbed.scrollIntoView({block:'nearest'});return;}
    var list=foci();if(!list.length)return;var i=list.indexOf(cur());var n=i<0?0:Math.min(list.length-1,Math.max(0,i+dir));setFocus(list[n]);
  }
  function activate(){var c=cur();if(!c)return;if(c.classList.contains('rankrow')){if(grabbed===c){grabbed.classList.remove('grabbed');grabbed=null;}else{grabbed=c;c.classList.add('grabbed');}return;}var inp=c.querySelector('input');if(inp)inp.click();else c.click();}
  function selectNum(n){var c=cur();var q=c?c.closest('.question'):document.querySelector('.question');if(!q)return;var opts=q.querySelectorAll('.option,.pill');if(opts[n-1]){setFocus(opts[n-1]);var inp=opts[n-1].querySelector('input');if(inp)inp.click();}}
  function submit(){var conts=[].slice.call(document.querySelectorAll('.cont button:not([disabled])'));if(conts.length){conts[conts.length-1].click();return;}var s=document.getElementById('submit');if(s)s.click();}
  function help(){var h=document.getElementById('kbhelp');if(h)h.style.display=h.style.display==='block'?'none':'block';}
  document.addEventListener('keydown',function(e){
    var t=e.target;if(t&&(t.tagName==='TEXTAREA'||(t.tagName==='INPUT'&&t.type==='text'))){if(e.key==='Escape')t.blur();return;}
    var k=e.key;
    if(k==='j'||k==='ArrowDown'){e.preventDefault();move(1);}
    else if(k==='k'||k==='ArrowUp'){e.preventDefault();move(-1);}
    else if(k===' '){e.preventDefault();activate();}
    else if(k==='Enter'){e.preventDefault();submit();}
    else if(k==='o'){var c=cur(),q=c?c.closest('.question'):null,o=q?q.querySelector('.other'):null;if(o){e.preventDefault();o.focus();}}
    else if((k==='d'||k==='r'||k==='s'||k==='m')&&window.qaction){var cq=cur()&&cur().closest('.question');if(cq){e.preventDefault();window.qaction({d:'decide',r:'rethink',s:'research',m:'more'}[k],cq);}}
    else if(k==='?'){e.preventDefault();help();}
    else if(k==='Escape'){if(grabbed){grabbed.classList.remove('grabbed');grabbed=null;}var h=document.getElementById('kbhelp');if(h)h.style.display='none';}
    else if(/^[1-9]$/.test(k)){e.preventDefault();selectNum(parseInt(k,10));}
  });
  window.kfocusScan=function(){if(!cur()){var f=foci();if(f.length)setFocus(f[0]);}};
  window.kfocusIn=function(scope){if(!scope)return;var f=[].slice.call(scope.querySelectorAll('.option,.pill,.rankrow'));if(f.length)setFocus(f[0]);};
})();`;

export function renderPage(questions) {
  const title = questions.title ? esc(questions.title) : 'claude-detective';
  const cols = sectionColors(questions.sections.length);
  const body = renderFindings(questions.findings) + questions.sections.map((s, i) => renderSection(s, cols[i])).join('');
  const dataIsland = JSON.stringify(questions).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>${STYLES}</style></head>
<body>
<div class="wrap">
  <div class="titlebar"><span class="dot r"></span><span class="dot y"></span><span class="dot g"></span><span class="tt">claude@detective: ./detective</span></div>
  <div class="screen">
    <h1>${title}</h1>
    ${body}
    <div class="global">
      <h3>anything else?</h3>
      <textarea id="__global" placeholder="notes not tied to a specific question…"></textarea>
    </div>
    <div class="bar"><button id="submit" type="button">submit answers</button></div>
    ${NAV_HTML}
  </div>
</div>
<script>
const DETECTIVE = ${dataIsland};
function collect(){
  const answers = {};
  for (const sec of DETECTIVE.sections) for (const q of sec.questions) {
    let sel;
    if(q.render==='rank'){ sel=[...document.querySelectorAll('.rank[data-qid="'+q.id+'"] .rankrow')].map(r=>r.dataset.oid); }
    else { sel=[...document.querySelectorAll('input[data-qid="'+q.id+'"]:checked')].map(el => el.value); }
    const otherEl = document.getElementById('other__'+q.id);
    answers[q.id] = { selected: sel, other: otherEl ? otherEl.value : '' };
  }
  const g = document.getElementById('__global');
  return { answers, globalNote: g ? g.value : '' };
}
${RANK_JS}
initRank(document);
${NAV_JS}
document.getElementById('submit').addEventListener('click', async () => {
  try {
    await fetch('/submit', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(collect()) });
  } catch (e) {}
  document.body.innerHTML = '<div class="done"><div class="ok">✓ answers sent</div><p>you can close this tab and return to claude.</p></div>';
});
</script>
</body></html>`;
}

// ---------------------------------------------------------------------------
// Live mode rendering: a persistent shell the server pushes question batches into
// ---------------------------------------------------------------------------

// A pushed batch is just a normalized questions doc; render it as one revealable
// block with its own "continue" button.
export function renderBatchHtml(nq, id) {
  const heading = nq.title ? `<h1>${esc(nq.title)}</h1>` : '';
  const cols = sectionColors(nq.sections.length);
  const inner = renderFindings(nq.findings) + nq.sections.map((s, i) => renderSection(s, cols[i])).join('');
  return `<div class="batch" data-batch="${id}">${heading}${inner}<div class="cont"><button type="button" onclick="sendBatch(${id})">continue →</button></div></div>`;
}

// Render a single question fragment (one `.question` section) for in-place
// replacement in a live batch. `id` forces the question id so a rework can't
// accidentally re-key the question; falls back to the raw question's own id.
export function renderQuestionHtml(rawQuestion, id) {
  const q = { ...rawQuestion, id: id != null ? id : rawQuestion && rawQuestion.id };
  const nq = normalizeQuestions({ questions: [q] });
  return renderQuestion(nq.sections[0].questions[0]);
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Swap the single `.question` section matching `qid` inside a rendered batch
// with `newHtml`, leaving every sibling question (and the batch wrapper)
// untouched. No-op if the qid isn't present. A `.question` never nests another
// `<section>`, so the non-greedy match to the first `</section>` is safe.
export function replaceQuestionHtml(batchHtml, qid, newHtml) {
  const re = new RegExp('<section class="question" data-qid="' + escapeRegExp(esc(qid)) + '"[\\s\\S]*?</section>');
  return re.test(batchHtml) ? batchHtml.replace(re, newHtml) : batchHtml;
}

function renderLiveShell() {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>claude-detective — live</title>
<style>${STYLES}</style></head>
<body>
<div class="wrap">
  <div class="titlebar"><span class="dot r"></span><span class="dot y"></span><span class="dot g"></span><span class="tt">claude@detective: ./detective --live</span><button type="button" id="gear" title="settings" onclick="toggleSettings()">⚙</button></div>
  <div class="settings" id="settings" hidden>
    <label><input type="checkbox" id="cfg-requireHints"> require a hint on every question &amp; option</label>
    <label><input type="checkbox" id="cfg-forceVisual"> force a visual/diagram per question</label>
    <label><input type="checkbox" id="cfg-auditAsYouGo"> enable "audit this" (token-heavy — spawns subagents)</label>
    <div class="ctxrow"><label for="cfg-context">context (highest-priority guidance for claude)</label>
      <textarea id="cfg-context" rows="5" placeholder="e.g. always prefer the cheapest option…"></textarea></div>
    <div class="setbtns"><button type="button" onclick="saveSettings()">save settings</button><span id="setmsg"></span></div>
  </div>
  <div class="screen">
    <div id="feed"></div>
    <div class="statusline" id="status"><span class="dotp"></span><span id="stext">connecting…</span></div>
    <div class="endbar"><button type="button" onclick="decideRest()">decide the rest →</button><button type="button" onclick="endInterview()">end interview</button></div>
    ${NAV_HTML}
  </div>
</div>
<div id="toasts"></div>
<script>
const feed=document.getElementById('feed');
function showToast(msg,kind){
  const wrap=document.getElementById('toasts');if(!wrap)return;
  const el=document.createElement('div');el.className='toast'+(kind?' '+kind:'');el.textContent=msg;wrap.appendChild(el);
  requestAnimationFrame(function(){el.classList.add('show');});
  setTimeout(function(){el.classList.remove('show');setTimeout(function(){el.remove();},240);},3200);
}
const statusEl=document.getElementById('status'),stext=document.getElementById('stext');
function setStatus(k,t){statusEl.className='statusline'+(k?' '+k:'');stext.textContent=t;}
function collect(id){
  const el=feed.querySelector('.batch[data-batch="'+id+'"]');
  const ans={};
  const qids=new Set();
  el.querySelectorAll('input[data-qid]').forEach(i=>qids.add(i.dataset.qid));
  el.querySelectorAll('.rank[data-qid]').forEach(r=>qids.add(r.dataset.qid));
  qids.forEach(function(qid){
    const rank=el.querySelector('.rank[data-qid="'+qid+'"]');
    const sel=rank?[...rank.querySelectorAll('.rankrow')].map(r=>r.dataset.oid)
                  :[...el.querySelectorAll('input[data-qid="'+qid+'"]:checked')].map(i=>i.value);
    const own=el.querySelector('.ownwrap[data-qid="'+qid+'"]');
    const o=el.querySelector('[id="other__'+qid+'"]');
    const other=own?[].slice.call(own.querySelectorAll('.ownchip')).map(c=>c.textContent):(o?o.value:'');
    const q=el.querySelector('.question[data-qid="'+qid+'"]');
    ans[qid]={selected:sel,other:other,delegated:!!(q&&q.classList.contains('delegated'))};
  });
  return ans;
}
function batchOf(q){const b=q.closest('.batch');return b?Number(b.dataset.batch):null;}
function addActions(scope){
  if(!scope)return;
  scope.querySelectorAll('.question').forEach(function(q){
    if(q.querySelector('.qactions'))return;
    const bar=document.createElement('div');bar.className='qactions';
    [['decide','↳ you decide'],['rethink','↻ rethink'],['research','⌕ research'],['more','＋ more']].forEach(function(a){
      const b=document.createElement('button');b.type='button';b.textContent=a[1];b.onclick=function(){doAction(q,a[0]);};bar.appendChild(b);
    });
    q.appendChild(bar);
  });
}
function refreshSubmitLock(){
  feed.querySelectorAll('.batch').forEach(function(b){
    var working=b.querySelector('.question.working');
    var cont=b.querySelector('.cont button:not(.revise)');
    if(cont)cont.disabled=!!working;
    b.classList.toggle('locked-rework',!!working);
  });
}
function lockQuestion(q,on){
  q.classList.toggle('working',on);
  q.querySelectorAll('input,textarea').forEach(function(i){i.disabled=on;});
  var badge=q.querySelector('.qworking');
  if(on){
    if(!badge){badge=document.createElement('div');badge.className='qworking';badge.innerHTML='<span class="dotp"></span>claude is reworking this question…';
      var acts=q.querySelector('.qactions');if(acts)q.insertBefore(badge,acts);else q.appendChild(badge);}
  }else if(badge){badge.remove();}
  refreshSubmitLock();
}
function doAction(q,kind){
  if(!q)return;
  if(kind==='decide'){const rec=q.dataset.rec;if(rec){const inp=q.querySelector('input[value="'+rec+'"]');if(inp)inp.checked=true;}q.classList.add('delegated');showToast('delegated to claude ✓','good');return;}
  if(q.classList.contains('working'))return; // already being reworked
  const otherEl=q.querySelector('.other');
  const other=otherEl?otherEl.value.trim():'';
  let note='';
  if(kind==='rethink'){note=(prompt("What's off? What should I aim for instead?", other)||'').trim();}
  // Lock down just THIS question — the rest of the page keeps every answer.
  lockQuestion(q,true);
  const label={rethink:'rethinking this',research:'researching this',more:'finding more options'}[kind]||'reworking this';
  showToast('sent to claude — '+label,'');
  setStatus('think','claude is reworking a question…');
  post('/signal',{batch:batchOf(q),qid:q.dataset.qid,kind:kind,note:note,other:other});
}
window.qaction=function(kind,q){doAction(q||(document.querySelector('.kfocus')&&document.querySelector('.kfocus').closest('.question')),kind);};
function decideRest(){
  const open=[...feed.querySelectorAll('.batch:not(.spent)')];
  if(!open.length)return;
  const b=open[open.length-1];
  b.querySelectorAll('.question').forEach(function(q){
    if(q.querySelector('input:checked'))return;
    const rec=q.dataset.rec;if(rec){const inp=q.querySelector('input[value="'+rec+'"]');if(inp)inp.checked=true;}
    q.classList.add('delegated');
  });
  sendBatch(Number(b.dataset.batch));
}
${RANK_JS}
function lock(el,on){el.querySelectorAll('input,textarea').forEach(function(i){i.disabled=on;});}
function spend(el,label){
  el.classList.add('spent');lock(el,true);
  const id=el.dataset.batch;
  el.querySelector('.cont').innerHTML='<span class="sent">'+label+'</span> <button type="button" class="revise" onclick="revise('+id+')">✎ revise</button>';
}
async function post(url,payload){try{await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});}catch(e){}}
async function sendBatch(id){
  const el=feed.querySelector('.batch[data-batch="'+id+'"]');
  if(!el||el.classList.contains('spent'))return;
  const answers=collect(id);
  spend(el,'sent ✓');
  setStatus('think','claude is thinking…');
  await post('/answer',{batch:Number(id),answers:answers});
}
function revise(id){
  const el=feed.querySelector('.batch[data-batch="'+id+'"]');
  el.classList.remove('spent');lock(el,false);
  el.querySelector('.cont').innerHTML='<button type="button" onclick="resend('+id+')">update →</button>';
}
async function resend(id){
  if(!confirm('Update this answer? Any questions asked after it will be discarded and re-asked.'))return;
  const el=feed.querySelector('.batch[data-batch="'+id+'"]');
  const answers=collect(id);
  spend(el,'updated ✓');
  setStatus('think','claude is thinking…');
  await post('/answer',{batch:Number(id),answers:answers,revised:true});
}
async function endInterview(){setStatus('think','wrapping up…');await post('/end',{});}
// Settings panel: load config + context, toggle, save. Audit is token-heavy so
// enabling it asks for confirmation first.
function applyAuditClass(on){document.body.classList.toggle('audit-on',!!on);}
async function toggleSettings(){
  var el=document.getElementById('settings');
  if(!el.hidden){el.hidden=true;return;}
  try{
    var cfg=await (await fetch('/ctl/config')).json();
    document.getElementById('cfg-requireHints').checked=!!cfg.requireHints;
    document.getElementById('cfg-forceVisual').checked=!!cfg.forceVisual;
    document.getElementById('cfg-auditAsYouGo').checked=!!cfg.auditAsYouGo;
    var ctx=await (await fetch('/ctl/context')).json();
    document.getElementById('cfg-context').value=ctx.text||'';
  }catch(e){}
  el.hidden=false;
}
document.addEventListener('change',function(e){
  if(e.target&&e.target.id==='cfg-auditAsYouGo'&&e.target.checked){
    if(!confirm('Audits spawn Sonnet-5 subagents and are token-heavy. Enable?'))e.target.checked=false;
  }
});
async function saveSettings(){
  var patch={
    requireHints:document.getElementById('cfg-requireHints').checked,
    forceVisual:document.getElementById('cfg-forceVisual').checked,
    auditAsYouGo:document.getElementById('cfg-auditAsYouGo').checked,
  };
  try{
    await post('/config',patch);
    await post('/context',{text:document.getElementById('cfg-context').value});
    applyAuditClass(patch.auditAsYouGo);
    var m=document.getElementById('setmsg');if(m){m.textContent='saved ✓';setTimeout(function(){m.textContent='';},2000);}
  }catch(e){}
}
// Reflect current audit setting on load so the per-batch audit button shows/hides.
fetch('/ctl/config').then(function(r){return r.json();}).then(function(c){applyAuditClass(c&&c.auditAsYouGo);}).catch(function(){});
// "Updated Xs ago" badge on reworked/annotated questions, ticked once a second.
function nowMs(){return (window.performance&&performance.timeOrigin)?performance.timeOrigin+performance.now():+new Date();}
function stampUpdated(q){
  if(!q)return;q.dataset.updated=String(nowMs());
  var h=q.querySelector('h3');if(!h)return;
  var b=q.querySelector('.qago');if(!b){b=document.createElement('span');b.className='qago';h.appendChild(b);}
  paintAgo(q);
}
function paintAgo(q){
  var t=Number(q.dataset.updated);if(!t)return;
  var s=Math.max(0,Math.round((nowMs()-t)/1000));
  var txt=s<5?'updated just now':(s<60?('updated '+s+'s ago'):('updated '+Math.round(s/60)+'m ago'));
  var b=q.querySelector('.qago');if(b)b.textContent=txt;
}
setInterval(function(){feed.querySelectorAll('.question[data-updated]').forEach(paintAgo);},1000);
// Multi-select "add your own": Enter appends a chip (add-only, no dedupe).
feed.addEventListener('keydown',function(e){
  if(e.key!=='Enter'||!e.target||!e.target.classList.contains('ownadd'))return;
  e.preventDefault();
  var v=e.target.value.trim();if(!v)return;
  var wrap=e.target.closest('.ownwrap');if(!wrap)return;
  var chip=document.createElement('span');chip.className='ownchip';chip.textContent=v;
  wrap.querySelector('.ownchips').appendChild(chip);
  e.target.value='';
});
const es=new EventSource('/events');
es.onopen=function(){setStatus('','waiting for the first question…');};
function batchOtherText(el){
  var parts=[];
  el.querySelectorAll('.other').forEach(function(o){if(o.value.trim())parts.push(o.value.trim());});
  el.querySelectorAll('.ownchip').forEach(function(c){if(c.textContent.trim())parts.push(c.textContent.trim());});
  return parts.join(' | ');
}
function addAudit(b){
  if(!b||b.querySelector('.auditbtn'))return;
  var btn=document.createElement('button');btn.type='button';btn.className='auditbtn';btn.textContent='⚙ audit this';
  btn.onclick=function(){post('/signal',{batch:Number(b.dataset.batch),kind:'audit',other:batchOtherText(b)});showToast('audit requested — claude is reviewing','');setStatus('think','claude is auditing…');};
  b.appendChild(btn);
}
es.addEventListener('batch',function(e){const d=JSON.parse(e.data);if(feed.querySelector('.batch[data-batch="'+d.id+'"]'))return;feed.insertAdjacentHTML('beforeend',d.html);const nb=feed.querySelector('.batch[data-batch="'+d.id+'"]');initRank(feed);addActions(nb);addAudit(nb);setStatus('','your move');if(nb)nb.scrollIntoView({block:'start'});});
es.addEventListener('qupdate',function(e){
  const d=JSON.parse(e.data);
  const old=feed.querySelector('.question[data-qid="'+d.qid+'"]');
  if(!old)return; // nothing to replace (stale event)
  const batch=old.closest('.batch');
  old.insertAdjacentHTML('afterend',d.html);
  old.remove();
  const fresh=feed.querySelector('.question[data-qid="'+d.qid+'"]');
  if(batch){initRank(batch);addActions(batch);}
  if(fresh){fresh.classList.add('qflash');stampUpdated(fresh);}
  refreshSubmitLock();
  showToast('question updated ✓','good');
  setStatus('','your move');
});
es.addEventListener('annotate',function(e){
  const d=JSON.parse(e.data);
  const q=feed.querySelector('.question[data-qid="'+d.qid+'"]');if(!q)return;
  const b=document.createElement('div');b.className='qbadge '+(d.level==='serious'?'serious':'warn');
  const msg=document.createElement('span');msg.className='btext';msg.textContent='⚠ '+d.text;
  const dis=document.createElement('button');dis.type='button';dis.className='bdismiss';dis.textContent='dismiss';
  const ask=document.createElement('button');ask.type='button';ask.className='baskme';ask.textContent='ask me';
  dis.onclick=function(){b.remove();};
  ask.onclick=function(){post('/signal',{batch:batchOf(q),qid:d.qid,kind:'askme',note:d.text,other:''});b.remove();};
  b.appendChild(msg);b.appendChild(dis);b.appendChild(ask);
  q.appendChild(b);stampUpdated(q);showToast('audit note added','');
});
es.addEventListener('status',function(e){const d=JSON.parse(e.data);setStatus(d.kind||'',d.text||'');});
es.addEventListener('retract',function(e){const d=JSON.parse(e.data);feed.querySelectorAll('.batch').forEach(function(el){if(Number(el.dataset.batch)>d.from)el.remove();});setStatus('think','claude is thinking…');});
es.addEventListener('finish',function(e){es.close();const eb=document.querySelector('.endbar');if(eb)eb.remove();setStatus('done','interview complete — you can close this tab.');});
${NAV_JS}
</script>
</body></html>`;
}

// Test hook: expose the rendered live-shell HTML/JS string for assertions.
export const renderLiveShellForTest = () => renderLiveShell();

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
    let other;
    if (type === 'multi') {
      other = Array.isArray(a.other)
        ? a.other.filter((s) => typeof s === 'string' && s.trim() !== '')
        : (typeof a.other === 'string' && a.other.trim() !== '' ? [a.other.trim()] : []);
    } else {
      other = typeof a.other === 'string' ? a.other : (Array.isArray(a.other) ? a.other.join(', ') : '');
    }
    answers[id] = { selected, other };
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

const CONFIRM_HTML = `<!doctype html><meta charset="utf-8"><title>sent</title>
<body style="font:14px 'JetBrains Mono',ui-monospace,Menlo,Consolas,monospace;background:#0a0c12;color:#5b6577;text-align:center;padding-top:120px">
<div style="color:#7ee787;font-size:1.15rem;font-weight:700">✓ answers sent</div><p>you can close this tab and return to claude.</p></body>`;

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

function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 5_000_000) req.destroy(); });
    req.on('end', () => resolve(b));
  });
}

// Persistent live server. The browser subscribes via SSE and posts answers;
// Claude drives it out-of-band via the /ctl/* control endpoints (push a batch,
// long-poll wait for answers, finish). Resolves with the transcript on finish.
export function serveLive(opts = {}) {
  const maxTries = opts.maxTries || 20;
  let port = opts.port || 8788;
  let tries = 0;
  const state = { clients: [], batches: [], answers: {}, globalNote: '', pending: [], waiters: [], finished: false, config: loadConfig() };

  const sse = (res, event, data) => { try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch {} };
  const broadcast = (event, data) => { for (const c of state.clients) sse(c, event, data); };
  const settle = () => {
    while (state.waiters.length && state.pending.length) {
      const w = state.waiters.shift();
      clearTimeout(w.timer);
      const events = state.pending; state.pending = [];
      w.send({ events });
      break;
    }
  };

  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://x');
      const p = u.pathname;
      const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

      if (req.method === 'GET' && p === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(renderLiveShell()); return;
      }
      if (req.method === 'GET' && p === '/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        res.write(': ok\n\n');
        state.clients.push(res);
        for (const b of state.batches) sse(res, 'batch', { id: b.id, html: b.html }); // catch a late/reloaded tab up
        if (state.finished) sse(res, 'finish', {});
        else if (state.batches.length) sse(res, 'status', { kind: '', text: 'your move' });
        req.on('close', () => { const i = state.clients.indexOf(res); if (i >= 0) state.clients.splice(i, 1); });
        return;
      }
      if (req.method === 'POST' && p === '/answer') {
        readBody(req).then((body) => {
          let d = {}; try { d = JSON.parse(body || '{}'); } catch {}
          const answers = d.answers && typeof d.answers === 'object' ? d.answers : {};
          for (const k of Object.keys(answers)) {
            const a = answers[k] || {};
            state.answers[k] = {
              selected: Array.isArray(a.selected) ? a.selected.filter((s) => typeof s === 'string') : [],
              other: Array.isArray(a.other)
                ? a.other.filter((s) => typeof s === 'string')
                : (typeof a.other === 'string' ? a.other : ''),
              ...(a.delegated ? { delegated: true } : {}),
            };
          }
          state.pending.push({ type: 'answer', batch: d.batch, revised: !!d.revised, answers: state.answers });
          broadcast('status', { kind: 'think', text: 'claude is thinking…' });
          settle();
          json(200, { ok: true });
        });
        return;
      }
      if (req.method === 'POST' && p === '/end') {
        state.pending.push({ type: 'ended' }); settle(); json(200, { ok: true }); return;
      }
      if (req.method === 'POST' && p === '/signal') {
        readBody(req).then((body) => {
          let d = {}; try { d = JSON.parse(body || '{}'); } catch {}
          state.pending.push({ type: 'signal', batch: d.batch, qid: d.qid, kind: d.kind, note: typeof d.note === 'string' ? d.note : '', other: typeof d.other === 'string' ? d.other : '' });
          broadcast('status', { kind: 'think', text: 'claude is thinking…' });
          settle();
          json(200, { ok: true });
        });
        return;
      }
      if (req.method === 'POST' && p === '/ctl/push') {
        readBody(req).then((body) => {
          let doc;
          try { doc = normalizeQuestions(JSON.parse(body), state.config); } catch (e) { json(400, { error: String(e && e.message || e) }); return; }
          const id = state.batches.length;
          const html = renderBatchHtml(doc, id);
          const qids = [];
          for (const s of doc.sections) for (const q of s.questions) qids.push(q.id);
          state.batches.push({ id, html, qids });
          broadcast('batch', { id, html });
          broadcast('status', { kind: '', text: 'your move' });
          json(200, { id });
        });
        return;
      }
      if (req.method === 'POST' && p === '/ctl/update') {
        readBody(req).then((body) => {
          let d = {}; try { d = JSON.parse(body || '{}'); } catch {}
          const qid = typeof d.qid === 'string' && d.qid ? d.qid : null;
          const rawQ = d.question && typeof d.question === 'object' ? d.question : null;
          if (!qid || !rawQ) { json(400, { error: 'update needs { "qid": "...", "question": { ... } }' }); return; }
          const batch = state.batches.find((b) => (b.qids || []).includes(qid));
          if (!batch) { json(404, { error: `no live question with id "${qid}" (already retracted, or never pushed)` }); return; }
          let html;
          try { html = renderQuestionHtml(rawQ, qid); } catch (e) { json(400, { error: String(e && e.message || e) }); return; }
          // Keep the stored batch HTML in sync so a reloaded/late tab shows the update too.
          batch.html = replaceQuestionHtml(batch.html, qid, html);
          // Options may have changed ids — drop the stale answer so the user re-picks.
          delete state.answers[qid];
          broadcast('qupdate', { qid, html });
          broadcast('status', { kind: '', text: 'your move' });
          json(200, { ok: true, qid });
        });
        return;
      }
      if (req.method === 'POST' && p === '/ctl/annotate') {
        readBody(req).then((body) => {
          let d = {}; try { d = JSON.parse(body || '{}'); } catch {}
          if (!d.qid || typeof d.text !== 'string') { json(400, { error: 'annotate needs { qid, text, level? }' }); return; }
          // Non-destructive: a badge on the question, NOT a replace — keeps the answer.
          broadcast('annotate', { qid: d.qid, level: d.level === 'serious' ? 'serious' : 'warn', text: d.text });
          json(200, { ok: true });
        });
        return;
      }
      if (req.method === 'POST' && p === '/ctl/retract') {
        readBody(req).then((body) => {
          let d = {}; try { d = JSON.parse(body || '{}'); } catch {}
          const from = Number.isFinite(d.from) ? d.from : -1;
          const dropped = state.batches.filter((b) => b.id > from);
          for (const b of dropped) for (const qid of b.qids || []) delete state.answers[qid];
          state.batches = state.batches.filter((b) => b.id <= from);
          broadcast('retract', { from });
          json(200, { retracted: dropped.length });
        });
        return;
      }
      if (req.method === 'GET' && p === '/ctl/wait') {
        if (state.pending.length) { const events = state.pending; state.pending = []; json(200, { events }); return; }
        const timeoutMs = Math.max(1, Number(u.searchParams.get('timeout') || 1800)) * 1000;
        const w = { send: (v) => json(200, v), timer: null };
        w.timer = setTimeout(() => {
          const i = state.waiters.indexOf(w); if (i >= 0) state.waiters.splice(i, 1);
          json(200, { events: [], timedOut: true });
        }, timeoutMs);
        state.waiters.push(w);
        req.on('close', () => { clearTimeout(w.timer); const i = state.waiters.indexOf(w); if (i >= 0) state.waiters.splice(i, 1); });
        return;
      }
      if (req.method === 'GET' && p === '/ctl/state') {
        json(200, { answers: state.answers, globalNote: state.globalNote, batches: state.batches.length, finished: state.finished, config: state.config }); return;
      }
      if (req.method === 'POST' && p === '/config') {
        readBody(req).then((body) => {
          let d = {}; try { d = JSON.parse(body || '{}'); } catch {}
          state.config = saveConfig(d);
          broadcast('status', { kind: '', text: 'settings saved' });
          json(200, state.config);
        });
        return;
      }
      if (req.method === 'GET' && p === '/ctl/config') { json(200, state.config); return; }
      if (req.method === 'GET' && p === '/ctl/context') { json(200, { text: loadContext() }); return; }
      if (req.method === 'POST' && p === '/context') {
        readBody(req).then((body) => {
          let d = {}; try { d = JSON.parse(body || '{}'); } catch {}
          saveContext(d.text);
          json(200, { ok: true });
        });
        return;
      }
      if (req.method === 'POST' && p === '/ctl/finish') {
        readBody(req).then((body) => {
          let d = {}; try { d = JSON.parse(body || '{}'); } catch {}
          if (typeof d.globalNote === 'string') state.globalNote = d.globalNote;
          state.finished = true;
          broadcast('finish', {});
          const transcript = { answers: state.answers, globalNote: state.globalNote, submittedAt: new Date().toISOString() };
          json(200, transcript);
          setTimeout(() => { try { server.close(); } catch {} resolve(transcript); }, 400);
        });
        return;
      }
      res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found');
    });
    server.on('error', (e) => {
      if (e.code === 'EADDRINUSE' && tries < maxTries) { tries++; port++; server.listen(port, '127.0.0.1'); }
      else reject(e);
    });
    server.on('listening', () => { if (opts.onListen) opts.onListen(`http://127.0.0.1:${port}/`, port); });
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

const argFlag = (args, name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : null; };
export const PKG_NAME = 'claude-detective';
const SESSION_DEFAULT = `${tmpdir()}/claude-detective-live.json`;

// Global config + context live under the skills dir (no per-project config).
const CONFIG_DEFAULTS = { requireHints: true, forceVisual: false, auditAsYouGo: false };
export function configPath() {
  const base = process.env.CLAUDE_SKILLS_DIR || `${process.env.HOME}/.claude/skills`;
  return `${base}/claude-detective/config.json`;
}
export function loadConfig() {
  try { return { ...CONFIG_DEFAULTS, ...JSON.parse(readFileSync(configPath(), 'utf8')) }; }
  catch { return { ...CONFIG_DEFAULTS }; }
}
export function saveConfig(patch) {
  const next = { ...loadConfig(), ...(patch && typeof patch === 'object' ? patch : {}) };
  try { mkdirSync(configPath().replace(/\/[^/]+$/, ''), { recursive: true }); } catch {}
  writeFileSync(configPath(), JSON.stringify(next, null, 2));
  return next;
}
export function contextPath() { return configPath().replace(/config\.json$/, 'context.md'); }
export function loadContext() { try { return readFileSync(contextPath(), 'utf8'); } catch { return ''; } }
export function saveContext(text) {
  try { mkdirSync(contextPath().replace(/\/[^/]+$/, ''), { recursive: true }); } catch {}
  writeFileSync(contextPath(), typeof text === 'string' ? text : '');
  return loadContext();
}

// Is the session file pointing at a server that's actually up? Used to hard-block
// a second interview (which would clobber the single session file).
export async function isSessionLive(sessionPath) {
  let s;
  try { s = JSON.parse(readFileSync(sessionPath, 'utf8')); } catch { return { live: false }; }
  if (!s || !s.pid || !s.url) return { live: false };
  try { process.kill(s.pid, 0); } catch { return { live: false }; } // stale pid
  try {
    const r = await fetch(`${s.url.replace(/\/$/, '')}/ctl/state`, { signal: AbortSignal.timeout(400) });
    if (r.ok) return { live: true, url: s.url, port: s.port, pid: s.pid };
  } catch {}
  return { live: false };
}

const USAGE = `usage:
  detective.mjs <questions.json> [--out <results.json>]   ask a batch (live UI, blocks until submit; --force to replace a live one)
  detective.mjs --demo                                    open a built-in sample interview
  detective.mjs <questions.json> --once                   standalone: self-finish on submit (no agent driving)
  detective.mjs --static <questions.json>                 legacy static one-page form (fallback)
  detective.mjs --live [--port N] [--out <file>]          start a persistent live server (adaptive)
  detective.mjs push <batch.json> [--port N]              push a question batch into the live server
  detective.mjs update <update.json> [--port N]           replace ONE question in place ({qid, question})
  detective.mjs wait [--timeout SEC] [--port N]           block until the user answers a batch
  detective.mjs retract --from <batchId> [--port N]       drop batches after a revised answer
  detective.mjs finish [--out <file>] [--port N]          end the interview, print the transcript
  detective.mjs state [--port N]                          dump the live session state`;

async function ctlBase(args) {
  const port = argFlag(args, 'port');
  if (port) return `http://127.0.0.1:${port}`;
  const sp = argFlag(args, 'session') || SESSION_DEFAULT;
  const s = JSON.parse(readFileSync(sp, 'utf8'));
  return `http://127.0.0.1:${s.port}`;
}

async function runControl(cmd, args) {
  let base;
  try { base = await ctlBase(args); }
  catch { console.error('error: no live server found (start one with --live, or pass --port)'); process.exit(1); }
  const positional = args.filter((a) => !a.startsWith('--'));
  if (cmd === 'push') {
    const file = positional[1];
    if (!file) { console.error('usage: detective.mjs push <batch.json>'); process.exit(2); }
    const r = await fetch(`${base}/ctl/push`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: readFileSync(file, 'utf8') });
    process.stdout.write((await r.text()) + '\n'); process.exit(r.ok ? 0 : 1);
  } else if (cmd === 'update') {
    const file = positional[1];
    if (!file) { console.error('usage: detective.mjs update <update.json>   (file: {"qid":"...","question":{...}})'); process.exit(2); }
    const r = await fetch(`${base}/ctl/update`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: readFileSync(file, 'utf8') });
    process.stdout.write((await r.text()) + '\n'); process.exit(r.ok ? 0 : 1);
  } else if (cmd === 'wait') {
    const t = argFlag(args, 'timeout') || '1800';
    const r = await fetch(`${base}/ctl/wait?timeout=${encodeURIComponent(t)}`);
    process.stdout.write((await r.text()) + '\n'); process.exit(0);
  } else if (cmd === 'retract') {
    const from = argFlag(args, 'from');
    if (from == null) { console.error('usage: detective.mjs retract --from <batchId>'); process.exit(2); }
    const r = await fetch(`${base}/ctl/retract`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from: Number(from) }) });
    process.stdout.write((await r.text()) + '\n'); process.exit(r.ok ? 0 : 1);
  } else if (cmd === 'state') {
    const r = await fetch(`${base}/ctl/state`);
    process.stdout.write((await r.text()) + '\n'); process.exit(0);
  } else if (cmd === 'finish') {
    const out = argFlag(args, 'out');
    const r = await fetch(`${base}/ctl/finish`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const txt = await r.text();
    if (out) writeFileSync(out, txt);
    process.stdout.write(txt + '\n'); process.exit(0);
  }
}

async function runLiveServer(args) {
  const sp = argFlag(args, 'session') || SESSION_DEFAULT;
  const transcript = await serveLive({
    port: Number(argFlag(args, 'port') || 8788),
    onListen: (url, actualPort) => {
      try { writeFileSync(sp, JSON.stringify({ port: actualPort, url, pid: process.pid })); } catch {}
      console.error(`\nclaude-detective live → ${url}`);
      console.error('drive it:  push <batch.json>  ·  wait  ·  finish\n');
      openBrowser(url);
    },
  });
  const out = argFlag(args, 'out');
  if (out) writeFileSync(out, JSON.stringify(transcript, null, 2));
  process.stdout.write(JSON.stringify(transcript, null, 2) + '\n');
  process.exit(0);
}

// The default path: a persistent live interview seeded with the first batch.
// Starts the live server in-process, writes the session file (so the `wait` /
// `update` / `push` / `finish` control commands can find it), pushes the batch,
// then BLOCKS until `finish`. Per-question pushback actions (rethink/research/
// more) no longer tear the page down — the server stays up so the caller can
// rework a single question in place with `update` and keep the user's progress.
// Run this in the background and drive it with the control sub-commands.
async function runInterview(rawJson, args) {
  const sp = argFlag(args, 'session') || SESSION_DEFAULT;
  const outPath = argFlag(args, 'out');
  // Hard-block a second interview on the default session — it would clobber the
  // session file and orphan the first server. --force / --port / --session opt out.
  if (!args.includes('--force') && !argFlag(args, 'port') && !argFlag(args, 'session')) {
    const cur = await isSessionLive(sp);
    if (cur.live) {
      console.error(`error: an interview is already live at ${cur.url} — finish it, or pass --force`);
      process.exit(1);
    }
  }
  let base = null;
  const done = serveLive({
    port: Number(argFlag(args, 'port') || 8788),
    onListen: (url, port) => {
      base = `http://127.0.0.1:${port}`;
      try { writeFileSync(sp, JSON.stringify({ port, url, pid: process.pid })); } catch {}
      console.error(`\nclaude-detective ready → ${url}`);
      console.error('drive it:  wait  ·  update <file>  ·  push <file>  ·  finish\n');
      openBrowser(url);
    },
  });
  done.catch(() => {});
  while (!base) await new Promise((r) => setTimeout(r, 20));

  const push = await fetch(`${base}/ctl/push`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: rawJson });
  if (!push.ok) {
    let msg = 'invalid questions';
    try { msg = (await push.json()).error || msg; } catch {}
    await fetch(`${base}/ctl/finish`, { method: 'POST', body: '{}' }).catch(() => {});
    console.error(`error: ${msg}`);
    process.exit(1);
  }

  // Standalone/showcase (`--demo`/`--once`): no agent is driving the session, so
  // self-finish on the first terminal action — otherwise the process would block
  // forever waiting for a `finish` that never comes. (Live pushback actions can't
  // be reworked without a driver, so they just come back as a pending signal.)
  if (args.includes('--once') || args.includes('--demo')) {
    const wait = await (await fetch(`${base}/ctl/wait?timeout=${argFlag(args, 'timeout') || 1800}`)).json();
    const signal = (wait.events || []).find((e) => e.type === 'signal');
    let output;
    if (signal) {
      output = { pending: signal };
      await fetch(`${base}/ctl/finish`, { method: 'POST', body: '{}' }).catch(() => {});
    } else {
      output = await (await fetch(`${base}/ctl/finish`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
    }
    await done.catch(() => {});
    if (outPath) writeFileSync(outPath, JSON.stringify(output, null, 2));
    process.stdout.write(JSON.stringify(output, null, 2) + '\n');
    process.exit(0);
  }

  // Default (agent-driven): stay alive until the caller runs `finish`.
  const transcript = await done;
  if (outPath) writeFileSync(outPath, JSON.stringify(transcript, null, 2));
  process.stdout.write(JSON.stringify(transcript, null, 2) + '\n');
  process.exit(0);
}

async function runDefault(args) {
  let raw;
  if (args.includes('--demo')) {
    raw = JSON.stringify(DEMO_QUESTIONS);
  } else {
    const path = args.find((a) => !a.startsWith('--'));
    if (!path) { console.error(USAGE); process.exit(2); }
    try { raw = readFileSync(path, 'utf8'); }
    catch (e) { console.error(`error: cannot read ${path}: ${e.message}`); process.exit(1); }
  }
  return runInterview(raw, args);
}

// A self-contained sample interview so `--demo` (and the npx one-liner) works
// with zero setup. Modeled on a real Claude Code moment — implementing a
// feature into an existing codebase — so it shows what the tool is for.
export const DEMO_QUESTIONS = {
  title: 'implement: file uploads',
  findings: {
    summary: "Scanned the codebase before asking: a TypeScript API with Postgres, no object storage wired up yet.\nBest practice for user uploads is to presign direct-to-storage so large files never touch your app server, plus a size/type allowlist and a scan step for user-supplied content. Recs below favor a secure, ship-able v1.",
    sources: [
      { label: 'src/api/routes.ts — existing endpoints', ref: 'src/api/routes.ts:1' },
      { label: 'OWASP file-upload cheat sheet', ref: 'https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html' },
      { label: 'S3 presigned uploads', ref: 'https://docs.aws.amazon.com/AmazonS3/latest/userguide/PresignedUrlUploadObject.html' },
    ],
  },
  sections: [
    { title: 'storage & transport', questions: [
      { id: 'store', text: 'Where should uploaded files live?',
        why: 'Determines cost, egress, and how much infra you take on.',
        type: 'single',
        recommendation: { optionId: 'r2', why: 'S3-compatible with no egress fees — cheap for user files' },
        options: [
          { id: 'r2', label: 'Cloudflare R2', pro: 'no egress fees, S3-compatible', con: 'newer tooling' },
          { id: 's3', label: 'AWS S3', pro: 'ubiquitous, mature ecosystem', con: 'egress costs add up' },
          { id: 'disk', label: 'Local disk / volume', pro: 'simplest to start', con: "doesn't scale; lost on redeploy" },
        ], allowOther: true },
      { id: 'method', text: 'How do uploads reach storage?',
        why: 'The single biggest architecture call here.',
        type: 'single',
        recommendation: { optionId: 'presign', why: 'keeps large files off your server — cheaper and scalable' },
        options: [
          { id: 'presign', label: 'Presigned direct-to-storage', pro: 'files skip your server; scales', con: 'more moving parts' },
          { id: 'stream', label: 'Stream through the API server', pro: 'simplest to reason about', con: 'server bandwidth + memory pressure' },
        ] },
    ] },
    { title: 'handling & safety', questions: [
      { id: 'images', text: 'How should images be processed?', type: 'single',
        why: 'Image handling drives payload size, read latency, and how much pipeline you maintain.',
        recommendation: { optionId: 'ondemand', why: 'store one original, transform via CDN on request' },
        options: [
          { id: 'ondemand', label: 'Transform on-demand (CDN/worker)', pro: 'store one original', con: 'first-hit latency' },
          { id: 'onupload', label: 'Resize on upload', pro: 'fast reads', con: 'reprocess to add sizes' },
          { id: 'asis', label: 'Store as-is', pro: 'no pipeline', con: 'heavy payloads to clients' },
        ] },
      { id: 'limits', text: 'Enforce a max size + type allowlist?', type: 'yesno',
        why: 'Without a ceiling, one request can exhaust disk, memory, or your bill.',
        recommendation: { optionId: 'yes', why: 'first line of defense against abuse' } },
      { id: 'scan', text: 'Scan uploads for malware?', type: 'yesno',
        why: "Uploads are attacker-controlled bytes you'll serve back to other users.",
        recommendation: { optionId: 'yes', why: "it's user-supplied content served to others" } },
    ] },
    { title: 'scope & rollout', questions: [
      { id: 'extras', text: 'Include which of these in v1? (pick any)', type: 'multi',
        why: 'Each is nice-to-have but adds surface area — pick what earns its keep in v1.',
        options: [
          { id: 'progress', label: 'Upload progress UI', pro: 'clear feedback on big files', con: 'needs upload events wired up' },
          { id: 'dragdrop', label: 'Drag-and-drop', pro: 'expected UX affordance', con: 'extra client handling + a11y care' },
          { id: 'resumable', label: 'Resumable / chunked uploads', pro: 'survives flaky networks', con: 'chunk tracking + reassembly' },
          { id: 'signed', label: 'Signed (expiring) download URLs', pro: 'private files stay private', con: 'expiry + re-issue flow' },
          { id: 'thumbs', label: 'Thumbnails', pro: 'fast grids and previews', con: 'a generation + storage step' },
          { id: 'cleanup', label: 'Orphan-file cleanup job', pro: 'reclaims abandoned bytes', con: 'a scheduled job to own' },
        ] },
      { id: 'priorities', text: 'Rank the implementation steps by priority (drag)', type: 'rank', priority: true,
        why: 'Order the build so each step unblocks the next and value ships early.',
        options: [
          { id: 'presign', label: 'Presign endpoint', pro: 'unblocks everything else' },
          { id: 'widget', label: 'Client upload widget', pro: 'the surface users actually touch' },
          { id: 'validate', label: 'Validation + size/type limits', pro: 'gate before you trust bytes' },
          { id: 'records', label: 'DB records + metadata', pro: 'ties files to their owners' },
          { id: 'downloads', label: 'Signed download URLs', pro: 'needed once files are private' },
          { id: 'gc', label: 'Cleanup / garbage collection', pro: 'safe to defer until volume grows' },
        ] },
    ] },
  ],
};

async function runOneShot(args) {
  const outPath = argFlag(args, 'out');
  let questions;
  if (args.includes('--demo')) {
    questions = normalizeQuestions(DEMO_QUESTIONS);
  } else {
    const path = args.find((a) => !a.startsWith('--'));
    if (!path) { console.error(USAGE); process.exit(2); }
    try { questions = loadQuestions(path); }
    catch (e) { console.error(`error: ${e.message}`); process.exit(1); }
  }
  const results = await serve(questions, {
    onListen: (url) => {
      console.error(`\nclaude-detective ready → ${url}`);
      console.error('Waiting for you to submit your answers…\n');
      openBrowser(url);
    },
  });
  if (outPath) writeFileSync(outPath, JSON.stringify(results, null, 2));
  process.stdout.write(JSON.stringify(results, null, 2) + '\n');
  process.exit(0);
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args.filter((a) => !a.startsWith('--'))[0];
  if (args.includes('--live')) return runLiveServer(args);
  if (['push', 'update', 'wait', 'retract', 'finish', 'state'].includes(cmd)) return runControl(cmd, args);
  if (args.includes('--static')) return runOneShot(args); // hidden fallback: legacy static one-page form
  return runDefault(args); // default: unified live interview (one blocking command)
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
