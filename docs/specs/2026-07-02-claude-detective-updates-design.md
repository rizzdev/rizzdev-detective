# claude-detective — updates design (2026-07-02)

Spec for a batch of updates to the interactive questionnaire skill (currently
`rizzdev-detective`, being renamed to `claude-detective`). One spec, phased plan.

Grounding: the whole tool is a single zero-dependency `detective.mjs` (Node ≥ 22,
localhost only). A persistent live server (`serveLive`) streams question batches to
a browser over SSE; Claude drives it out-of-band via `/ctl/*` control commands
(`push` / `wait` / `update` / `retract` / `finish`). Everything below preserves
those invariants: **zero dependencies, single file, localhost only, fail-loud.**

---

## Decisions (locked with the user)

- **Config scope:** global only — `~/.claude/skills/claude-detective/{config.json, context.md}`.
- **Audit surfacing:** non-blocking in-place `⚠` badges; never blocks submit.
- **Audit trigger:** **on-demand button only** (per-batch). No automatic/debounced
  passes — auto-after-each-answer was rejected (builds an unviable backlog).
- **Audit escalation:** a badge's `[ask me]` pushes a per-question follow-up.
  Per-question concerns only — no global cross-question panel.
- **Force-visual:** when enabled, Claude authors a visual for each question by
  default; it may set `visual:false` **only when a diagram genuinely adds nothing**
  (justified exception, not a default escape hatch).
- **Multi custom entries:** returned as `other: string[]` for multi; add-only UI
  (no per-chip remove, no dedupe).
- **Rebrand:** rename to `claude-detective`; keep `rizzdev-detective` as a thin
  deprecated alias.

---

## A. Rebrand: `rizzdev-detective` → `claude-detective`

Canonical name becomes `claude-detective` everywhere:

- `SKILL.md` frontmatter `name: claude-detective`; the invoking command becomes
  `/claude-detective`; description mentions it triggers on questionnaire/survey asks.
- `package.json` `name`, `README.md`, `install.sh` / `install.ps1` destination
  (`~/.claude/skills/claude-detective`), and internal path strings in `detective.mjs`
  (the `~/.claude/skills/.../detective.mjs` invocations in SKILL.md/README).
- Session-file basename: `claude-detective-live.json` (see F for keying).

**Alias (transition):** keep a `rizzdev-detective` skill entry that points at the
same folder (symlink) with a one-line deprecation note in its `SKILL.md`, so
`/rizzdev-detective` and existing muscle-memory keep working. Remove in a later pass.

**Out of scope / manual follow-up:** renaming the GitHub repo
(`rizzdev/rizzdev-detective`) and the `npx github:…` path — GitHub redirects old
clones, so this is a non-blocking manual step noted in the README.

---

## B. Bug fixes

### B1. Double-trigger hard block (interface bugs out when run twice)
**Root cause:** one fixed session file (`$TMPDIR/…-live.json`). A second run
overwrites it, orphaning the first server; `wait`/`update`/`finish` then retarget
the wrong server and the two browser tabs collide.

**Fix:** on interview startup, before binding, check the session file. If it exists
**and** its `pid` is alive **and** `GET /ctl/state` answers, refuse to start:
print `an interview is already live at <url> — finish it or pass --force` and exit
non-zero (this is the "hard block"). Escape hatches:
- `--force` — kill the stale/old server (best-effort) and replace it.
- `--port N` / `--session <path>` — intentional parallel sessions; each writes its
  own session file keyed by port (see F).

### B2. Double "continue" button + page jump on a live-action update
**Root cause:** (a) `qupdate` runs `fresh.scrollIntoView(...)` on every in-place
replace → the page jumps; (b) a phantom second `continue →` appears when a rework
is delivered as a *new batch* (`push`) instead of an in-place `update`/`annotate`,
so a second `.cont` bar renders for "the same questionnaire".

**Fix:**
- `qupdate` (and the new `annotate`) flash the question in place with **no scroll**.
- Reworks and audit findings use **in-place `update`/`annotate` only, never `push`**
  — documented in SKILL.md and enforced by the loop.
- Guard: a batch renders exactly one `.cont`; `renderBatchHtml` / the client never
  append a second continue bar to an existing batch.

