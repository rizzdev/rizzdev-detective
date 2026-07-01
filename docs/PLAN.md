# rizzdev-detective Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a zero-dependency Node skill that serves Claude-authored multiple-choice questions in a polished local web page, blocks until the user submits, and returns their answers as structured JSON.

**Architecture:** One self-contained ES module (`detective.mjs`) exposing four pure/near-pure functions — `loadQuestions`, `renderPage`, `normalizeResults`, `serve` — plus a `main()` CLI entry. Pure functions are unit-tested with the built-in `node:test` runner; `serve`/`main` are covered by one HTTP round-trip integration test. The page is a single scrollable form embedded as template strings.

**Tech Stack:** Node 22+ (ESM), built-in `node:http` / `node:fs` / `node:child_process` / `node:url`, `node:test` + `node:assert`. No npm dependencies, no build step.

## Global Constraints

- **Zero npm dependencies.** Only Node built-ins. No `package.json` `dependencies`, no `node_modules`.
- **Node 22+**, ESM (`.mjs`, `import`/`export`).
- **Skill home:** `rizzdev-skills/skills/rizzdev-detective/` (user skill, symlinked into `~/.claude/skills/` by the repo install script).
- **Localhost only:** bind `127.0.0.1`. No external exposure, no auth.
- **One-shot blocking:** one run = one interview; process exits `0` after a submit.
- **Results schema (verbatim):** `{ "answers": { "<qid>": { "selected": string[], "other": string } }, "globalNote": string, "submittedAt": ISO-string }`.
- **Questions schema:** top-level `title?`; either `sections: [{title?, questions:[]}]` or flat `questions: []`; question = `{ id, text, why?, type?("single"|"multi", default single), recommendation?{optionId?, why?}, options:[{id,label,pro?,con?}], allowOther?(default true) }`.

---

### Task 1: Input handling — validate, normalize, load

**Files:**
- Create: `skills/rizzdev-detective/detective.mjs`
- Test: `skills/rizzdev-detective/test/detective.test.mjs`

**Interfaces:**
- Consumes: nothing (first task).
- Produces:
  - `validateQuestions(doc) -> doc` (throws `Error` with a clear message on invalid input).
  - `normalizeQuestions(doc) -> { title?: string, sections: Array<{ title?: string, questions: Array<NormQ> }> }` where `NormQ = { id, text, why?, type:"single"|"multi", recommendation?:{optionId?,why?}, options:Array<{id,label,pro?,con?}>, allowOther:boolean }`.
  - `loadQuestions(path) -> NormalizedDoc` (reads file, JSON-parses, normalizes; throws on read/parse/validation failure).

- [ ] **Step 1: Write the failing tests**

Create `skills/rizzdev-detective/test/detective.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateQuestions, normalizeQuestions, loadQuestions } from '../detective.mjs';

const flat = {
  title: 'Demo',
  questions: [
    { id: 'q1', text: 'Pick one', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] },
  ],
};

test('validateQuestions accepts a flat doc', () => {
  assert.equal(validateQuestions(flat), flat);
});

test('validateQuestions rejects missing options', () => {
  assert.throws(() => validateQuestions({ questions: [{ id: 'q1', text: 't', options: [] }] }), /non-empty "options"/);
});

test('validateQuestions rejects duplicate question ids', () => {
  const dup = { questions: [
    { id: 'q1', text: 't', options: [{ id: 'a', label: 'A' }] },
    { id: 'q1', text: 't2', options: [{ id: 'a', label: 'A' }] },
  ] };
  assert.throws(() => validateQuestions(dup), /duplicate question id: q1/);
});

test('validateQuestions rejects bad type', () => {
  const bad = { questions: [{ id: 'q1', text: 't', type: 'dropdown', options: [{ id: 'a', label: 'A' }] }] };
  assert.throws(() => validateQuestions(bad), /must be "single" or "multi"/);
});

test('normalizeQuestions wraps flat questions in one section and applies defaults', () => {
  const n = normalizeQuestions(flat);
  assert.equal(n.title, 'Demo');
  assert.equal(n.sections.length, 1);
  assert.equal(n.sections[0].questions[0].type, 'single');
  assert.equal(n.sections[0].questions[0].allowOther, true);
});

test('normalizeQuestions preserves sections and respects allowOther:false + type:multi', () => {
  const doc = { sections: [{ title: 'S', questions: [
    { id: 'q1', text: 't', type: 'multi', allowOther: false, options: [{ id: 'a', label: 'A' }] },
  ] }] };
  const n = normalizeQuestions(doc);
  assert.equal(n.sections[0].title, 'S');
  assert.equal(n.sections[0].questions[0].type, 'multi');
  assert.equal(n.sections[0].questions[0].allowOther, false);
});

test('loadQuestions throws a clear error on invalid JSON', () => {
  assert.throws(() => loadQuestions(new URL('./fixtures/bad.json', import.meta.url).pathname), /not valid JSON/);
});
```

