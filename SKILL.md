---
name: claude-detective
description: Use when the user asks for a lot of questions at once, a questionnaire, a survey, or runs /claude-detective. Serves Claude-authored multiple-choice questions (with per-option pros/cons and a per-question recommendation) in a polished local web page, blocks until the user submits, and returns their answers as structured JSON.
---

# claude-detective

## Overview

Instead of asking many questions one-at-a-time in chat, hand the user a whole
batch at once in a browser form and read their answers back as structured data.
Each question can carry a "why / the problem" line, per-option pros and cons,
and your recommended pick with reasoning — so the user triages fast with the
tradeoffs visible.

## When to Use

- The user asks for "a lot of questions", a questionnaire, a survey, or "ask me everything at once".
- The user runs `/claude-detective`.
- You have many decisions to resolve and want them triaged in one pass.

**When NOT to use:** a single quick question (just ask in chat), or open-ended
dialogue where each answer reshapes the next (use `superpowers:brainstorming`).

## Research first (`--deep` / `--online`)

Before authoring the questionnaire, **investigate — so the questions, option
pros/cons, and recommendations are grounded in reality, not guesses.** This is a
deep thinking pass: your job is to figure out the *best* answers, then present
them for the user to confirm.

Depth is additive:

- **Always (even with no flags):** review the **codebase** for context relevant
  to the decisions at hand.
- **`--deep`:** a *much* deeper dive/review first — more files, cross-cutting
  reading, harder reasoning.
- **`--online`:** also research the **web** (current docs, best practices, prior
  art, comparisons).
- **`--deep --online`:** double down on both.

Recognize the flags from the `/claude-detective` args and from natural phrasing
("go deep", "research this online first"). **How** you research is your call per
task — read inline, fan out `Explore` subagents, or use the `deep-research` /
Firecrawl skills — pick what fits the scope. Tell the user you're researching
before the form appears, and if `--online` tools aren't reachable, fall back to
codebase-only and say so in the findings.

Then surface what you learned in the form:

- Add a top-level **`findings`** block — a short briefing rendered as a panel at
  the top, plus the sources behind it.
- **Cite your recommendations.** Write source references right in `recommendation.why`
  (and in `pro`/`con` where useful). The page auto-links URLs and visually tags
  `path/to/file.ext:line` code refs — so just write them inline.

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
   - Question: `id` (unique), `text`, `why?`, `type` (`single` | `multi` | `yesno`, default `single`),
     `recommendation?` (`{optionId?, why?}`), `options` (`{id, label, pro?, con?}`), `allowOther?`.
   - **`type: "yesno"`** — shorthand for a yes/no question. `options` are optional
     (auto-generated as Yes/No; override them for custom two-choice labels like
     Ship/Hold). Renders as compact side-by-side pills. `allowOther` defaults to
     `false` here (opt in with `allowOther: true`). Result semantics are single-select.
   - **Long option lists (~15+)** need nothing special — just list the options; they
     render as a dense single-line list. Skip `pro`/`con` on such options to keep rows short.
   - `allowOther` defaults to `true` for `single`/`multi`, `false` for `yesno`.
   - **`findings?`** (optional, top level) — a research briefing:
     `{ "summary": "what you found…", "sources": [{ "label": "auth docs", "ref": "https://…" }, { "label": "schema", "ref": "src/db.ts:4" }] }`.
     Rendered as a panel at the top; `summary` keeps line breaks; URL `ref`s are
     clickable, non-URL `ref`s render as tagged code refs. Omit it if research
     turned up nothing notable. See "Research first" above.

2. **Start the interview in the background.** It's a persistent live server: it
   prints the URL to stderr, opens the browser, shows your first batch, and
   **does not return until you `finish`** — so run it in the background and drive
   it with the control sub-commands below.

   ```bash
   node ~/.claude/skills/claude-detective/detective.mjs <questions.json> --out <results.json> &
   ```

   (There's a legacy static one-page form behind `--static` if you ever want a
   plain non-interactive form with no live actions.)

