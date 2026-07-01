#!/usr/bin/env node
import { readFileSync, writeFileSync, realpathSync } from 'node:fs';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';

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
      const isRank = q.type === 'rank';
      const rawOptions = Array.isArray(q.options) && q.options.length ? q.options : null;
      const options = isYesNo && !rawOptions
        ? [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }]
        : rawOptions.map((o) => ({ id: o.id, label: o.label, pro: o.pro, con: o.con }));
      return {
        id: q.id,
        text: q.text,
        why: typeof q.why === 'string' ? q.why : undefined,
        // `type` drives result semantics; `render` drives the layout.
        // yesno → single-select semantics; rank → its own ordered semantics.
        type: isRank ? 'rank' : q.type === 'multi' ? 'multi' : 'single',
        render: isYesNo ? 'pills' : isRank ? 'rank' : 'list',
        recommendation: q.recommendation && typeof q.recommendation === 'object'
          ? { optionId: q.recommendation.optionId, why: q.recommendation.why }
          : undefined,
        options,
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

function renderRankItems(q) {
  return `<ol class="rank" data-qid="${esc(q.id)}">${q.options.map((o) =>
    `<li class="rankrow" draggable="true" data-oid="${esc(o.id)}"><span class="grip">⠿</span><span class="rlabel">${esc(o.label)}</span>${o.pro ? `<span class="rpro">${fmt(o.pro)}</span>` : ''}</li>`,
  ).join('')}</ol>`;
}

function renderQuestion(q) {
  const why = q.why ? `<p class="why"><span class="why-tag">The problem</span> ${esc(q.why)}</p>` : '';
  const rec = q.recommendation && q.recommendation.why
    ? `<div class="rec"><strong>recommendation:</strong> ${fmt(q.recommendation.why)}</div>` : '';
  const other = q.allowOther
    ? `<input type="text" class="other" id="other__${esc(q.id)}" placeholder="Other / add nuance…">` : '';
  // A long list of short, pro/con-free options flows into two columns.
  const shortEnough = q.options.every((o) => !o.pro && !o.con && String(o.label).length <= 28);
  const twoCol = q.render === 'list' && q.options.length >= 6 && shortEnough;
  const controls = q.render === 'pills'
    ? `<div class="pills">${q.options.map((o) => renderPill(q, o)).join('')}</div>`
    : q.render === 'rank'
      ? renderRankItems(q)
      : `<div class="options${twoCol ? ' two-col' : ''}">${q.options.map((o) => renderOption(q, o)).join('')}</div>`;
  const recAttr = q.recommendation && q.recommendation.optionId ? ` data-rec="${esc(q.recommendation.optionId)}"` : '';
  return `
    <section class="question" data-qid="${esc(q.id)}"${recAttr}>
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

const STYLES = `
:root{color-scheme:dark}
*{box-sizing:border-box}
::selection{background:#2d4b6e;color:#fff}
body{margin:0;background:#05070b;color:#a7b0c0;font:13.5px/1.55 "JetBrains Mono","Fira Code","SFMono-Regular",ui-monospace,Menlo,Consolas,monospace;-webkit-font-smoothing:antialiased;padding:26px 16px 40px}
::-webkit-scrollbar{width:11px;height:11px}
::-webkit-scrollbar-thumb{background:#1b2130;border-radius:6px}
::-webkit-scrollbar-thumb:hover{background:#273044}

/* terminal window */
.wrap{max-width:780px;margin:0 auto;background:#0b0e14;border:1px solid #1e2636;border-radius:11px;box-shadow:0 26px 70px rgba(0,0,0,.6),0 0 44px rgba(126,231,135,.035);overflow:hidden}
.titlebar{display:flex;align-items:center;gap:8px;padding:11px 14px;background:#0d1219;border-bottom:1px solid #1a2230}
.titlebar .dot{width:11px;height:11px;border-radius:50%}
.dot.r{background:#ff5f56}.dot.y{background:#ffbd2e}.dot.g{background:#27c93f}
.titlebar .tt{margin-left:8px;color:#5b6577;font-size:.78rem}
.screen{padding:20px 20px 20px}

.prompt{color:#5b6577;font-size:.82rem;padding:0;margin:0}
.prompt .sym{color:#6cb6ff}
.cursor{display:inline-block;width:7px;height:14px;background:#7ee787;margin-left:5px;vertical-align:-2px;animation:blink 1.1s steps(1) infinite}
@keyframes blink{50%{opacity:0}}
h1{font-size:1rem;color:#e9edf4;margin:22px 0 6px;font-weight:700;line-height:1.4}
h1::before{content:"» ";color:#7ee787}

/* section = TUI panel with a legend on its top border */
.section{position:relative;border:1px solid #26324a;border-radius:5px;padding:16px 14px 14px;margin:20px 0 0}
.section-title{position:absolute;top:-8px;left:12px;margin:0;padding:0 7px;background:#0b0e14;color:#7ee787;font-size:.74rem;letter-spacing:.14em;text-transform:lowercase;font-weight:700;border:0}

/* research briefing panel (blue, to distinguish from question panels) */
.findings{position:relative;border:1px solid #24344e;border-radius:5px;padding:16px 14px 12px;margin:16px 0 0;background:rgba(108,182,255,.03)}
.findings h3{position:absolute;top:-8px;left:12px;margin:0;padding:0 7px;background:#0b0e14;color:#6cb6ff;font-size:.74rem;letter-spacing:.14em;text-transform:lowercase;font-weight:700}
.findings-body{color:#9aa4b5;font-size:.84rem;white-space:pre-wrap}
.findings .sources{margin:9px 0 0;padding:0;list-style:none}
.findings .sources li{color:#5b6577;font-size:.79rem;margin:2px 0}
.findings .sources li::before{content:"- ";color:#6cb6ff}
a{color:#6cb6ff;text-decoration:none;border-bottom:1px dotted #395574}
a:hover{color:#9ecbff;border-bottom-color:#6cb6ff}
.ref{color:#e2b86b}

.question{position:relative;border:0;border-radius:0;margin:0;padding:0}
.question + .question{margin-top:13px;padding-top:13px;border-top:1px dashed #1c2434}
.question h3{margin:0 0 3px;font-size:.92rem;color:#e9edf4;font-weight:600}
.question h3::before{content:"? ";color:#7ee787;font-weight:700}
.why{margin:1px 0 6px;padding-left:15px;color:#5b6577;font-size:.82rem}
.why-tag{color:#e2b86b;font-weight:700;text-transform:lowercase}
.why-tag::after{content:":"}
.rec{background:transparent;border:0;border-radius:0;padding:0 0 0 15px;margin:2px 0 8px;color:#8fd694;font-size:.82rem}
.rec::before{content:"» rec: ";color:#7ee787;font-weight:700}
.rec strong{display:none}

.options{display:flex;flex-direction:column;gap:2px;padding-left:15px}
.options.two-col{display:grid;grid-template-columns:1fr 1fr;gap:2px 18px}
@media(max-width:480px){.options.two-col{grid-template-columns:1fr}}
.option{position:relative;display:flex;gap:8px;align-items:flex-start;background:transparent;border:0;border-radius:3px;padding:2px 6px 2px 30px;cursor:pointer;color:#a7b0c0}
.option input{position:absolute;opacity:0;pointer-events:none}
.option::before{position:absolute;left:4px;top:2px;color:#4b566b}
.option:has(input[type=radio])::before{content:"( )"}
.option:has(input[type=radio]:checked)::before{content:"(◉)";color:#7ee787}
.option:has(input[type=checkbox])::before{content:"[ ]"}
.option:has(input[type=checkbox]:checked)::before{content:"[×]";color:#7ee787}
.option:hover{background:#121826;color:#e9edf4}
.option:hover::before{color:#6cb6ff}
.option:has(input:checked){color:#e9edf4}
.option-label{font-weight:600;color:inherit}
.rec-star{color:#7ee787;font-weight:700;font-size:.72rem;margin-left:6px}
.pro,.con{padding-left:30px;font-size:.77rem;margin-top:1px}
.pro{color:#8fd694}.pro::before{content:"+ ";font-weight:700}
.con{color:#e58f8f}.con::before{content:"- ";font-weight:700}

/* drag-to-rank */
.rank{list-style:none;counter-reset:rk;margin:2px 0 0;padding-left:15px;display:flex;flex-direction:column;gap:3px}
.rankrow{counter-increment:rk;display:flex;align-items:center;gap:8px;background:#080b11;border:1px solid #222a3a;border-radius:5px;padding:5px 10px;cursor:grab}
.rankrow::before{content:counter(rk)".";color:#6cb6ff;font-weight:700;min-width:16px}
.rankrow.drag{opacity:.4;border-color:#6cb6ff}
.rankrow.over{border-color:#7ee787}
.rankrow .grip{color:#4b566b;cursor:grab}
.rankrow .rlabel{font-weight:600;color:#e9edf4}
.rankrow .rpro{color:#8fd694;font-size:.74rem;margin-left:auto}
.rankrow.grabbed{border-color:#e2b86b;background:#161207}

.pills{display:flex;gap:8px;flex-wrap:wrap;padding-left:15px;margin-top:2px}
.pill{position:relative;display:inline-flex;align-items:center;background:transparent;border:1px solid #2a3346;border-radius:4px;padding:2px 11px;cursor:pointer;font-weight:600;color:#7d8799}
.pill::before{content:"[ "}.pill::after{content:" ]"}
.pill:hover{border-color:#3a4a63;color:#e9edf4}
.pill:has(input:checked){border-color:#7ee787;color:#7ee787;background:rgba(126,231,135,.07)}
.pill:has(input:checked)::before{content:"‹ ";color:#7ee787}
.pill:has(input:checked)::after{content:" ›";color:#7ee787}
.pill input{position:absolute;opacity:0;pointer-events:none}

.other{width:calc(100% - 15px);margin:6px 0 0 15px;background:#080b11;border:1px solid #222a3a;color:#a7b0c0;border-radius:4px;padding:5px 9px;font:inherit;font-size:.82rem}
.other::placeholder,textarea#__global::placeholder{color:#4b566b}
.other:focus,textarea#__global:focus{outline:0;border-color:#6cb6ff;box-shadow:0 0 0 1px rgba(108,182,255,.35)}

/* global note = its own panel */
.global{position:relative;border:1px solid #26324a;border-radius:5px;padding:15px 14px 13px;margin:18px 0 0}
.global h3{position:absolute;top:-8px;left:12px;margin:0;padding:0 7px;background:#0b0e14;color:#7ee787;font-size:.74rem;letter-spacing:.14em;text-transform:lowercase;font-weight:700}
textarea#__global{width:100%;background:#080b11;border:1px solid #222a3a;color:#a7b0c0;border-radius:4px;padding:8px 10px;font:inherit;font-size:.82rem;min-height:52px;resize:vertical}

.bar{display:flex;justify-content:flex-end;padding:16px 0 2px;background:transparent;border:0}
.bar button{font:inherit;background:transparent;color:#7ee787;border:1px solid #2c8f45;border-radius:5px;padding:5px 16px;font-size:.85rem;font-weight:700;letter-spacing:.03em;cursor:pointer}
.bar button::before{content:"⏎ "}
.bar button:hover{background:#123020;border-color:#3fb950}
.done{max-width:560px;margin:110px auto;text-align:center}
.done .ok{color:#7ee787;font-size:1.15rem;font-weight:700}
.done p{color:#5b6577}

/* live mode */
.statusline{display:flex;align-items:center;gap:8px;color:#5b6577;font-size:.8rem;margin:18px 0 2px}
.statusline .dotp{width:8px;height:8px;border-radius:50%;background:#6cb6ff;box-shadow:0 0 8px #6cb6ff}
.statusline.think .dotp{background:#e2b86b;box-shadow:0 0 8px #e2b86b;animation:pulse 1s ease-in-out infinite}
.statusline.done .dotp{background:#7ee787;box-shadow:0 0 8px #7ee787}
@keyframes pulse{50%{opacity:.3}}
.batch{animation:reveal .28s ease-out}
@keyframes reveal{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
.batch.spent{opacity:.6}
.cont{display:flex;justify-content:flex-end;margin-top:10px}
.cont button{font:inherit;background:transparent;color:#7ee787;border:1px solid #2c8f45;border-radius:5px;padding:4px 14px;font-size:.82rem;font-weight:700;cursor:pointer}
.cont button:hover{background:#123020;border-color:#3fb950}
.cont button:disabled{color:#3a4a63;border-color:#222a3a;cursor:default;background:transparent}
.cont .sent{color:#7ee787;font-weight:700;font-size:.8rem;margin-right:8px}
.cont .revise{font:inherit;background:transparent;color:#7d8799;border:1px solid #2a3346;border-radius:5px;padding:3px 10px;font-size:.78rem;cursor:pointer}
.cont .revise:hover{border-color:#6cb6ff;color:#6cb6ff}
.batch.spent .option,.batch.spent .pill{cursor:default}
.endbar{display:flex;justify-content:flex-end;margin-top:16px}
.endbar button{font:inherit;background:transparent;color:#7d8799;border:1px solid #2a3346;border-radius:5px;padding:4px 12px;font-size:.78rem;cursor:pointer}
.endbar button:hover{border-color:#e58f8f;color:#e58f8f}

/* keyboard-first navigation */
.kfocus{outline:1.5px solid #6cb6ff;outline-offset:2px;border-radius:4px}
.rankrow.kfocus{outline-offset:0}
.kbhint{color:#3d4757;font-size:.73rem;margin-top:14px}
.kbhint b{color:#6cb6ff;font-weight:700}
#kbhelp{display:none;position:fixed;left:50%;bottom:18px;transform:translateX(-50%);max-width:560px;background:#0d1219;border:1px solid #26324a;border-radius:9px;padding:12px 16px;font-size:.8rem;line-height:1.7;color:#a7b0c0;box-shadow:0 14px 44px rgba(0,0,0,.6);z-index:20}
#kbhelp .kh{color:#7ee787;font-weight:700;margin-bottom:4px}
#kbhelp b{color:#7ee787}

/* response-action bar (live mode) */
.qactions{display:flex;gap:6px;flex-wrap:wrap;margin-top:9px;padding-left:15px}
.qactions button{font:inherit;background:transparent;color:#7d8799;border:1px solid #222a3a;border-radius:5px;padding:2px 9px;font-size:.74rem;cursor:pointer}
.qactions button:hover{border-color:#6cb6ff;color:#6cb6ff}
.question.delegated>h3::after{content:" · delegated to claude ✓";color:#8fd694;font-weight:600;font-size:.72rem}
.question.awaiting{opacity:.55}
`;

// Shared client script: drag-to-reorder for every .rank list (idempotent).
const RANK_JS = `
function initRank(root){
  root.querySelectorAll('.rank').forEach(function(list){
    if(list.dataset.rankInit)return; list.dataset.rankInit='1';
    list.querySelectorAll('.rankrow').forEach(function(row){
      row.addEventListener('dragstart',function(e){window.__drag=row;row.classList.add('drag');if(e.dataTransfer)e.dataTransfer.effectAllowed='move';});
      row.addEventListener('dragend',function(){row.classList.remove('drag');window.__drag=null;});
      row.addEventListener('dragover',function(e){e.preventDefault();var d=window.__drag;if(!d||d===row||d.parentNode!==list)return;var r=row.getBoundingClientRect();var after=(e.clientY-r.top)/r.height>0.5;list.insertBefore(d,after?row.nextSibling:row);});
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
    if(grabbed){var lst=grabbed.parentNode,rows=[].slice.call(lst.querySelectorAll('.rankrow')),i=rows.indexOf(grabbed),j=i+dir;if(j<0||j>=rows.length)return;if(dir>0)lst.insertBefore(grabbed,rows[j].nextSibling);else lst.insertBefore(grabbed,rows[j]);grabbed.scrollIntoView({block:'nearest'});return;}
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
  setTimeout(window.kfocusScan,60);
})();`;

export function renderPage(questions) {
  const title = questions.title ? esc(questions.title) : 'rizzdev-detective';
  const body = renderFindings(questions.findings) + questions.sections.map(renderSection).join('');
  const dataIsland = JSON.stringify(questions).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>${STYLES}</style></head>
<body>
<div class="wrap">
  <div class="titlebar"><span class="dot r"></span><span class="dot y"></span><span class="dot g"></span><span class="tt">rizzdev@detective: ./detective</span></div>
  <div class="screen">
    <div class="prompt"><span class="sym">$</span> ./detective --interview<span class="cursor"></span></div>
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
  const inner = renderFindings(nq.findings) + nq.sections.map(renderSection).join('');
  return `<div class="batch" data-batch="${id}">${heading}${inner}<div class="cont"><button type="button" onclick="sendBatch(${id})">continue →</button></div></div>`;
}

function renderLiveShell() {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>rizzdev-detective — live</title>
<style>${STYLES}</style></head>
<body>
<div class="wrap">
  <div class="titlebar"><span class="dot r"></span><span class="dot y"></span><span class="dot g"></span><span class="tt">rizzdev@detective: ./detective --live</span></div>
  <div class="screen">
    <div class="prompt"><span class="sym">$</span> ./detective --live<span class="cursor"></span></div>
    <div id="feed"></div>
    <div class="statusline" id="status"><span class="dotp"></span><span id="stext">connecting…</span></div>
    <div class="endbar"><button type="button" onclick="decideRest()">decide the rest →</button><button type="button" onclick="endInterview()">end interview</button></div>
    ${NAV_HTML}
  </div>
</div>
<script>
const feed=document.getElementById('feed');
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
    const o=el.querySelector('[id="other__'+qid+'"]');
    const q=el.querySelector('.question[data-qid="'+qid+'"]');
    ans[qid]={selected:sel,other:o?o.value:'',delegated:!!(q&&q.classList.contains('delegated'))};
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
function doAction(q,kind){
  if(!q)return;
  if(kind==='decide'){const rec=q.dataset.rec;if(rec){const inp=q.querySelector('input[value="'+rec+'"]');if(inp)inp.checked=true;}q.classList.add('delegated');return;}
  let note='';
  if(kind==='rethink'){note=prompt("What's off? What should I aim for instead? (optional)")||'';}
  q.classList.add('awaiting');setStatus('think','claude is thinking…');
  post('/signal',{batch:batchOf(q),qid:q.dataset.qid,kind:kind,note:note});
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
const es=new EventSource('/events');
es.onopen=function(){setStatus('','waiting for the first question…');};
es.addEventListener('batch',function(e){const d=JSON.parse(e.data);feed.insertAdjacentHTML('beforeend',d.html);const nb=feed.querySelector('.batch[data-batch="'+d.id+'"]');initRank(feed);addActions(nb);if(window.kfocusIn)window.kfocusIn(nb);setStatus('','your move');window.scrollTo(0,1e9);});
es.addEventListener('status',function(e){const d=JSON.parse(e.data);setStatus(d.kind||'',d.text||'');});
es.addEventListener('retract',function(e){const d=JSON.parse(e.data);feed.querySelectorAll('.batch').forEach(function(el){if(Number(el.dataset.batch)>d.from)el.remove();});setStatus('think','claude is thinking…');});
es.addEventListener('finish',function(e){es.close();const eb=document.querySelector('.endbar');if(eb)eb.remove();setStatus('done','interview complete — you can close this tab.');});
${NAV_JS}
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
  const state = { clients: [], batches: [], answers: {}, globalNote: '', pending: [], waiters: [], finished: false };

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
              other: typeof a.other === 'string' ? a.other : '',
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
          state.pending.push({ type: 'signal', batch: d.batch, qid: d.qid, kind: d.kind, note: typeof d.note === 'string' ? d.note : '' });
          broadcast('status', { kind: 'think', text: 'claude is thinking…' });
          settle();
          json(200, { ok: true });
        });
        return;
      }
      if (req.method === 'POST' && p === '/ctl/push') {
        readBody(req).then((body) => {
          let doc;
          try { doc = normalizeQuestions(JSON.parse(body)); } catch (e) { json(400, { error: String(e && e.message || e) }); return; }
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
        json(200, { answers: state.answers, globalNote: state.globalNote, batches: state.batches.length, finished: state.finished }); return;
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
const SESSION_DEFAULT = `${tmpdir()}/rizzdev-detective-live.json`;

const USAGE = `usage:
  detective.mjs <questions.json> [--out <results.json>]   one-shot form
  detective.mjs --live [--port N] [--out <file>]          start a live interview server
  detective.mjs push <batch.json> [--port N]              push a question batch into the live server
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
      console.error(`\nrizzdev-detective live → ${url}`);
      console.error('drive it:  push <batch.json>  ·  wait  ·  finish\n');
      openBrowser(url);
    },
  });
  const out = argFlag(args, 'out');
  if (out) writeFileSync(out, JSON.stringify(transcript, null, 2));
  process.stdout.write(JSON.stringify(transcript, null, 2) + '\n');
  process.exit(0);
}

async function runOneShot(args) {
  const path = args.find((a) => !a.startsWith('--'));
  const outPath = argFlag(args, 'out');
  if (!path) { console.error(USAGE); process.exit(2); }
  let questions;
  try { questions = loadQuestions(path); }
  catch (e) { console.error(`error: ${e.message}`); process.exit(1); }
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

async function main() {
  const args = process.argv.slice(2);
  const cmd = args.filter((a) => !a.startsWith('--'))[0];
  if (args.includes('--live')) return runLiveServer(args);
  if (['push', 'wait', 'retract', 'finish', 'state'].includes(cmd)) return runControl(cmd, args);
  return runOneShot(args);
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