Create the fixture `skills/rizzdev-detective/test/fixtures/bad.json` with literal content:

```
{ not valid json
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd skills/rizzdev-detective && node --test`
Expected: FAIL — `Cannot find module '../detective.mjs'` / functions not exported.

- [ ] **Step 3: Write the minimal implementation**

Create `skills/rizzdev-detective/detective.mjs` with (only these exports for this task; more added later):

```js
import { readFileSync } from 'node:fs';

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
      if (!Array.isArray(q.options) || q.options.length === 0) {
        throw new Error(`question ${q.id} needs a non-empty "options" array`);
      }
      if (q.type !== undefined && q.type !== 'single' && q.type !== 'multi') {
        throw new Error(`question ${q.id} type must be "single" or "multi"`);
      }
      const optSeen = new Set();
      for (const o of q.options) {
        if (!o || typeof o.id !== 'string' || !o.id) throw new Error(`question ${q.id} has an option missing "id"`);
        if (optSeen.has(o.id)) throw new Error(`question ${q.id} has duplicate option id: ${o.id}`);
        optSeen.add(o.id);
        if (typeof o.label !== 'string' || !o.label) throw new Error(`question ${q.id} option ${o.id} needs "label"`);
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
    questions: sec.questions.map((q) => ({
      id: q.id,
      text: q.text,
      why: typeof q.why === 'string' ? q.why : undefined,
      type: q.type === 'multi' ? 'multi' : 'single',
      recommendation: q.recommendation && typeof q.recommendation === 'object'
        ? { optionId: q.recommendation.optionId, why: q.recommendation.why }
        : undefined,
      options: q.options.map((o) => ({ id: o.id, label: o.label, pro: o.pro, con: o.con })),
      allowOther: q.allowOther !== false,
    })),
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd skills/rizzdev-detective && node --test`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
cd /home/andre/projects/rizzdev-skills
git add skills/rizzdev-detective/detective.mjs skills/rizzdev-detective/test/
git commit -m "feat(detective): questions validation, normalization, loading"
```

---

### Task 2: Render the HTML page

**Files:**
- Modify: `skills/rizzdev-detective/detective.mjs`
- Test: `skills/rizzdev-detective/test/detective.test.mjs`

**Interfaces:**
- Consumes: `normalizeQuestions` output (`NormalizedDoc`).
- Produces: `renderPage(questions) -> string` (a full standalone HTML document). Renders per-question `why`, per-question `recommendation`, per-option `pro`/`con`, radio (single) / checkbox (multi) inputs with attributes `data-qid="<qid>" value="<oid>"`, an `id="other__<qid>"` text input when `allowOther`, and a global `id="__global"` textarea. Embeds the normalized doc as `window.__DETECTIVE__` (with `<` escaped) and wires a submit handler that POSTs `{answers, globalNote}` JSON to `/submit`.

- [ ] **Step 1: Write the failing tests**

Append to `skills/rizzdev-detective/test/detective.test.mjs`:

```js
import { renderPage } from '../detective.mjs';

