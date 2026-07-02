import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateQuestions,
  normalizeQuestions,
  loadQuestions,
  renderPage,
  renderBatchHtml,
  renderQuestionHtml,
  replaceQuestionHtml,
  normalizeResults,
  DEMO_QUESTIONS,
  PKG_NAME,
  isSessionLive,
} from '../detective.mjs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

test('package identity is claude-detective', () => {
  assert.equal(PKG_NAME, 'claude-detective');
});

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

test('the built-in --demo questions are valid and render', () => {
  const n = normalizeQuestions(DEMO_QUESTIONS);
  assert.ok(n.sections.length >= 1);
  assert.doesNotThrow(() => renderPage(n));
});

// --- validation / normalization / loading ---------------------------------

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
  assert.throws(() => validateQuestions(bad), /"single", "multi", "yesno", or "rank"/);
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

test('normalizeQuestions expands yesno into Yes/No with single semantics + pills render + no Other', () => {
  const n = normalizeQuestions({ questions: [{ id: 'ok', text: 'Proceed?', type: 'yesno' }] });
  const q = n.sections[0].questions[0];
  assert.equal(q.type, 'single');
  assert.equal(q.render, 'pills');
  assert.deepEqual(q.options.map((o) => o.id), ['yes', 'no']);
  assert.equal(q.allowOther, false);
});

test('yesno respects explicit options and an opt-in Other box', () => {
  const n = normalizeQuestions({ questions: [
    { id: 'ok', text: 'Ship?', type: 'yesno', allowOther: true,
      options: [{ id: 'ship', label: 'Ship it' }, { id: 'hold', label: 'Hold' }] },
  ] });
  const q = n.sections[0].questions[0];
  assert.deepEqual(q.options.map((o) => o.id), ['ship', 'hold']);
  assert.equal(q.allowOther, true);
});

test('validateQuestions rejects an unknown type but accepts yesno', () => {
  assert.throws(() => validateQuestions({ questions: [{ id: 'q', text: 't', type: 'dropdown', options: [{ id: 'a', label: 'A' }] }] }), /"single", "multi", "yesno", or "rank"/);
  assert.doesNotThrow(() => validateQuestions({ questions: [{ id: 'q', text: 't', type: 'yesno' }] }));
});

test('normalizeQuestions keeps a valid findings block and defaults source labels to ref', () => {
  const n = normalizeQuestions({
    findings: { summary: 'Repo uses D1.', sources: [{ ref: 'https://x.test/d1' }, { label: 'schema', ref: 'src/db.ts:4' }, { bad: 1 }] },
    questions: [{ id: 'q', text: 't', options: [{ id: 'a', label: 'A' }] }],
  });
  assert.equal(n.findings.summary, 'Repo uses D1.');
  assert.deepEqual(n.findings.sources, [
    { label: 'https://x.test/d1', ref: 'https://x.test/d1' },
    { label: 'schema', ref: 'src/db.ts:4' },
  ]);
});

test('normalizeQuestions drops a malformed findings block', () => {
  assert.equal(normalizeQuestions({ findings: { sources: [] }, questions: [{ id: 'q', text: 't', options: [{ id: 'a', label: 'A' }] }] }).findings, undefined);
  assert.equal(normalizeQuestions({ questions: [{ id: 'q', text: 't', options: [{ id: 'a', label: 'A' }] }] }).findings, undefined);
});

test('renderPage renders a findings panel, linkifies URLs, and tags code refs', () => {
  const html = renderPage(normalizeQuestions({
    findings: { summary: 'See https://nextjs.org/docs and src/auth.ts:20 for context.', sources: [{ label: 'auth', ref: 'https://nextjs.org/docs' }] },
    questions: [{ id: 'q', text: 't', options: [{ id: 'a', label: 'A' }] }],
  }));
  assert.match(html, /class="findings"/);
  assert.match(html, /<a href="https:\/\/nextjs\.org\/docs"[^>]*>https:\/\/nextjs\.org\/docs<\/a>/);
  assert.match(html, /<span class="ref">src\/auth\.ts:20<\/span>/);
});

test('renderPage linkifies a URL inside a recommendation why without mangling it', () => {
  const html = renderPage(normalizeQuestions({ questions: [{
    id: 'q', text: 't', recommendation: { optionId: 'a', why: 'per https://a.test:8080/x' },
    options: [{ id: 'a', label: 'A' }] }] }));
  assert.match(html, /<a href="https:\/\/a\.test:8080\/x"/);
  assert.doesNotMatch(html, /<span class="ref">https/);
});

