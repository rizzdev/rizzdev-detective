# claude-detective Updates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebrand the questionnaire skill to `claude-detective` and add a config
system, on-demand audit, multi-select custom entries, and a set of UX fixes/bug
fixes — all inside the single zero-dependency `detective.mjs`.

**Architecture:** One file, `detective.mjs` (Node ≥ 22, `node:*` built-ins only).
Pure functions (`validateQuestions`, `normalizeQuestions`, `renderQuestion`,
`normalizeResults`, config helpers) are unit-tested via `node --test`; the live
server (`serveLive`) and one-shot `serve` are integration-tested by starting them on
a port and driving them with `fetch`. UI lives in template-literal strings served by
those functions.

**Tech Stack:** Node built-ins (`http`, `fs`, `os`, `child_process`), SSE over
`http`, no framework, no build step. Tests: `node:test` + `node:assert/strict`.

## Global Constraints

- **Zero runtime dependencies.** Only `node:*` built-ins. Never add a package. — copied from spec Non-goals.
- **Single file:** all logic stays in `detective.mjs`. — spec Architecture.
- **Node ≥ 22**, ESM only. — `package.json` engines.
- **Localhost only; no network calls / phone-home.** Audit subagents run through
  Claude (the driver), never the server. — spec Non-goals.
- **Fail-loud, no silent fallbacks.** — spec Decisions / forge-flow global rule.
- **No automatic audit passes** — audit is on-demand only. — spec E.
- Backward compatibility: existing exported function signatures keep working with no
  args (new behavior is opt-in via an options/config arg that defaults to off).
- Run the full suite with `node --test` from the repo root after every task.

---

### Task 1: Rebrand to `claude-detective` (+ alias)

**Files:**
- Modify: `detective.mjs` (session-file constant, USAGE strings, path strings)
- Modify: `package.json` (name, bin, repository/homepage/bugs, author left as-is)
- Modify: `SKILL.md` (frontmatter `name`, command references, invocation paths)
- Modify: `README.md` (title, install path, command)
- Modify: `install.sh`, `install.ps1` (destination dir)
- Test: `test/detective.test.mjs`

**Interfaces:**
- Produces: `SESSION_DEFAULT` now basenamed `claude-detective-live.json`; exported
  `PKG_NAME = 'claude-detective'` constant for tests/UI to reference.

- [ ] **Step 1: Write the failing test**

Add to `test/detective.test.mjs`:

```javascript
import { PKG_NAME } from '../detective.mjs';

test('package identity is claude-detective', () => {
  assert.equal(PKG_NAME, 'claude-detective');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/detective.test.mjs`
Expected: FAIL — `PKG_NAME` is not exported / undefined.

- [ ] **Step 3: Implement**

In `detective.mjs`, near the other top-level constants:

```javascript
export const PKG_NAME = 'claude-detective';
```

Change the session-file default:

```javascript
const SESSION_DEFAULT = `${tmpdir()}/claude-detective-live.json`;
```

Replace user-facing/name strings: in `USAGE` change `detective.mjs` help header
copy that says "rizzdev-detective" to "claude-detective"; in `renderLiveShell()` the
titlebar `tt` text `rizzdev@detective: ./detective --live` →
`claude@detective: ./detective --live`; the `<title>` → `claude-detective — live`.
In `package.json` set `"name": "claude-detective"`, `"bin": { "claude-detective":
"detective.mjs" }`, and update `repository.url`/`homepage`/`bugs` to
`github.com/rizzdev/claude-detective` (repo rename is a manual follow-up; URLs are
forward-looking). In `SKILL.md` set `name: claude-detective`, change every
`/rizzdev-detective` to `/claude-detective` and every
`~/.claude/skills/rizzdev-detective/detective.mjs` to
`~/.claude/skills/claude-detective/detective.mjs`. In `README.md` update the title,
the `install.sh` clone dir note, and command examples. In `install.sh`/`install.ps1`
set the default destination to `~/.claude/skills/claude-detective` (keep the
`CLAUDE_SKILLS_DIR` override).

Add an alias note to `SKILL.md` (bottom):

```markdown
> Renamed from `rizzdev-detective`. The old `/rizzdev-detective` command still works
> as a deprecated alias (symlink the old skill dir to this one); it will be removed
> in a future release.
```

- [ ] **Step 4: Run tests**

