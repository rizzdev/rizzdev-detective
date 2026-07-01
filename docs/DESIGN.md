# rizzdev-detective — Design Spec

**Date:** 2026-07-01
**Status:** Approved design, pre-implementation
**Skill home:** `rizzdev-skills/skills/rizzdev-detective/` (source of truth; symlinked into `~/.claude/skills/` by the repo's install script)

## Purpose

A skill that lets Claude conduct a structured, multiple-choice "interview" with the user through a polished local web page instead of asking questions one-at-a-time in chat. Triggered when the user asks for "a lot of questions" or runs `/rizzdev-detective`.

Claude produces a batch of questions (with per-option pros/cons and a per-question recommendation), serves them in the browser, blocks until the user submits, then reads the answers back as structured JSON and continues the work.

This is the "many questions at once, with my reasoning attached" tool — complementary to `rizzdev-quickstorm` (loose chat) and `superpowers:brainstorming` (one-at-a-time dialogue).

## When to Use

- The user asks for a lot of questions, a questionnaire, a survey, or "just ask me everything at once".
- The user runs `/rizzdev-detective`.
- Claude has accumulated many decisions to resolve and wants the user to triage them in one pass with the tradeoffs visible.

**When NOT to use:**
- A single quick question → just ask in chat.
- Open-ended exploratory dialogue where each answer reshapes the next question → use `superpowers:brainstorming`.

## Architecture

**Packaging:** A single self-contained Node script, `detective.mjs`, with **zero npm dependencies** (built-in `http`, `fs`, `child_process` only). The HTML/CSS/JS for the page is embedded in the script as template strings. Plus `SKILL.md`. Node 22+ is available on all target machines (Windows + WSL), keeping this a one-file, git-synced skill with no build step or `pip install`.

*Alternatives considered:* Python stdlib `http.server` (also zero-dep, but splits HTML/logic awkwardly); Bun (fast, not guaranteed present everywhere). Node chosen for portability + single-file cleanliness.

**Interaction flow (one-shot blocking):**

1. Claude writes a `questions.json` (schema below) to a temp path (the session scratchpad dir).
2. Claude runs `node detective.mjs <questions.json> [--out <results.json>]`.
3. The script:
   - Picks a free port (default 8787, incrementing on `EADDRINUSE`).
   - Serves the single-page form.
   - Attempts to auto-open the browser via the first available of `wslview`, `explorer.exe`, `xdg-open`, `open`; **always** prints the URL to stderr as a fallback.
   - Blocks (keeps the process alive) waiting for a submit.
4. The user answers in the page and clicks **Submit**.
5. The server receives the POST, writes `results.json`, prints the results JSON to **stdout**, responds to the browser with a "You can close this tab" confirmation page, and exits `0`.
6. Claude reads stdout / `results.json` and continues.

**Termination / edge cases:**
- Partial submissions allowed — unanswered questions come back with empty `selected`. No client-side "required" enforcement in v1.
- If the user never submits, the command runs until Ctrl-C'd. (No hard timeout in v1; Claude can kill the background process.)
- `EADDRINUSE` → try next port, up to a small retry cap, then error out clearly.
- Malformed `questions.json` → exit non-zero with a clear parse error on stderr.

## The Page

Single scrollable form. Polished styling: dark mode, readable typography, comfortable spacing, and a **sticky submit bar** at the bottom.

- Optional top-level `title` rendered as the page heading.
- Questions optionally **grouped into sections** with section headings; a flat top-level `questions` array is also supported (no sections).
- Each question renders:
  - The question **text**.
  - A **"Why / The problem"** line beneath the text (from `why`) — what this answer unblocks.
  - A **recommendation** callout (from `recommendation`) — Claude's suggested pick + reasoning, visually distinct.
  - The **options** as **radio** (`type: "single"`) or **checkbox** (`type: "multi"`) inputs. Each option may show a **pro** line and/or a **con** line beneath its label.
  - An always-available **"Other"** free-text input (when `allowOther` is true).
- One **global "anything else?"** free-text box at the bottom of the form.
- Submit button in the sticky bar.

## Data Contracts

### Questions schema (Claude → server)

```json
{
  "title": "optional page heading",
  "sections": [
    {
      "title": "Auth",
      "questions": [
        {
          "id": "q1",
          "text": "Which auth model for v1?",
          "why": "Determines how much of week 1 goes to plumbing vs features.",
          "type": "single",
          "recommendation": { "optionId": "a", "why": "Fastest path to a working v1." },
          "options": [
            { "id": "a", "label": "Pasted long-lived token", "pro": "No OAuth work", "con": "Manual rotation" },
            { "id": "b", "label": "OAuth", "pro": "Clean UX", "con": "Weeks of work" }
          ],
          "allowOther": true
        }
      ]
    }
  ]
}
```

Field rules:
- `title` — optional string.
- Top level has **either** `sections` (array of `{ title, questions }`) **or** a flat `questions` array. If both present, `sections` wins.
- Question:
  - `id` — required, unique string (used as the results key).
  - `text` — required string.
  - `why` — optional string (the "Why / The problem" line).
  - `type` — `"single"` | `"multi"` | `"yesno"`. Defaults to `"single"` if omitted.
    `"yesno"` auto-generates Yes/No options (overridable), renders as compact pills,
    has single-select result semantics, and defaults `allowOther` to `false`.
  - Long option lists (~15+) render as a dense single-line list; no dropdown/search/grid.
  - `recommendation` — optional `{ optionId?: string, why?: string }`. `optionId` highlights the recommended option; `why` shows reasoning.
  - `options` — required non-empty array of `{ id, label, pro?, con? }`. `id` unique within the question.
  - `allowOther` — optional boolean, default `true`. When true, renders the "Other" text box.

### Results schema (server → Claude)

```json
{
  "answers": {
    "q1": { "selected": ["a"], "other": "" }
  },
  "globalNote": "free-text from the anything-else box",
  "submittedAt": "2026-07-01T13:05:00.000Z"
}
```

- `answers` — keyed by question `id`. Each value: `{ selected: string[], other: string }`.
  - `selected` — array of chosen option `id`s (0 or 1 for single, 0..n for multi).
  - `other` — the "Other" text (empty string if unused/disabled).
- `globalNote` — the global free-text box (empty string if unused).
- `submittedAt` — ISO timestamp set at submit time.

## Components (isolation)

- **`detective.mjs`** — one file, three responsibilities kept as separate functions:
  1. `loadQuestions(path)` — read + validate the questions JSON; throw clear errors.
  2. `renderPage(questions)` — pure function: questions object → HTML string (embeds CSS/JS).
  3. `serve(questions, opts)` — HTTP server: GET `/` returns the page; POST `/submit` parses the body into the results schema, writes/prints results, sends the confirmation page, and resolves so `main` can exit. Handles port selection and browser-open.
- **`SKILL.md`** — trigger conditions, how Claude authors a good questions batch (always fill `why`, pros/cons, and a recommendation where it has a lean), the exact run command, and how to consume results.

## Testing

- **Schema validation:** feed a malformed JSON and a valid JSON; assert clear error vs clean load.
- **Render:** `renderPage` on a fixture with sections, single + multi, pros/cons, recommendation, `allowOther:false` → assert the HTML contains the expected controls and omits the Other box where disabled.
- **Round-trip (manual/scripted):** POST a crafted form body to `/submit`; assert the emitted `results.json` matches the results schema (correct `selected` arrays, `other`, `globalNote`, `submittedAt` present).
- **Port fallback:** occupy the default port; assert the server binds the next one and prints the URL.

## Out of Scope (v1 / YAGNI)

- Persistent / long-running server, live push (websocket/SSE), multi-round without restart.
- One-at-a-time wizard presentation.
- Pure open-text-only questions (the "Other" box + global note cover free-form needs).
- Required-field enforcement.
- Auth / remote access — localhost only.