const rich = normalizeQuestions({
  title: 'My Interview',
  sections: [{
    title: 'Auth',
    questions: [{
      id: 'auth', text: 'Which auth model?', why: 'Sets week-1 scope.', type: 'single',
      recommendation: { optionId: 'token', why: 'Fastest to ship.' },
      options: [
        { id: 'token', label: 'Pasted token', pro: 'No OAuth work', con: 'Manual rotation' },
        { id: 'oauth', label: 'OAuth', pro: 'Clean UX', con: 'Weeks of work' },
      ],
      allowOther: true,
    }],
  }],
});

test('renderPage returns a full HTML doc with the title', () => {
  const html = renderPage(rich);
  assert.match(html, /<!doctype html>/i);
  assert.match(html, /My Interview/);
  assert.match(html, /Auth/);
});

test('renderPage renders question text, why, recommendation, pros and cons', () => {
  const html = renderPage(rich);
  assert.match(html, /Which auth model\?/);
  assert.match(html, /Sets week-1 scope\./);
  assert.match(html, /Fastest to ship\./);
  assert.match(html, /No OAuth work/);
  assert.match(html, /Manual rotation/);
});

test('renderPage uses radio for single and includes data-qid + value', () => {
  const html = renderPage(rich);
  assert.match(html, /type="radio"[^>]*data-qid="auth"[^>]*value="token"/);
  assert.match(html, /id="other__auth"/);
  assert.match(html, /id="__global"/);
});

test('renderPage uses checkbox for multi and omits Other box when allowOther is false', () => {
  const q = normalizeQuestions({ questions: [
    { id: 'm', text: 'Pick many', type: 'multi', allowOther: false,
      options: [{ id: 'x', label: 'X' }, { id: 'y', label: 'Y' }] },
  ] });
  const html = renderPage(q);
  assert.match(html, /type="checkbox"[^>]*data-qid="m"/);
  assert.doesNotMatch(html, /id="other__m"/);
});

