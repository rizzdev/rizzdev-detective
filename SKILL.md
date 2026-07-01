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
   - Question: `id` (unique), `text`, `why?`, `type` (`single` | `multi` | `yesno`, default `single`),
     `recommendation?` (`{optionId?, why?}`), `options` (`{id, label, pro?, con?}`), `allowOther?`.
   - **`type: "yesno"`** — shorthand for a yes/no question. `options` are optional
     (auto-generated as Yes/No; override them for custom two-choice labels like
     Ship/Hold). Renders as compact side-by-side pills. `allowOther` defaults to
     `false` here (opt in with `allowOther: true`). Result semantics are single-select.
   - **Long option lists (~15+)** need nothing special — just list the options; they
     render as a dense single-line list. Skip `pro`/`con` on such options to keep rows short.
   - `allowOther` defaults to `true` for `single`/`multi`, `false` for `yesno`.

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