test('renderPage omits the findings panel when absent', () => {
  const html = renderPage(normalizeQuestions({ questions: [{ id: 'q', text: 't', options: [{ id: 'a', label: 'A' }] }] }));
  assert.doesNotMatch(html, /class="findings"/);
});

test('renderPage flows a long list of short options into two columns', () => {
  const opts = Array.from({ length: 8 }, (_, i) => ({ id: `o${i}`, label: `Opt ${i}` }));
  const html = renderPage(normalizeQuestions({ questions: [{ id: 'long', text: 'pick', options: opts }] }));
  assert.match(html, /class="options two-col"/);
});

test('renderPage keeps one column when options have pros/cons or long labels', () => {
  const withPro = renderPage(normalizeQuestions({ questions: [{ id: 'p', text: 'x',
    options: Array.from({ length: 8 }, (_, i) => ({ id: `o${i}`, label: `Opt ${i}`, con: 'nope' })) }] }));
  assert.doesNotMatch(withPro, /class="options two-col"/);
  const longLabel = renderPage(normalizeQuestions({ questions: [{ id: 'l', text: 'x',
    options: [...Array.from({ length: 7 }, (_, i) => ({ id: `o${i}`, label: `Opt ${i}` })),
      { id: 'big', label: 'This is a very long option label that should force a single column' }] }] }));
  assert.doesNotMatch(longLabel, /class="options two-col"/);
});

test('renderPage keeps a short list (fewer than 6) in one column', () => {
  const html = renderPage(normalizeQuestions({ questions: [{ id: 's', text: 'x',
    options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }] }] }));
  assert.doesNotMatch(html, /class="options two-col"/);
});

test('renderPage renders yesno as pills, not stacked option cards', () => {
  const html = renderPage(normalizeQuestions({ questions: [{ id: 'ok', text: 'Proceed?', type: 'yesno' }] }));
  assert.match(html, /class="pills"/);
  assert.match(html, /class="pill"><input type="radio"[^>]*data-qid="ok"[^>]*value="yes"/);
  assert.match(html, /value="no"/);
});

// --- rendering ------------------------------------------------------------

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

test('renderQuestion exposes the recommended option id (for "you decide")', () => {
  const html = renderPage(normalizeQuestions({ questions: [{ id: 'q', text: 't',
    recommendation: { optionId: 'a' }, options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }] }));
  assert.match(html, /data-qid="q" data-rec="a"/);
});

test('renderPage wires keyboard-first navigation (hint + script)', () => {
  const html = renderPage(normalizeQuestions({ questions: [{ id: 'a', text: 't', options: [{ id: 'x', label: 'X' }] }] }));
  assert.match(html, /class="kbhint"/);
  assert.match(html, /kfocusScan/);
  assert.match(html, /id="kbhelp"/);
});

// --- drag-to-rank ---------------------------------------------------------

test('normalizeQuestions handles the rank type (ordered semantics, no Other)', () => {
  const n = normalizeQuestions({ questions: [{ id: 'r', text: 'order', type: 'rank',
    options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }] });
  const q = n.sections[0].questions[0];
  assert.equal(q.type, 'rank');
  assert.equal(q.render, 'rank');
  assert.equal(q.allowOther, false);
});

test('validateQuestions accepts rank and still rejects unknown types', () => {
  assert.doesNotThrow(() => validateQuestions({ questions: [{ id: 'r', text: 't', type: 'rank', options: [{ id: 'a', label: 'A' }] }] }));
  assert.throws(() => validateQuestions({ questions: [{ id: 'r', text: 't', type: 'slider', options: [{ id: 'a', label: 'A' }] }] }), /"single", "multi", "yesno", or "rank"/);
});

test('renderPage renders a rank list with draggable rows', () => {
  const html = renderPage(normalizeQuestions({ questions: [{ id: 'r', text: 'order', type: 'rank',
    options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }] }));
  assert.match(html, /class="rank" data-qid="r"/);
  assert.match(html, /class="rankrow" draggable="true" data-oid="a"/);
});

test('normalizeQuestions carries priority only on rank questions', () => {
  const n = normalizeQuestions({ questions: [
    { id: 'r', text: 't', type: 'rank', priority: true, options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] },
    { id: 's', text: 't2', options: [{ id: 'x', label: 'X' }] },
  ] });
  assert.equal(n.sections[0].questions[0].priority, true);
  assert.equal(n.sections[0].questions[1].priority, undefined);
});