Run: `node --test`
Expected: PASS (all existing + the new identity test).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor: rename rizzdev-detective -> claude-detective (alias kept)"
```

---

### Task 2: Double-trigger hard block (bug B1)

**Files:**
- Modify: `detective.mjs` (`runInterview` startup guard; add `isSessionLive`)
- Test: `test/detective.test.mjs`

**Interfaces:**
- Produces: `export async function isSessionLive(sessionPath)` → `{ live: boolean,
  url?: string, port?: number, pid?: number }`. `live` is true only when the session
  file parses, its `pid` is alive (`process.kill(pid, 0)` doesn't throw), and
  `GET <url>ctl/state` responds 200 within a short timeout.

- [ ] **Step 1: Write the failing test**

```javascript
import { isSessionLive } from '../detective.mjs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

test('isSessionLive reports not-live for a stale pid', async () => {
  const p = `${tmpdir()}/cd-test-stale.json`;
  writeFileSync(p, JSON.stringify({ port: 59999, url: 'http://127.0.0.1:59999/', pid: 2 ** 30 }));
  const r = await isSessionLive(p);
  assert.equal(r.live, false);
});

test('isSessionLive reports not-live when file is missing', async () => {
  const r = await isSessionLive(`${tmpdir()}/cd-test-missing-${Math.floor(performance.now())}.json`);
  assert.equal(r.live, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/detective.test.mjs`
Expected: FAIL — `isSessionLive` not exported.

- [ ] **Step 3: Implement**

Add to `detective.mjs`:

```javascript
export async function isSessionLive(sessionPath) {
  let s;
  try { s = JSON.parse(readFileSync(sessionPath, 'utf8')); } catch { return { live: false }; }
  if (!s || !s.pid || !s.url) return { live: false };
  try { process.kill(s.pid, 0); } catch { return { live: false }; } // stale pid
  try {
    const ctrl = AbortSignal.timeout(400);
    const r = await fetch(`${s.url.replace(/\/$/, '')}/ctl/state`, { signal: ctrl });
    if (r.ok) return { live: true, url: s.url, port: s.port, pid: s.pid };
  } catch {}
  return { live: false };
}
```

In `runInterview`, before starting the server (right after computing `sp`):

```javascript
if (!args.includes('--force') && !argFlag(args, 'port') && !argFlag(args, 'session')) {
  const cur = await isSessionLive(sp);
  if (cur.live) {
    console.error(`error: an interview is already live at ${cur.url} — finish it, or pass --force`);
    process.exit(1);
  }
}
```

Document `--force` in `USAGE`.

- [ ] **Step 4: Run tests**

Run: `node --test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "fix: hard-block a second live interview (B1 double-trigger)"
```

---

### Task 3: In-place update — no scroll, single continue bar (bug B2)

**Files:**
- Modify: `detective.mjs` (`renderLiveShell` client JS: `qupdate` handler; `spend`
  and continue-bar guard)
- Test: `test/detective.test.mjs` (assert client string contains the guards)

**Interfaces:**
- Consumes: existing `qupdate` SSE handler and `renderBatchHtml`.
- Produces: no scroll on `qupdate`; a batch never renders a second `.cont`.

- [ ] **Step 1: Write the failing test**

```javascript
test('live shell qupdate does not scroll the page', () => {
  const shell = renderLiveShellForTest();
  // qupdate handler must flash but NOT call scrollIntoView on update
  assert.doesNotMatch(shell, /qupdate[\s\S]*?scrollIntoView/);
});
```

Export a tiny test hook at the bottom of `detective.mjs`:

```javascript
export const renderLiveShellForTest = () => renderLiveShell();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/detective.test.mjs`
Expected: FAIL — `renderLiveShellForTest` undefined, and current `qupdate` calls `scrollIntoView`.

- [ ] **Step 3: Implement**

In the `qupdate` SSE handler, remove the scroll: change

```javascript
if(fresh){fresh.classList.add('qflash');fresh.scrollIntoView({block:'nearest'});}
```

to

```javascript
if(fresh){fresh.classList.add('qflash');}
```

Guard the continue bar: in `sendBatch`/`spend`, ensure `spend` only ever replaces
the single existing `.cont` (it already does via `el.querySelector('.cont')`). Add a
guard in `addActions`/batch insertion so a batch that already has `.spent` never gets
a fresh `.cont` re-added. Add the export hook from Step 1.

- [ ] **Step 4: Run tests**

Run: `node --test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "fix: no page-jump on in-place update; single continue bar (B2)"
```

---

### Task 4: Scroll to new section + block submit while reworking (C1, C2)

**Files:**
- Modify: `detective.mjs` (`renderLiveShell` client: `batch` SSE handler; a
  `refreshSubmitLock()` helper; `lockQuestion`)
- Test: `test/detective.test.mjs` (client-string assertions)

**Interfaces:**
- Consumes: `renderLiveShellForTest` (Task 3).
- Produces: new batches scroll their top into view; `.cont`/global submit disabled
  while any `.working` question exists in that batch.

- [ ] **Step 1: Write the failing test**

```javascript
test('new batch scrolls to its top, not the page bottom', () => {
  const shell = renderLiveShellForTest();
  assert.doesNotMatch(shell, /addEventListener\('batch'[\s\S]*?scrollTo\(0,1e9\)/);
  assert.match(shell, /addEventListener\('batch'[\s\S]*?scrollIntoView\(\{block:'start'\}\)/);
});

test('a reworking batch disables its continue button', () => {
  const shell = renderLiveShellForTest();
  assert.match(shell, /refreshSubmitLock/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/detective.test.mjs`
Expected: FAIL — still `scrollTo(0,1e9)`, no `refreshSubmitLock`.

- [ ] **Step 3: Implement**

In the `batch` SSE handler, replace `window.scrollTo(0,1e9);` with:

```javascript
if(nb)nb.scrollIntoView({block:'start'});
```

Add a helper and call it from `lockQuestion` (both on/off) and the `qupdate`
handler:

```javascript
function refreshSubmitLock(){
  feed.querySelectorAll('.batch').forEach(function(b){
    var working=b.querySelector('.question.working');
    var cont=b.querySelector('.cont button:not(.revise)');
    if(cont)cont.disabled=!!working;
    b.classList.toggle('locked-rework',!!working);
  });
}
```

Call `refreshSubmitLock()` at the end of `lockQuestion(q,on)` and inside the
`qupdate` handler after `old.remove()`. Add a `.locked-rework .cont::after{content:"
· finish reworking first";…}` hint to `STYLES` (small, muted).

- [ ] **Step 4: Run tests**

Run: `node --test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: scroll to new section; block continue while reworking (C1,C2)"
```

---

### Task 5: Multi-select custom entries → `other: string[]` (C4)

**Files:**
- Modify: `detective.mjs` (`renderQuestion` add-your-own control for `multi`;
  client `collect(id)` gathers custom entries; `normalizeResults` accepts array)
- Test: `test/detective.test.mjs`

**Interfaces:**
- Produces: for `type:'multi'`, results `other` is `string[]`; for `single`/`yesno`
  it stays a string. `normalizeResults` coerces per `type`.

- [ ] **Step 1: Write the failing test**

```javascript
test('normalizeResults keeps other as array for multi, string for single', () => {
  const q = normalizeQuestions({ questions: [
    { id: 'm', type: 'multi', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] },
    { id: 's', type: 'single', options: [{ id: 'x', label: 'X' }] },
  ] });
  const out = normalizeResults({ answers: {
    m: { selected: ['a'], other: ['SAML', 'magic link'] },
    s: { selected: ['x'], other: 'note' },
  } }, q);
  assert.deepEqual(out.answers.m.other, ['SAML', 'magic link']);
  assert.equal(out.answers.s.other, 'note');
});

test('normalizeResults coerces a stray string other on multi to a one-item array', () => {
  const q = normalizeQuestions({ questions: [
    { id: 'm', type: 'multi', options: [{ id: 'a', label: 'A' }] },
  ] });
  const out = normalizeResults({ answers: { m: { selected: [], other: 'lone' } } }, q);
  assert.deepEqual(out.answers.m.other, ['lone']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/detective.test.mjs`
Expected: FAIL — `other` currently always coerced to string.

- [ ] **Step 3: Implement**

In `normalizeResults`, replace the `other` line with type-aware handling:

```javascript
let other;
if (type === 'multi') {
  other = Array.isArray(a.other)
    ? a.other.filter((s) => typeof s === 'string' && s.trim() !== '')
    : (typeof a.other === 'string' && a.other.trim() !== '' ? [a.other.trim()] : []);
} else {
  other = typeof a.other === 'string' ? a.other : (Array.isArray(a.other) ? a.other.join(', ') : '');
}
answers[id] = { selected, other };
```

In `renderQuestion`, when `q.type === 'multi' && q.allowOther`, render an add-your-own
control instead of the single `.other` input:

```javascript
const other = q.allowOther
  ? (q.type === 'multi'
      ? `<div class="ownwrap" data-qid="${esc(q.id)}"><div class="ownchips"></div>` +
        `<input type="text" class="ownadd" placeholder="Add your own… (Enter)"></div>`
      : `<input type="text" class="other" id="other__${esc(q.id)}" placeholder="Other / add nuance…">`)
  : '';
```

Add client JS (in `renderLiveShell`) wiring: pressing Enter in `.ownadd` appends a
non-removable chip `<span class="ownchip">TEXT</span>` to `.ownchips` and clears the
input. In `collect(id)`, gather multi custom entries:

```javascript
const own=el.querySelector('.ownwrap[data-qid="'+qid+'"]');
let otherVal;
if(own){otherVal=[].slice.call(own.querySelectorAll('.ownchip')).map(c=>c.textContent);}
else{const o=el.querySelector('[id="other__'+qid+'"]');otherVal=o?o.value:'';}
ans[qid]={selected:sel,other:otherVal,delegated:!!(q&&q.classList.contains('delegated'))};
```

Update `/answer` state storage in `serveLive` to preserve arrays:

```javascript
other: Array.isArray(a.other) ? a.other.filter((s)=>typeof s==='string') : (typeof a.other==='string'?a.other:''),
```

- [ ] **Step 4: Run tests**

Run: `node --test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: multi-select add-your-own custom entries (other: string[]) (C4)"
```

---

### Task 6: "Updated <ago>" tag (C3)

**Files:**
- Modify: `detective.mjs` (`renderLiveShell` client: stamp + ticking badge; `STYLES`)
- Test: `test/detective.test.mjs` (client-string assertion)

**Interfaces:**
- Consumes: `qupdate` / `annotate` events (annotate arrives in Task 10).
- Produces: a `.qago` badge showing relative time, refreshed by one interval.

- [ ] **Step 1: Write the failing test**

```javascript
test('live shell renders a relative-time updater', () => {
  const shell = renderLiveShellForTest();
  assert.match(shell, /qago/);
  assert.match(shell, /setInterval/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/detective.test.mjs`
Expected: FAIL — no `qago`.

- [ ] **Step 3: Implement**

In the `qupdate` handler, after inserting `fresh`, stamp and badge it:

```javascript
if(fresh){fresh.classList.add('qflash');stampUpdated(fresh);}
```

Add client helpers:

```javascript
function stampUpdated(q){
  q.dataset.updated=String(nowMs());
  var b=q.querySelector('.qago');
  if(!b){b=document.createElement('span');b.className='qago';q.querySelector('h3').appendChild(b);}
  paintAgo(q);
}
function nowMs(){return (window.performance&&performance.timeOrigin?performance.timeOrigin+performance.now():+new Date());}
function paintAgo(q){
  var t=Number(q.dataset.updated);if(!t)return;var s=Math.max(0,Math.round((nowMs()-t)/1000));
  var txt=s<5?'updated just now':s<60?('updated '+s+'s ago'):('updated '+Math.round(s/60)+'m ago');
  var b=q.querySelector('.qago');if(b)b.textContent=txt;
}
setInterval(function(){feed.querySelectorAll('.question[data-updated]').forEach(paintAgo);},1000);
```

Add `.qago{margin-inline-start:8px;font-size:var(--fs-micro);color:var(--mut)}` to `STYLES`.

- [ ] **Step 4: Run tests**

Run: `node --test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: live 'updated Xs ago' tag on reworked questions (C3)"
```

---

### Task 7: Config load/save + endpoints (D)

**Files:**
- Modify: `detective.mjs` (config helpers; `POST /config`, `GET /ctl/config`;
  extend `GET /ctl/state`)
- Test: `test/serve.test.mjs` (new live-server config round-trip)

**Interfaces:**
- Produces:
  - `export function configPath()` → `~/.claude/skills/claude-detective/config.json`
    (respects `CLAUDE_SKILLS_DIR`).
  - `export function loadConfig()` → `{ requireHints:true, forceVisual:false,
    auditAsYouGo:false }` merged over defaults; missing file → defaults.
  - `export function saveConfig(patch)` → writes merged config, returns it.
  - `serveLive` state includes `config` (from `loadConfig()` at start).
  - `GET /ctl/state` includes `config`. `POST /config` persists a patch, updates
    `state.config`, broadcasts `status`, returns the config.

- [ ] **Step 1: Write the failing test**

Add to `test/serve.test.mjs`:

```javascript
import { serveLive, loadConfig } from '../detective.mjs';

test('POST /config persists and /ctl/state reflects it', async () => {
  let base;
  const done = serveLive({ port: 8901, onListen: (u, p) => { base = `http://127.0.0.1:${p}`; } });
  while (!base) await new Promise((r) => setTimeout(r, 10));
  try {
    await fetch(`${base}/config`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ forceVisual: true }) });
    const st = await (await fetch(`${base}/ctl/state`)).json();
    assert.equal(st.config.forceVisual, true);
    assert.equal(st.config.requireHints, true); // default preserved
  } finally {
    await fetch(`${base}/ctl/finish`, { method: 'POST', body: '{}' });
  }
  await done;
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/serve.test.mjs`
Expected: FAIL — `loadConfig`/`/config`/`state.config` missing.

- [ ] **Step 3: Implement**

```javascript
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
```

Add `mkdirSync` to the `node:fs` import. In `serveLive`, init
`state.config = loadConfig()`. Add endpoints (before the 404):

```javascript
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
```

Extend `/ctl/state` response to include `config: state.config`.

- [ ] **Step 4: Run tests**

Run: `node --test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: global config load/save + /config, /ctl/config, state.config (D)"
```

---

### Task 8: `requireHints` validation (D)

**Files:**
- Modify: `detective.mjs` (`validateQuestions` optional enforcement; thread config
  into `/ctl/push`)
- Test: `test/detective.test.mjs`

**Interfaces:**
- Consumes: `loadConfig` (Task 7).
- Produces: `validateQuestions(doc, opts?)` where `opts.requireHints === true`
  additionally requires each question `why` and each option `pro || hint`. Default
  `opts = {}` → no new enforcement (existing tests unaffected). `/ctl/push` calls
  `normalizeQuestions(doc, state.config)`.

- [ ] **Step 1: Write the failing test**

```javascript
test('requireHints demands a why and per-option hint', () => {
  const doc = { questions: [{ id: 'q', text: 't', options: [{ id: 'a', label: 'A' }] }] };
  assert.throws(() => validateQuestions(doc, { requireHints: true }), /why|hint/i);
});

test('requireHints passes when why and pro present', () => {
  const doc = { questions: [{ id: 'q', text: 't', why: 'because', options: [{ id: 'a', label: 'A', pro: 'fast' }] }] };
  assert.doesNotThrow(() => validateQuestions(doc, { requireHints: true }));
});

test('validateQuestions with no opts is unchanged', () => {
  const doc = { questions: [{ id: 'q', text: 't', options: [{ id: 'a', label: 'A' }] }] };
  assert.doesNotThrow(() => validateQuestions(doc));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/detective.test.mjs`
Expected: FAIL — `validateQuestions` ignores opts.

- [ ] **Step 3: Implement**

Change signature to `validateQuestions(doc, opts = {})`. Inside the per-question
loop, after existing checks:

```javascript
if (opts.requireHints) {
  if (typeof q.why !== 'string' || !q.why) throw new Error(`question ${q.id} needs a "why" (requireHints)`);
  if (q.type !== 'yesno' && Array.isArray(q.options)) {
    for (const o of q.options) {
      if (!(o.pro || o.hint)) throw new Error(`question ${q.id} option ${o.id} needs a "pro" or "hint" (requireHints)`);
    }
  }
}
```

Change `normalizeQuestions(doc, opts = {})` to call `validateQuestions(doc, opts)`
and to carry an `o.hint` field through option normalization. In `/ctl/push`, call
`normalizeQuestions(JSON.parse(body), state.config)`; on throw return the 400 as
today. Render `o.hint` in `renderOption` when no `pro`/`con` (small muted line).

- [ ] **Step 4: Run tests**

Run: `node --test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: requireHints validation (why + per-option hint) (D)"
```

---

### Task 9: `forceVisual` — visual field, render, validation (D)

**Files:**
- Modify: `detective.mjs` (`validateQuestions` visual rule; `normalizeQuestions`
  carry `visual`; `renderQuestion` render block; `STYLES`)
- Test: `test/detective.test.mjs`

**Interfaces:**
- Consumes: `loadConfig`, the `opts` param on `validateQuestions` (Task 8).
- Produces: question `visual?: string | false`. When `opts.forceVisual === true`, a
  `single`/`multi` question must have a non-empty `visual` string OR an explicit
  `visual === false` (justified opt-out); `yesno`/`rank` exempt. `renderQuestion`
  renders a `.visual` block (inline `<svg…>` passed through; anything else in `<pre>`).

- [ ] **Step 1: Write the failing test**

```javascript
test('forceVisual requires a visual on single/multi', () => {
  const doc = { questions: [{ id: 'q', text: 't', options: [{ id: 'a', label: 'A' }] }] };
  assert.throws(() => validateQuestions(doc, { forceVisual: true }), /visual/i);
});

test('forceVisual accepts an explicit visual:false opt-out', () => {
  const doc = { questions: [{ id: 'q', text: 't', visual: false, options: [{ id: 'a', label: 'A' }] }] };
  assert.doesNotThrow(() => validateQuestions(doc, { forceVisual: true }));
});

test('forceVisual exempts yesno', () => {
  const doc = { questions: [{ id: 'q', text: 't', type: 'yesno' }] };
  assert.doesNotThrow(() => validateQuestions(doc, { forceVisual: true }));
});

test('renderQuestion shows a visual block', () => {
  const n = normalizeQuestions({ questions: [{ id: 'q', text: 't', visual: '<svg width="1"></svg>', options: [{ id: 'a', label: 'A' }] }] });
  assert.match(renderQuestionHtml(n.sections[0].questions[0], 'q'), /class="visual"/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/detective.test.mjs`
Expected: FAIL — no visual handling.

- [ ] **Step 3: Implement**

In `validateQuestions`, inside the per-question loop:

```javascript
if (opts.forceVisual && (q.type === undefined || q.type === 'single' || q.type === 'multi')) {
  const hasVisual = typeof q.visual === 'string' && q.visual.trim() !== '';
  if (!hasVisual && q.visual !== false) {
    throw new Error(`question ${q.id} needs a "visual" (forceVisual) — set visual:false only if a diagram truly adds nothing`);
  }
}
```

In `normalizeQuestions`, carry `visual: typeof q.visual === 'string' ? q.visual : (q.visual === false ? false : undefined)`.
In `renderQuestion`, above `controls`:

```javascript
const visual = (typeof q.visual === 'string' && q.visual.trim())
  ? `<div class="visual">${/^\s*<svg[\s>]/i.test(q.visual) ? q.visual : `<pre>${esc(q.visual)}</pre>`}</div>`
  : '';
```

Insert `${visual}` between `${rec}` and `${controls}`. Add `.visual{margin:8px 0;
padding:8px;border:1px solid var(--bd);border-radius:6px;overflow:auto}
.visual pre{margin:0;white-space:pre;font-size:var(--fs-micro)}` to `STYLES`.

- [ ] **Step 4: Run tests**

Run: `node --test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: forceVisual — per-question Claude-authored diagram + validation (D)"
```

---

### Task 10: Settings ⚙ panel + context.md (D)

**Files:**
- Modify: `detective.mjs` (`renderLiveShell` gear button + panel; `POST /context`,
  `GET /ctl/context`)
- Test: `test/serve.test.mjs`

**Interfaces:**
- Consumes: `POST /config` (Task 7).
- Produces: `contextPath()` = `~/.claude/skills/claude-detective/context.md`.
  `GET /ctl/context` → `{ text }`; `POST /context { text }` persists. Panel reads
  `/ctl/config` + `/ctl/context` on open, writes via `/config` + `/context`.

- [ ] **Step 1: Write the failing test**

```javascript
test('context round-trips via /context and /ctl/context', async () => {
  let base;
  const done = serveLive({ port: 8902, onListen: (u, p) => { base = `http://127.0.0.1:${p}`; } });
  while (!base) await new Promise((r) => setTimeout(r, 10));
  try {
    await fetch(`${base}/context`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'always prefer X' }) });
    const c = await (await fetch(`${base}/ctl/context`)).json();
    assert.equal(c.text, 'always prefer X');
  } finally { await fetch(`${base}/ctl/finish`, { method: 'POST', body: '{}' }); }
  await done;
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/serve.test.mjs`
Expected: FAIL — `/context` missing.

- [ ] **Step 3: Implement**

```javascript
export function contextPath() { return configPath().replace(/config\.json$/, 'context.md'); }
export function loadContext() { try { return readFileSync(contextPath(), 'utf8'); } catch { return ''; } }
export function saveContext(text) {
  try { mkdirSync(contextPath().replace(/\/[^/]+$/, ''), { recursive: true }); } catch {}
  writeFileSync(contextPath(), typeof text === 'string' ? text : '');
  return loadContext();
}
```

Endpoints in `serveLive`:

```javascript
if (req.method === 'GET' && p === '/ctl/context') { json(200, { text: loadContext() }); return; }
if (req.method === 'POST' && p === '/context') {
  readBody(req).then((body) => { let d = {}; try { d = JSON.parse(body || '{}'); } catch {} saveContext(d.text); json(200, { ok: true }); });
  return;
}
```

In `renderLiveShell`, add a `⚙` button to the titlebar that toggles a `.settings`
panel containing: three checkboxes bound to config keys (`requireHints`,
`forceVisual`, `auditAsYouGo`) and a `<textarea>` for context. On `auditAsYouGo`
check, `confirm('Audits spawn Sonnet-5 subagents and are token-heavy. Enable?')`
before POSTing; if declined, revert the checkbox. Save buttons POST to `/config` and
`/context`. Toggling `auditAsYouGo` also shows/hides the per-batch audit button
(Task 11) via a body class.

- [ ] **Step 4: Run tests**

Run: `node --test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: settings panel (config toggles + context.md) (D)"
```

---

### Task 11: On-demand audit — button, signal, annotate badge (E)

**Files:**
- Modify: `detective.mjs` (`serveLive` `/signal` accepts `kind:"audit"` and relays
  `other`; new `POST /ctl/annotate` → `annotate` SSE; client audit button, badge,
  `[dismiss]`/`[ask me]`)
- Test: `test/serve.test.mjs`

**Interfaces:**
- Consumes: `signal` plumbing, `state.batches`.
- Produces:
  - `POST /signal { kind:"audit", batch, qid?, other }` → pending `signal` event
    carrying `other` verbatim.
  - `POST /ctl/annotate { qid, level, text }` → broadcast `annotate` SSE
    `{ qid, level, text }`; non-destructive (does NOT delete `state.answers[qid]`).
  - Client: an `⚙ audit this` button per batch (visible only when body has class
    `audit-on`) posts `kind:"audit"` with `other` = joined per-question `other`/chip
    text for the batch. `annotate` event appends a `.qbadge` with `[dismiss]` and
    `[ask me]` to the question.

- [ ] **Step 1: Write the failing test**

```javascript
import { serveLive } from '../detective.mjs';

test('audit signal carries the user text; annotate broadcasts', async () => {
  let base;
  const done = serveLive({ port: 8903, onListen: (u, p) => { base = `http://127.0.0.1:${p}`; } });
  while (!base) await new Promise((r) => setTimeout(r, 10));
  try {
    await fetch(`${base}/ctl/push`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ questions: [{ id: 'q', text: 't', options: [{ id: 'a', label: 'A' }] }] }) });
    await fetch(`${base}/signal`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ batch: 0, kind: 'audit', other: 'watch the auth flow' }) });
    const w = await (await fetch(`${base}/ctl/wait?timeout=2`)).json();
    const sig = w.events.find((e) => e.type === 'signal' && e.kind === 'audit');
    assert.ok(sig);
    assert.equal(sig.other, 'watch the auth flow');
    const a = await fetch(`${base}/ctl/annotate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ qid: 'q', level: 'warn', text: 'rotation unhandled' }) });
    assert.equal(a.status, 200);
  } finally { await fetch(`${base}/ctl/finish`, { method: 'POST', body: '{}' }); }
  await done;
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/serve.test.mjs`
Expected: FAIL — audit kind not relayed with `other`; `/ctl/annotate` 404.

- [ ] **Step 3: Implement**

The existing `/signal` handler already relays `other` for any `kind` — confirm
`kind:"audit"` flows through unchanged (it does). Add the annotate endpoint:

```javascript
if (req.method === 'POST' && p === '/ctl/annotate') {
  readBody(req).then((body) => {
    let d = {}; try { d = JSON.parse(body || '{}'); } catch {}
    if (!d.qid || typeof d.text !== 'string') { json(400, { error: 'annotate needs { qid, text, level? }' }); return; }
    broadcast('annotate', { qid: d.qid, level: d.level === 'serious' ? 'serious' : 'warn', text: d.text });
    json(200, { ok: true });
  });
  return;
}
```

Client (`renderLiveShell`): in `renderBatchHtml`'s `.cont` (or via `addActions`) add
an `⚙ audit this` button shown only under `body.audit-on`; its click gathers the
batch's `other`/chip text and posts `/signal` with `kind:'audit', batch:id, other`.
Add an `annotate` SSE handler:

```javascript
es.addEventListener('annotate',function(e){
  const d=JSON.parse(e.data);
  const q=feed.querySelector('.question[data-qid="'+d.qid+'"]');if(!q)return;
  const b=document.createElement('div');b.className='qbadge '+(d.level||'warn');
  b.innerHTML='⚠ '+d.text.replace(/[<>&]/g,'')+' <button type="button" class="bdismiss">dismiss</button> <button type="button" class="baskme">ask me</button>';
  b.querySelector('.bdismiss').onclick=function(){b.remove();};
  b.querySelector('.baskme').onclick=function(){post('/signal',{batch:batchOf(q),qid:d.qid,kind:'askme',note:d.text,other:''});b.remove();};
  q.appendChild(b);stampUpdated(q);showToast('audit note added','');
});
```

Add `.qbadge{...}` styling to `STYLES`. Badges never disable submit. `askme` signals
are handled Claude-side (push a follow-up).

- [ ] **Step 4: Run tests**

Run: `node --test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: on-demand audit button + /ctl/annotate badges ([dismiss]/[ask me]) (E)"
```

---

### Task 12: Fix once/demo signal drain + SKILL.md behavior (E, G)

**Files:**
- Modify: `detective.mjs` (`runInterview` `--once`/`--demo` path: iterate all events)
- Modify: `SKILL.md` (behavior rules)
- Test: `test/detective.test.mjs` (n/a for docs; add a note-only assertion is skipped)

**Interfaces:**
- Consumes: `wait.events` array.
- Produces: the demo/once path returns all pending events, not just the first signal.

- [ ] **Step 1: Change the once/demo drain**

In `runInterview`, replace the `.find` single-signal handling with iterate-all:

```javascript
const events = wait.events || [];
const signals = events.filter((e) => e.type === 'signal');
let output;
if (signals.length) {
  output = { pending: signals };
  await fetch(`${base}/ctl/finish`, { method: 'POST', body: '{}' }).catch(() => {});
} else {
  output = await (await fetch(`${base}/ctl/finish`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
}
```

- [ ] **Step 2: Run tests**

Run: `node --test`
Expected: PASS (existing demo/once tests still pass; `pending` is now an array).

- [ ] **Step 3: Update SKILL.md**

Add/adjust these rules in `SKILL.md`:
- **Prioritize "Other / add nuance":** whenever an answer's `other` (string or
  array) is non-empty, run a quick think/review cycle on it before continuing.
- **Always author both hints:** every question needs a `why` and every option a
  `pro`/`hint` (mirrors `requireHints`, default on).
- **Reworks/audit are in-place:** use `update`/`annotate`, never `push`, to rework or
  annotate an existing question.
- **Drain all `wait` events:** iterate every event returned by `wait`, not just the
  first — multiple live triggers arrive as one array.
- **Audit orchestration:** on a `kind:"audit"` signal (with optional `other` steer),
  spawn unbiased Sonnet-5 subagent(s) to hunt problems/gotchas/logic faults/
  hallucinations, then `annotate` each concern (non-blocking). On a `kind:"askme"`
  signal, push a targeted follow-up question.
- **forceVisual authoring:** author compact inline-SVG/ASCII visuals; set
  `visual:false` only when a diagram truly adds nothing.
- **Read `context.md` first:** treat `~/.claude/skills/claude-detective/context.md`
  as highest-priority guidance.

Also update the "What comes back" section: `other` is a `string[]` for `multi`.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: drain all wait signals; SKILL.md behavior rules (nuance, hints, audit) (E,G)"
```

---

## Self-Review

**Spec coverage:**
- A Rebrand → Task 1. B1 → Task 2. B2 → Task 3. C1/C2 → Task 4. C3 → Task 6.
  C4 → Task 5. D config/endpoints → Task 7; requireHints → Task 8; forceVisual →
  Task 9; settings panel + context.md → Task 10. E audit (button, signal+other,
  annotate, ask-me) → Task 11; once/demo drain + audit orchestration → Task 12.
  F endpoints/session → Tasks 2, 7, 10, 11. G SKILL.md → Task 12. All covered.
- Alias/symlink is documented in Task 1 (SKILL.md note); creating the actual old-dir
  symlink is a deploy step noted there, not code.

**Placeholder scan:** No TBD/TODO; every code step shows concrete code and exact
commands. UI-string tasks assert on the rendered client string so they remain
testable without a browser.

**Type consistency:** `loadConfig`/`saveConfig`/`configPath`/`contextPath`/
`loadContext`/`saveContext`/`isSessionLive`/`PKG_NAME`/`renderLiveShellForTest` are
each defined once (Tasks 1,2,7,10) and referenced consistently. `validateQuestions`/
`normalizeQuestions` gain a second `opts` arg (Tasks 8,9) used the same way in
`/ctl/push`. `other` is `string` for single/yesno and `string[]` for multi
everywhere (Task 5 + Task 12 docs). Signal kinds: `rethink`/`research`/`more`/
`audit`/`askme`. SSE events: `batch`/`qupdate`/`retract`/`status`/`finish`/`annotate`.

## Non-goals

- GitHub repo/npx rename (manual follow-up).
- Automatic/debounced audit passes (explicitly rejected).
- Any new runtime dependency or build step.