---

## C. Requested UX changes

### C1. Auto-scroll to the new section
Today the `batch` SSE handler does `window.scrollTo(0, 1e9)` (jumps to the very
bottom). Change to scroll the **new batch's top** into view
(`newBatchEl.scrollIntoView({ block: 'start' })`) so a freshly pushed section lands
at the top of the viewport.

### C2. Block submit while a rework is pending
While any question within a batch has `.working` (being reworked) or an
unacknowledged serious state, that batch's `continue →` and the global submit are
**disabled** with a hint (`finish reworking this question first`). Re-enabled when
the corresponding `qupdate`/`annotate` arrives. `decide the rest` and `end
interview` remain available (they don't submit stale in-flight rework state).

### C3. "Updated <ago>" tag
On `qupdate` / `annotate`, stamp the question with `data-updated=<ISO>` and render a
small live badge — `updated just now` → `updated 12s ago` → `updated 3m ago` —
ticked by a single client `setInterval` computing relative time. Client-side only;
no server timestamp semantics beyond the event arriving.

### C4. Multi-select: add multiple of your own
Multi questions gain a `＋ add your own` control that appends repeatable custom
entries (add-only; no per-chip remove, no dedupe). Result shape:
- `single` / `yesno`: `other` stays a **string** (unchanged).
- `multi`: `other` becomes a **`string[]`** of the custom entries.

`normalizeResults` accepts both shapes and normalizes per question `type`. README /
SKILL.md "what comes back" updated to document the array form.

---

## D. Configuration system (settings ⚙, global-only)

**Storage:** `~/.claude/skills/claude-detective/config.json` and `context.md`
(created on first write). `detective.mjs` loads config at startup.

**UI:** a gear button in the live shell titlebar opens a settings panel. The browser
`POST`s `/config` with the changed fields; the server persists the file and
broadcasts the new state. Claude reads current settings via `GET /ctl/state`
(extended to include `config`).

**Toggles / fields:**

- **`requireHints`** (default **on**): validation requires a question `why` **and**
  a hint on every option (`pro`, or a new `hint` field, present). Becomes the
  standing authoring rule in SKILL.md ("always write both from now on"). When on and
  a batch is missing either, `validateQuestions` rejects it (fail-loud).
- **`forceVisual`** (default off): when on, each question carries a Claude-authored
  `visual` — an inline `<svg>…</svg>` **or** preformatted ASCII (zero-dep: no
  mermaid/render lib), shown in a framed block above the options. Required on
  `single`/`multi`; `yesno` exempt. A question may set `visual:false` to opt out
  **only when a diagram genuinely adds nothing** — Claude must justify; the opt-out
  is the exception, not the norm. Validation rejects a `single`/`multi` question that
  has neither a `visual` nor an explicit `visual:false` when the toggle is on.
- **`context.md`** — free-form, highest-priority guidance Claude reads before
  authoring (a CLAUDE.md for the skill). Editable from the settings panel (textarea)
  or directly on disk. SKILL.md instructs Claude to read it first and treat it above
  its own defaults.
- **`auditAsYouGo`** — see E. Persisted here so the button/toggle state survives.

**New endpoints:** `POST /config` (browser → persist + broadcast),
`GET /ctl/config` (Claude reads), and `config` folded into `GET /ctl/state`.

---

## E. Audit ("audit this") — on-demand, non-blocking

**Trigger:** a per-batch `⚙ audit this` button (shown when `auditAsYouGo` is on).
No automatic or debounced passes. Clicking it emits a `signal` of a new
`kind: "audit"` for that batch.

**Carries the user's text (important):** exactly like `rethink`/`research`/`more`
forward the question's `other` box, the `audit` signal **must carry any optional
text the user has typed** — the batch's `other` / nuance content (per-question
`other` values, joined) — in the signal's `other` field. Empty when none. Claude
treats that text as a priority steer for the audit (what to scrutinize), tying into
G's "prioritize Other / add nuance." The server relays `other` on the `audit` signal
just as it already does for the other kinds.

**Confirm cost:** toggling `auditAsYouGo` on in settings shows a one-time confirm —
"Audits spawn Sonnet-5 subagents and are token-heavy. Enable?" — before it sticks.