test('renderPage marks a priority rank list and gives sections an accent color', () => {
  const html = renderPage(normalizeQuestions({ sections: [{ title: 'p', questions: [
    { id: 'r', text: 't', type: 'rank', priority: true, options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] },
  ] }] }));
  assert.match(html, /class="rank rank-prio"/);
  assert.match(html, /class="section" style="--sc:#[0-9a-f]{6}"/);
});

test('normalizeResults preserves rank order as the full selected array', () => {
  const nq = normalizeQuestions({ questions: [{ id: 'r', text: 'o', type: 'rank',
    options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }] }] });
  const res = normalizeResults({ answers: { r: { selected: ['c', 'a', 'b'] } } }, nq, 'T');
  assert.deepEqual(res.answers.r.selected, ['c', 'a', 'b']);
});

// --- live batch rendering -------------------------------------------------

test('renderBatchHtml wraps a batch with an id, its panels, and a continue button', () => {
  const nq = normalizeQuestions({ sections: [{ title: 'auth', questions: [
    { id: 'a', text: 'Which?', options: [{ id: 'x', label: 'X' }, { id: 'y', label: 'Y' }] },
  ] }] });
  const html = renderBatchHtml(nq, 3);
  assert.match(html, /class="batch" data-batch="3"/);
  assert.match(html, /class="section-title"/);
  assert.match(html, /data-qid="a"[^>]*value="x"/);
  assert.match(html, /onclick="sendBatch\(3\)"/);
});

test('renderBatchHtml renders a live findings briefing when present', () => {
  const nq = normalizeQuestions({ findings: { summary: 'ctx' }, questions: [{ id: 'a', text: 't', options: [{ id: 'x', label: 'X' }] }] });
  assert.match(renderBatchHtml(nq, 0), /class="findings"/);
});

// --- in-place single-question update --------------------------------------

test('renderQuestionHtml renders one .question section for the given id', () => {
  const html = renderQuestionHtml({ id: 'auth', text: 'Which auth?', options: [{ id: 't', label: 'Token' }] });
  assert.match(html, /<section class="question" data-qid="auth"/);
  assert.match(html, /data-qid="auth"[^>]*value="t"/);
  // exactly one question section — it's a single-question fragment
  assert.equal((html.match(/class="question"/g) || []).length, 1);
});

test('renderQuestionHtml forces the id even if the raw question disagrees', () => {
  const html = renderQuestionHtml({ id: 'ignored', text: 't', options: [{ id: 'x', label: 'X' }] }, 'auth');
  assert.match(html, /data-qid="auth"/);
  assert.doesNotMatch(html, /data-qid="ignored"/);
});

test('replaceQuestionHtml swaps only the targeted question inside a batch, leaving siblings intact', () => {
  const nq = normalizeQuestions({ sections: [{ title: 'auth', questions: [
    { id: 'a', text: 'first', options: [{ id: 'x', label: 'X' }, { id: 'y', label: 'Y' }] },
    { id: 'b', text: 'second', options: [{ id: 'p', label: 'P' }, { id: 'q', label: 'Q' }] },
  ] }] });
  const batch = renderBatchHtml(nq, 2);
  const fresh = renderQuestionHtml({ id: 'b', text: 'second — reworked', options: [{ id: 'p2', label: 'P2' }] });
  const out = replaceQuestionHtml(batch, 'b', fresh);
  assert.match(out, /second — reworked/);
  assert.match(out, /value="p2"/);
  assert.doesNotMatch(out, /value="q"/); // old option gone
  assert.match(out, /first/);            // sibling untouched
  assert.match(out, /value="x"/);        // sibling option untouched
  assert.match(out, /class="batch" data-batch="2"/); // wrapper preserved
});

test('replaceQuestionHtml is a no-op when the qid is absent', () => {
  const nq = normalizeQuestions({ questions: [{ id: 'a', text: 't', options: [{ id: 'x', label: 'X' }] }] });
  const batch = renderBatchHtml(nq, 0);
  assert.equal(replaceQuestionHtml(batch, 'nope', '<section></section>'), batch);
});

test('replaceQuestionHtml handles regex-special characters in the qid', () => {
  const nq = normalizeQuestions({ questions: [{ id: 'a.b(c)', text: 't', options: [{ id: 'x', label: 'X' }] }] });
  const batch = renderBatchHtml(nq, 0);
  const fresh = renderQuestionHtml({ id: 'a.b(c)', text: 'new', options: [{ id: 'z', label: 'Z' }] });
  const out = replaceQuestionHtml(batch, 'a.b(c)', fresh);
  assert.match(out, /new/);
  assert.match(out, /value="z"/);
});

// --- results --------------------------------------------------------------

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
