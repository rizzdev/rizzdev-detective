import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateQuestions,
  normalizeQuestions,
  loadQuestions,
  renderPage,
  normalizeResults,
} from '../detective.mjs';

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
  assert.throws(() => validateQuestions(bad), /"single", "multi", or "yesno"/);
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
  assert.throws(() => validateQuestions({ questions: [{ id: 'q', text: 't', type: 'dropdown', options: [{ id: 'a', label: 'A' }] }] }), /"single", "multi", or "yesno"/);
  assert.doesNotThrow(() => validateQuestions({ questions: [{ id: 'q', text: 't', type: 'yesno' }] }));
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
