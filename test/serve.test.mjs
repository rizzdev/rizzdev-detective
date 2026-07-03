import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { normalizeQuestions, serve, serveLive, isSessionLive } from '../detective.mjs';
import { writeFileSync } from 'node:fs';

// Isolate config/context writes to a temp skills dir (never touch the real ~/.claude).
// Each config-touching test gets a fresh dir so persisted toggles don't bleed across.
let seq = 0;
const freshSkillsDir = () => { process.env.CLAUDE_SKILLS_DIR = `${tmpdir()}/cd-test-skills-${Math.floor(performance.now())}-${seq++}`; };
freshSkillsDir();

test('audit signal carries the user text; annotate broadcasts', async () => {
  freshSkillsDir();
  let base;
  const done = serveLive({ port: 8903, onListen: (u, p) => { base = `http://127.0.0.1:${p}`; } });
  while (!base) await new Promise((r) => setTimeout(r, 10));
  try {
    // isolate from other tests that may have persisted config toggles
    await fetch(`${base}/config`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requireHints: false }) });
    await fetch(`${base}/ctl/push`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ questions: [{ id: 'q', text: 't', options: [{ id: 'a', label: 'A' }] }] }) });
    await fetch(`${base}/signal`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ batch: 0, kind: 'audit', other: 'watch the auth flow' }) });
    const w = await (await fetch(`${base}/ctl/wait?timeout=2`)).json();
    const sig = w.events.find((e) => e.type === 'signal' && e.kind === 'audit');
    assert.ok(sig, 'audit signal present');
    assert.equal(sig.other, 'watch the auth flow');
    const a = await fetch(`${base}/ctl/annotate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ qid: 'q', level: 'warn', text: 'rotation unhandled' }) });
    assert.equal(a.status, 200);
  } finally { await fetch(`${base}/ctl/finish`, { method: 'POST', body: '{}' }); }
  await done;
});

test('context round-trips via /context and /ctl/context', async () => {
  freshSkillsDir();
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

test('POST /config persists and /ctl/state reflects it', async () => {
  freshSkillsDir();
  let base;
  const done = serveLive({ port: 8901, onListen: (u, p) => { base = `http://127.0.0.1:${p}`; } });
  while (!base) await new Promise((r) => setTimeout(r, 10));
  try {
    await fetch(`${base}/config`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ auditAsYouGo: true }) });
    const st = await (await fetch(`${base}/ctl/state`)).json();
    assert.equal(st.config.auditAsYouGo, true);
    assert.equal(st.config.requireHints, true); // default preserved
  } finally {
    await fetch(`${base}/ctl/finish`, { method: 'POST', body: '{}' });
  }
  await done;
});

test('loop mode: state reports loop and /ctl/push rejects a >5-question round', async () => {
  freshSkillsDir();
  let base;
  const done = serveLive({ port: 8904, loop: true, onListen: (u, p) => { base = `http://127.0.0.1:${p}`; } });
  while (!base) await new Promise((r) => setTimeout(r, 10));
  try {
    await fetch(`${base}/config`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requireHints: false }) });
    const st = await (await fetch(`${base}/ctl/state`)).json();
    assert.equal(st.loop, true);
    const six = { questions: Array.from({ length: 6 }, (_, i) => ({ id: `q${i}`, text: 't', options: [{ id: 'a', label: 'A' }] })) };
    const r = await fetch(`${base}/ctl/push`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(six) });
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /5 questions per round/);
  } finally {
    await fetch(`${base}/ctl/finish`, { method: 'POST', body: '{}' });
  }
  await done;
});

test('one-per-chat: isSessionLive is the guard — live for an up server, clear once it finishes', async () => {
  freshSkillsDir();
  let base, port;
  const done = serveLive({ port: 8905, onListen: (u, p) => { base = `http://127.0.0.1:${p}`; port = p; } });
  while (!base) await new Promise((r) => setTimeout(r, 10));
  // The chat-keyed session file runInterview would write.
  const sp = `${tmpdir()}/cd-test-chat-${Math.floor(performance.now())}.json`;
  writeFileSync(sp, JSON.stringify({ port, url: `${base}/`, pid: process.pid }));
  const cur = await isSessionLive(sp);
  assert.equal(cur.live, true); // a second interview on the same chat would be blocked here
  await fetch(`${base}/ctl/finish`, { method: 'POST', body: '{}' });
  await done;
  const after = await isSessionLive(sp); // server down → same chat may start fresh
  assert.equal(after.live, false);
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
