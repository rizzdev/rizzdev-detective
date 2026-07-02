import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { normalizeQuestions, serve, serveLive } from '../detective.mjs';

// Isolate config/context writes to a temp skills dir (never touch the real ~/.claude).
process.env.CLAUDE_SKILLS_DIR = `${tmpdir()}/cd-test-skills-${Math.floor(performance.now())}`;

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