test('renderPage escapes HTML in labels to prevent breakage', () => {
  const q = normalizeQuestions({ questions: [
    { id: 'e', text: 'x', options: [{ id: 'a', label: '<script>bad</script>' }] },
  ] });
  const html = renderPage(q);
  assert.doesNotMatch(html, /<script>bad<\/script>/);
  assert.match(html, /&lt;script&gt;bad&lt;\/script&gt;/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd skills/rizzdev-detective && node --test`
Expected: FAIL — `renderPage` is not exported.

- [ ] **Step 3: Write the minimal implementation**

Append to `skills/rizzdev-detective/detective.mjs`:

```js
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

function renderQuestion(q) {
  const why = q.why ? `<p class="why"><span class="why-tag">The problem</span> ${esc(q.why)}</p>` : '';
  const rec = q.recommendation && q.recommendation.why
    ? `<div class="rec">💡 <strong>My recommendation:</strong> ${esc(q.recommendation.why)}</div>` : '';
  const other = q.allowOther
    ? `<input type="text" class="other" id="other__${esc(q.id)}" placeholder="Other / add nuance…">` : '';
  const options = q.options.map((o) => renderOption(q, o)).join('');
  return `
    <section class="question" data-qid="${esc(q.id)}">
      <h3>${esc(q.text)}</h3>
      ${why}
      ${rec}
      <div class="options">${options}</div>
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
body{margin:0;font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#0f1115;color:#e6e8ec}
.wrap{max-width:760px;margin:0 auto;padding:32px 20px 120px}
h1{font-size:1.6rem;margin:0 0 24px}
.section-title{font-size:1.15rem;color:#8ab4ff;border-bottom:1px solid #2a2f3a;padding-bottom:6px;margin:32px 0 12px}
.question{background:#171a21;border:1px solid #262b36;border-radius:12px;padding:18px 20px;margin:16px 0}
.question h3{margin:0 0 8px;font-size:1.05rem}
.why{margin:0 0 10px;color:#b7bdc9;font-size:.92rem}
.why-tag{display:inline-block;background:#3a2a12;color:#ffcf8a;border-radius:5px;padding:1px 7px;font-size:.75rem;margin-right:6px}
.rec{background:#12261b;border:1px solid #1f4a34;color:#a7e6c4;border-radius:8px;padding:8px 12px;margin:0 0 12px;font-size:.9rem}
.options{display:flex;flex-direction:column;gap:8px}
.option{display:flex;gap:10px;align-items:flex-start;background:#12151c;border:1px solid #262b36;border-radius:9px;padding:10px 12px;cursor:pointer}
.option:hover{border-color:#3a4150}
.option.recommended{border-color:#2f7a52}
.option input{margin-top:4px}
.option-label{font-weight:600}
.rec-star{color:#6ee7a8;font-weight:600;font-size:.8rem;margin-left:6px}
.pro{color:#7fd6a3;font-size:.85rem;margin-top:2px}
.con{color:#e9a3a3;font-size:.85rem;margin-top:2px}
.other{width:100%;margin-top:10px;background:#0d1015;border:1px solid #2a2f3a;color:#e6e8ec;border-radius:7px;padding:8px 10px}
textarea#__global{width:100%;min-height:90px;background:#0d1015;border:1px solid #2a2f3a;color:#e6e8ec;border-radius:9px;padding:10px}
.global{background:#171a21;border:1px solid #262b36;border-radius:12px;padding:18px 20px;margin:24px 0}
.bar{position:fixed;bottom:0;left:0;right:0;background:#0b0d11;border-top:1px solid #262b36;padding:14px 20px;display:flex;justify-content:center}
.bar button{background:#3b82f6;color:#fff;border:0;border-radius:9px;padding:11px 28px;font-size:1rem;font-weight:600;cursor:pointer}
.bar button:hover{background:#2f6fdc}
.done{max-width:600px;margin:120px auto;text-align:center}
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd skills/rizzdev-detective && node --test`
Expected: PASS (all tests including the 5 new render tests).

- [ ] **Step 5: Commit**

```bash
cd /home/andre/projects/rizzdev-skills
git add skills/rizzdev-detective/detective.mjs skills/rizzdev-detective/test/detective.test.mjs
git commit -m "feat(detective): render polished single-page form"
```

---

### Task 3: Normalize submitted results

**Files:**
- Modify: `skills/rizzdev-detective/detective.mjs`
- Test: `skills/rizzdev-detective/test/detective.test.mjs`

**Interfaces:**
- Consumes: `NormalizedDoc`, plus the raw client payload `{ answers?, globalNote? }`.
- Produces: `normalizeResults(payload, questions, submittedAt?) -> { answers: Record<qid,{selected:string[],other:string}>, globalNote: string, submittedAt: string }`. Guarantees every question id is present (empty `selected`/`other` if unanswered), coerces single-type to at most one selection, and injects `submittedAt` (uses the passed value for deterministic tests, else `new Date().toISOString()`).

- [ ] **Step 1: Write the failing tests**

Append to `skills/rizzdev-detective/test/detective.test.mjs`:

```js
import { normalizeResults } from '../detective.mjs';

const two = normalizeQuestions({ questions: [
  { id: 'q1', text: 'one', type: 'single', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] },
  { id: 'q2', text: 'many', type: 'multi', options: [{ id: 'x', label: 'X' }, { id: 'y', label: 'Y' }] },
] });

test('normalizeResults fills every question and passes globalNote + submittedAt', () => {
  const r = normalizeResults({ answers: { q1: { selected: ['a'], other: '' } }, globalNote: 'hi' }, two, '2026-07-01T00:00:00.000Z');
  assert.deepEqual(r.answers.q1, { selected: ['a'], other: '' });
  assert.deepEqual(r.answers.q2, { selected: [], other: '' });
  assert.equal(r.globalNote, 'hi');
  assert.equal(r.submittedAt, '2026-07-01T00:00:00.000Z');
});

test('normalizeResults trims single-type to at most one selection', () => {
  const r = normalizeResults({ answers: { q1: { selected: ['a', 'b'] } } }, two, 'T');
  assert.deepEqual(r.answers.q1.selected, ['a']);
});

test('normalizeResults keeps multiple selections for multi-type and preserves other text', () => {
  const r = normalizeResults({ answers: { q2: { selected: ['x', 'y'], other: 'z' } } }, two, 'T');
  assert.deepEqual(r.answers.q2.selected, ['x', 'y']);
  assert.equal(r.answers.q2.other, 'z');
});

test('normalizeResults tolerates a completely empty payload', () => {
  const r = normalizeResults({}, two, 'T');
  assert.deepEqual(r.answers.q1, { selected: [], other: '' });
  assert.equal(r.globalNote, '');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd skills/rizzdev-detective && node --test`
Expected: FAIL — `normalizeResults` is not exported.

- [ ] **Step 3: Write the minimal implementation**

Append to `skills/rizzdev-detective/detective.mjs`:

```js
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd skills/rizzdev-detective && node --test`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
cd /home/andre/projects/rizzdev-skills
git add skills/rizzdev-detective/detective.mjs skills/rizzdev-detective/test/detective.test.mjs
git commit -m "feat(detective): normalize submitted results"
```

---

### Task 4: HTTP server, browser-open, and CLI entry

**Files:**
- Modify: `skills/rizzdev-detective/detective.mjs`
- Test: `skills/rizzdev-detective/test/serve.test.mjs`

**Interfaces:**
- Consumes: `renderPage`, `normalizeResults`, `NormalizedDoc`.
- Produces:
  - `serve(questions, opts?) -> Promise<Results>` where `opts = { port?:number (default 8787), maxTries?:number (default 20), onListen?:(url:string)=>void }`. Serves GET `/` → page, POST `/submit` → parses body, resolves the promise with normalized results, closes the server. Increments the port on `EADDRINUSE`.
  - `main()` — parses `argv` (`<questions.json>` positional, optional `--out <path>`), loads questions, runs `serve`, writes results to `--out` if given, prints results JSON to stdout, exits `0`. Errors exit non-zero with a stderr message. Runs only when the module is the entry point.

- [ ] **Step 1: Write the failing integration test**

Create `skills/rizzdev-detective/test/serve.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeQuestions, serve } from '../detective.mjs';

const doc = normalizeQuestions({ questions: [
  { id: 'q1', text: 'one', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] },
] });

test('serve serves the page on GET / and returns results on POST /submit', async () => {
  let url;
  const done = serve(doc, { port: 8899, onListen: (u) => { url = u; } });
  // Wait until onListen fired.
  while (!url) await new Promise((r) => setTimeout(r, 10));

  const page = await fetch(url);
  const html = await page.text();
  assert.match(html, /<!doctype html>/i);

  const post = await fetch(url + 'submit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ answers: { q1: { selected: ['b'], other: '' } }, globalNote: 'note' }),
  });
  assert.equal(post.status, 200);

  const results = await done;
  assert.deepEqual(results.answers.q1.selected, ['b']);
  assert.equal(results.globalNote, 'note');
  assert.ok(results.submittedAt);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd skills/rizzdev-detective && node --test test/serve.test.mjs`
Expected: FAIL — `serve` is not exported.

- [ ] **Step 3: Write the minimal implementation**

Append to `skills/rizzdev-detective/detective.mjs`:

```js
import http from 'node:http';
import { writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const CONFIRM_HTML = `<!doctype html><meta charset="utf-8"><title>Sent</title>
<body style="font:16px system-ui;background:#0f1115;color:#e6e8ec;text-align:center;padding-top:120px">
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
```

Note: move the three `import` statements added here to the top of the file with the existing `import { readFileSync }` line if a linter complains — Node allows `import` only at module top level, so consolidate: `import { readFileSync, writeFileSync } from 'node:fs';` and add the `http`, `child_process`, `url` imports beside it. Delete the duplicate `readFileSync` import.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd skills/rizzdev-detective && node --test`
Expected: PASS (all unit tests + the serve integration test).

- [ ] **Step 5: Smoke-test the CLI manually**

Create `skills/rizzdev-detective/test/fixtures/sample.json`:

```json
{
  "title": "Detective smoke test",
  "sections": [{
    "title": "Basics",
    "questions": [{
      "id": "color", "text": "Favorite color?", "why": "Confirms the form works end to end.",
      "type": "single", "recommendation": { "optionId": "blue", "why": "It just is." },
      "options": [
        { "id": "blue", "label": "Blue", "pro": "Calm", "con": "Common" },
        { "id": "red", "label": "Red", "pro": "Bold", "con": "Loud" }
      ],
      "allowOther": true
    }]
  }]
}
```

Run: `cd skills/rizzdev-detective && node detective.mjs test/fixtures/sample.json --out /tmp/detective-out.json`
Expected: stderr prints the URL; the browser opens (or copy the URL). Answer and submit. The process exits and prints the results JSON to stdout; `/tmp/detective-out.json` matches. (If no display is available, `curl -X POST <url>submit -H 'Content-Type: application/json' -d '{"answers":{"color":{"selected":["blue"]}}}'` completes the round-trip.)

- [ ] **Step 6: Commit**

```bash
cd /home/andre/projects/rizzdev-skills
git add skills/rizzdev-detective/detective.mjs skills/rizzdev-detective/test/
git commit -m "feat(detective): http server, browser-open, and CLI entry"
```

---

### Task 5: Author SKILL.md

**Files:**
- Create: `skills/rizzdev-detective/SKILL.md`

**Interfaces:**
- Consumes: the finished `detective.mjs` CLI contract.
- Produces: the skill definition Claude reads at trigger time.

- [ ] **Step 1: Write SKILL.md**

Create `skills/rizzdev-detective/SKILL.md`:

````markdown
---
name: rizzdev-detective
description: Use when the user asks for a lot of questions at once, a questionnaire, a survey, or runs /rizzdev-detective. Serves Claude-authored multiple-choice questions (with per-option pros/cons and a per-question recommendation) in a polished local web page, blocks until the user submits, and returns their answers as structured JSON.
---

# rizzdev-detective

## Overview

Instead of asking many questions one-at-a-time in chat, hand the user a whole
batch at once in a browser form and read their answers back as structured data.
Each question can carry a "why / the problem" line, per-option pros and cons,
and your recommended pick with reasoning — so the user triages fast with the
tradeoffs visible.

## When to Use

- The user asks for "a lot of questions", a questionnaire, a survey, or "ask me everything at once".
- The user runs `/rizzdev-detective`.
- You have many decisions to resolve and want them triaged in one pass.

**When NOT to use:** a single quick question (just ask in chat), or open-ended
dialogue where each answer reshapes the next (use `superpowers:brainstorming`).

## How to Run It

1. **Author the questions** as a JSON file. Fill `why`, per-option `pro`/`con`,
   and a `recommendation` wherever you have a lean — that reasoning is the point
   of this tool. Write it to the session scratchpad dir.

   ```json
   {
     "title": "Optional page heading",
     "sections": [{
       "title": "Auth",
       "questions": [{
         "id": "auth",
         "text": "Which auth model for v1?",
         "why": "Determines how much of week 1 goes to plumbing vs features.",
         "type": "single",
         "recommendation": { "optionId": "token", "why": "Fastest path to a working v1." },
         "options": [
           { "id": "token", "label": "Pasted long-lived token", "pro": "No OAuth work", "con": "Manual rotation" },
           { "id": "oauth", "label": "OAuth", "pro": "Clean UX", "con": "Weeks of work" }
         ],
         "allowOther": true
       }]
     }]
   }
   ```

   - Top level: `title?` plus either `sections` or a flat `questions` array.
   - Question: `id` (unique), `text`, `why?`, `type` (`single` | `multi`, default `single`),
     `recommendation?` (`{optionId?, why?}`), `options` (`{id, label, pro?, con?}`), `allowOther?` (default true).

2. **Run the server** (it blocks until the user submits):

   ```bash
   node ~/.claude/skills/rizzdev-detective/detective.mjs <questions.json> --out <results.json>
   ```

   It prints the local URL to stderr and tries to open the browser. The command
   returns only after the user hits Submit, printing the results JSON to stdout.

3. **Read the results** and continue:

   ```json
   {
     "answers": { "auth": { "selected": ["token"], "other": "" } },
     "globalNote": "any overall notes",
     "submittedAt": "2026-07-01T13:05:00.000Z"
   }
   ```

   `answers` is keyed by question `id`; `selected` holds chosen option ids
   (0–1 for single, 0–n for multi); `other` is the per-question free-text box;
   `globalNote` is the end-of-form "anything else?" box. Unanswered questions
   come back with empty `selected` — partial submissions are fine.

## Notes

- Zero dependencies; needs Node 22+. Localhost only.
- One run = one interview. To ask a follow-up round, author a new file and run again.
- If the browser doesn't auto-open, share the printed URL with the user.
````

- [ ] **Step 2: Commit**

```bash
cd /home/andre/projects/rizzdev-skills
git add skills/rizzdev-detective/SKILL.md
git commit -m "docs(detective): add SKILL.md"
```

---

### Task 6: Register the skill in the repo

**Files:**
- Modify: `README.md` (the `## Skills` list)

**Interfaces:**
- Consumes: nothing.
- Produces: repo documentation + an installed symlink so `/rizzdev-detective` resolves.

- [ ] **Step 1: Add the skill to the README skills list**

In `README.md`, under `## Skills`, add a bullet after the `rizzdev-quickstorm` entry:

```markdown
- **rizzdev-detective** — serves a batch of multiple-choice questions (with
  per-option pros/cons and a recommendation) in a local web page and returns
  the answers as JSON; for when you want to ask a lot of questions at once.
```

- [ ] **Step 2: Install the new skill symlink**

Run: `cd /home/andre/projects/rizzdev-skills && ./install.sh`
Expected: prints that `rizzdev-detective` was linked (or copied) into `~/.claude/skills/`.

- [ ] **Step 3: Verify the skill resolves**

Run: `ls -l ~/.claude/skills/rizzdev-detective && node ~/.claude/skills/rizzdev-detective/detective.mjs 2>&1 | head -1`
Expected: the symlink exists; the second command prints the `usage:` line (exit 2 because no questions file was passed).

- [ ] **Step 4: Commit**

```bash
cd /home/andre/projects/rizzdev-skills
git add README.md
git commit -m "docs: register rizzdev-detective skill"
```

---

## Self-Review

**Spec coverage:**
- Packaging (single zero-dep Node `.mjs` + SKILL.md) → Tasks 1–5. ✓
- One-shot blocking flow (write json → run → open browser → block → stdout/results.json → exit) → Task 4. ✓
- Auto-open with fallbacks + always print URL → Task 4 `openBrowser`/`onListen`. ✓
- Free port with `EADDRINUSE` fallback → Task 4 `serve`. ✓
- Single scrollable form, dark mode, sticky submit bar → Task 2 CSS. ✓
- Sections grouping + flat fallback → Tasks 1 (normalize) + 2 (render). ✓
- Single/multi inputs, per-option pro/con, per-question recommendation, per-question `why`, per-question "Other", global note → Task 2. ✓
- Questions schema + defaults (type=single, allowOther=true) → Task 1. ✓
- Results schema (answers/globalNote/submittedAt, every id present, single trimmed) → Task 3. ✓
- Malformed JSON → clear error, non-zero exit → Tasks 1 + 4. ✓
- Trigger conditions + authoring guidance → Task 5 SKILL.md. ✓
- User-skill install/registration → Task 6. ✓
- Testing (validation, render, round-trip, port fallback covered by serve test) → Tasks 1–4. ✓

**Placeholder scan:** No TBD/TODO; every code and test step contains complete content. ✓

**Type consistency:** `normalizeQuestions` output shape (`{title?, sections:[{title?, questions:[NormQ]}]}`) is consumed unchanged by `renderPage`, `normalizeResults`, and `serve`. Function names (`validateQuestions`, `normalizeQuestions`, `loadQuestions`, `renderPage`, `normalizeResults`, `serve`) match across tasks and tests. Client posts `{answers, globalNote}`; `normalizeResults` reads exactly those keys. ✓