**What Claude does on an `audit` signal:** spawn **unbiased Sonnet-5 subagent(s)**
that review the batch's answers + relevant context from a fresh, skeptical vantage —
hunting problems, gotchas, logic faults, and hallucinations (no assumption the prior
reasoning was right). For each concern found, Claude calls the new `/ctl/annotate`.

**Surfacing:** `POST /ctl/annotate { qid, level, text }` → `annotate` SSE event →
the client attaches a **non-blocking `⚠` badge** to that question with `[dismiss]`
and `[ask me]`. Annotate is used (not `update`) precisely so the user's existing
selection is **preserved**. Badges never disable submit.

**`[ask me]`:** pushes a real per-question follow-up (Claude authors a targeted
question about that concern). Per-question concerns only — no global panel.

**Provenance:** subagents are dispatched with the Agent tool (`subagent_type` a
general/Sonnet agent) from an unbiased prompt; findings carry a short rationale in
`text`. This is Claude-side orchestration; the server only relays the `signal` and
the resulting `annotate`.

---

## F. Server surface & session model (localhost, zero-dep)

**New/changed endpoints:**
- `POST /config` — browser writes config; server persists + broadcasts.
- `GET /ctl/config` — Claude reads config.
- `POST /ctl/annotate { qid, level, text }` → `annotate` SSE event (non-destructive
  badge; does not clear the answer, unlike `/ctl/update`).
- `GET /ctl/state` — extended with `config`.
- `POST /signal` — accepts `kind: "audit"` (in addition to `rethink`/`research`/`more`),
  and relays its `other` field (the user's typed nuance for that batch) unchanged —
  same as the existing kinds.

**Session file & liveness:** the session file already stores `{ port, url, pid }`.
Add a startup liveness check (pid alive + `/ctl/state` responds) driving B1's hard
block. Parallel sessions (`--port`/`--session`) write a **port-keyed** session file
(e.g. `claude-detective-live.<port>.json`) so control commands can target a specific
server; the default single-session path stays for the common case.

**Multiple live triggers (the standing question) — answer + fix:** live triggers
*are* already correctly queued — the server buffers them in `state.pending[]` and
delivers them as one array to the next `/ctl/wait`; same-question re-triggers are
blocked client-side by the `.working` lock. The only real gap: the `--once`/`--demo`
path `.find`s just the first `signal`, and the driving loop must iterate **every**
event returned by `wait`. Fix that path and document "drain all `wait.events`" in
SKILL.md. No transport change needed.

---

## G. Skill-behavior (SKILL.md) changes

- **Prioritize "Other / add nuance."** Whenever an answer's `other` (string or
  array) is non-empty, Claude runs a quick think/review cycle on that input before
  continuing — it often carries the real signal. When audit mode is on, that nuance
  is explicit fuel for an `audit this` pass.
- **Always author both hints.** Question `why` + a per-option hint are now required
  (mirrors `requireHints`, default on).
- **Force-visual authoring guidance:** how to write compact inline-SVG / ASCII
  visuals; when opting out is justified.
- **Reworks/audit are in-place.** Use `update`/`annotate`, never `push`, for
  reworking or annotating an existing question (prevents B2).
- **Drain all `wait` events.** The loop must handle every event, not just the first.

---

## Sequencing (for the implementation plan)

1. **Rebrand + alias** (A) — mechanical, unblocks naming everywhere.
2. **Bug fixes** (B1 hard block, B2 double-continue/jump) + **submit-block** (C2).
3. **UX: scroll-to-section (C1), updated-tag (C3), multi custom entries (C4).**
4. **Config system + settings UI** (D) — endpoints, persistence, `requireHints`,
   `forceVisual`, `context.md`.
5. **Audit mode** (E) — button, confirm, `/ctl/annotate`, subagent orchestration.
6. **SKILL.md behavior** (G) — nuance priority, hints rule, in-place rule, drain-all.

## Non-goals / preserved invariants

- Zero runtime dependencies; single `detective.mjs`; Node ≥ 22; localhost only.
- No network calls / phone-home; audit subagents run through Claude, not the server.
- No automatic audit passes (explicitly rejected).
- GitHub repo/npx rename is a manual follow-up, not part of this work.