3. **Drive it** with control sub-commands (each a short, separate call):

   - `wait [--timeout SEC]` — **run this in the background**; it blocks until the
     user acts, then prints the events. React to each (see below), then `wait`
     again. Loop until they submit / end.
   - `update <update.json>` — **replace ONE question in place** (see "live
     actions"). The rest of the page — every other answer in progress — is kept.
   - `push <batch.json>` — append a *new* question batch (same schema; may include
     `title`/`findings`). Use for adaptive follow-ups that branch on their
     answers. Keep question `id`s unique across the whole interview.
   - `retract --from <batchId>` — drop every batch *after* `batchId` (and their
     answers). Use only when an earlier answer changed and later batches are now
     stale — **not** for reworking a single question (use `update` for that).
   - `finish [--out <file>]` — end the interview; prints the full transcript and
     shuts the server down.

   **Events from `wait`:**
   - `{type:"answer", batch, answers, revised?}` — they submitted a batch. If
     `revised:true`, an earlier answer changed → `retract --from <batchId>` to
     drop now-stale later batches, then push a fresh branch. Otherwise push the
     next batch (if adaptive) or `finish` if you have what you need.
   - `{type:"signal", batch, qid, kind, note, other}` — a **live action** on one
     question (see next section). That single question is now locked/greyed in
     the UI showing "claude is reworking this…". Rework it and `update` it in
     place; the user keeps everything else they've filled in.
   - `{type:"ended"}` — they hit "end interview" → `finish`.

4. **The loop:** (background) wait → react (`update` a question / `push` a batch /
   `retract`) → wait → … → `finish`. Tell the user you're researching/thinking
   between reactions.

## Live actions — reworking ONE question in place

Each question shows a small action bar: `↳ you decide` · `↻ rethink` · `⌕ research`
· `＋ more`. `you decide` is handled entirely in the page (picks your rec, marks
it delegated). The other three send you a `signal` and **lock just that one
question** while you rework it — the whole page and all other answers stay put.

Respond by writing a small update file and running `update`:

```json
{ "qid": "auth", "question": {
    "text": "Which auth model for v1?",
    "type": "single",
    "recommendation": { "optionId": "oauth", "why": "…now that you flagged X" },
    "options": [ { "id": "oauth", "label": "OAuth", "pro": "…", "con": "…" } ],
    "allowOther": true
} }
```

```bash
node ~/.claude/skills/claude-detective/detective.mjs update <update.json>
```

The `question` uses the same schema as any question; its `id` is forced to `qid`
(you can omit it). The question swaps in place, unlocks, flashes, and a toast
confirms it. **The old answer for that question is cleared** (its options may have
changed) — everything else is untouched.

Handle each `kind`:
- **`rethink`** — repush bolder / genuinely different options; honor `note` (what
  they said is off).
- **`research`** — do a `--deep` + `--online` pass scoped to that one question,
  then update it with sharper options and reasoning.
- **`more`** — append additional options (keep the existing ones).

Always read `other`: it carries whatever the user had typed in that question's
"Other" box when they hit the button — they may have used it to hand you info.

## Reading the transcript

`finish` (and the backgrounded run's `--out`) gives you:

```json
{
  "answers": { "auth": { "selected": ["token"], "other": "" } },
  "globalNote": "any overall notes",
  "submittedAt": "2026-07-01T13:05:00.000Z"
}
```

`answers` is keyed by question `id`; `selected` holds chosen option ids (0–1 for
single/yesno, 0–n for multi, full order for rank); `other` is the per-question
free-text box; `answers[id].delegated` is `true` if they hit "you decide".
Unanswered questions come back with empty `selected`.

## Notes

- Zero dependencies; needs Node 22+. Localhost only.
- One run = one persistent interview session; `finish` ends it and shuts down the
  server. The control commands find that session automatically (via a session
  file), or pass `--port N` to target a specific one.
- Live actions (`rethink`/`research`/`more`) rework a single question in place —
  they never reload the page or discard the user's other answers. Reserve
  `retract` for genuinely stale downstream batches after a changed answer.
- If the browser doesn't auto-open, share the printed URL with the user.

> Renamed from `rizzdev-detective`. The old `/rizzdev-detective` command still works
> as a deprecated alias (symlink the old skill dir to this one); it will be removed
> in a future release.
