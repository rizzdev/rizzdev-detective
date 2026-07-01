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

Recognize the flags from the `/rizzdev-detective` args and from natural phrasing
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

## Live mode (`--live`) — adaptive interviews

For a decision tree that branches on the user's answers, run a **live interview**:
push a batch, wait for the answers, then push the *next* questions based on what
they said — all in one open browser tab.

1. **Start the persistent server in the background** (it does not exit until you
   `finish`), then read the URL and share it:

   ```bash
   node ~/.claude/skills/rizzdev-detective/detective.mjs --live --out <transcript.json>
   ```

2. **Drive it** with control sub-commands (each a short, separate call):

   - `push <batch.json>` — inject a question batch (same schema as one-shot; may
     include `title`/`findings`). It animates into the page. Batch independent
     knobs together; keep question `id`s unique across the whole interview.
   - `wait [--timeout SEC]` — **run this in the background**; it blocks until the
     user acts, then prints the events. React to each:
     - `{type:"answer", batch, answers, revised?}` — they submitted a batch. If
       `revised:true`, they changed an earlier answer → `retract --from <batchId>`
       to drop the now-stale later batches, then push a fresh branch.
     - `{type:"signal", batch, qid, kind, note, other}` — a pushback action:
       `rethink` (repush bolder/different options; honor `note`), `research` (do
       a deep + online pass scoped to that question, then repush with updated
       findings/options), `more` (append options). `other` carries whatever the
       user had typed in that question's "Other" box when they hit the button —
       always read it; they may have used it to hand you information.
     - `{type:"ended"}` — the user hit "end interview" → `finish`.
   - `retract --from <batchId>` — drop every batch after `batchId` (and their
     answers). Use after a revised upstream answer, or a `rethink`/`research`.
   - `finish [--out <file>]` — end the interview; prints the full transcript and
     shuts the server down.

3. **The loop:** push → (background) wait → react (push / retract) → wait → …
   → finish. Tell the user you're researching/thinking between pushes.

Use live mode when questions branch; use the plain one-shot form when they don't.

## Notes

- Zero dependencies; needs Node 22+. Localhost only.
- One-shot run = one interview. Live mode = one persistent session; `finish` ends it.
- If the browser doesn't auto-open, share the printed URL with the user.
