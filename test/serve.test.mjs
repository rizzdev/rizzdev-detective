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
