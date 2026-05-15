# Loomscape — Cowork-Native Demo-Video Pipeline (Design)

- **Date:** 2026-05-15
- **Status:** Approved (brainstorm complete; pending implementation plan)
- **Topic:** Make the local-first demo-video pipeline usable by non-developers through Claude Cowork

## Context

The `coderover-loom-handoff/` pipeline turns a text script into a branded,
narrated, real-product demo video, fully locally, at $0/clip:

```
text script ─┐
             ├─► VibeVoice ─► ffmpeg post ─► whisper ─► captions
             │                                  │
Playwright ──► silent footage ─────────────────┤
brand assets ──────────────────────────────────┴─► Remotion/ffmpeg compose ─► final.mp4
```

Today it is developer-only: a running Docker stack for the target app,
Playwright `.mjs` recorders with hand-coded scene timings, a PyTorch GPU
VibeVoice venv, keg-only `ffmpeg-full`, `whisper.cpp`, and the Remotion CLI.
The goal is for a **non-developer to produce a brand-correct narrated video of
a real feature in their own web app, end to end, by conversation only in
Claude Cowork, with zero terminal use after a one-time guided setup.**

## Decisions locked (brainstorm)

| Decision | Choice | Implication |
|---|---|---|
| Scope | **Generic productized skill** | Works against any web app, not CodeRover-only |
| Runtime | **Local-first, auto-setup** | Keep the $0 local pipeline; a guided setup skill carries the install burden |
| Authoring | **Autonomous AI scene planner** | Claude explores the live app, plans beats, writes the script — no scene code |
| App access | **Guided one-time login** | A real browser opens, the user logs in normally, the session is saved & reused |
| Packaging | **Plugin with focused skills (Approach A)** | Native Cowork shape; thin skills over a tested core library |

Rejected: cloud render service / managed-API hybrid (would break $0 local
property); `scene.yaml` CLI and MCP server (static/stateless seams fight the
interactive autonomous planner).

## Section 1 — Architecture & overview

A Claude Code plugin, **Loomscape**, installed in Cowork. The non-developer
works entirely by conversation after a one-time setup.

```
loomscape/  (own git repo, MIT, seeded from coderover-loom-handoff/)
├── .claude-plugin/plugin.json        # marketplace manifest
├── skills/
│   ├── setup/    SKILL.md            # idempotent dependency installer + verifier
│   ├── connect/  SKILL.md            # guided login → saved session profile
│   ├── generate/ SKILL.md            # conversational core (planner → recipe → mp4)
│   └── brand/    SKILL.md            # create/edit brand-profile JSON
├── core/                             # the pipeline as a tested TS library
│   ├── record/   (Playwright driver, cursor, storageState)
│   ├── voice/    (VibeVoice runner, ffmpeg post-chain)
│   ├── caption/  (whisper-cli + caption builder)
│   ├── compose/  (Remotion render OR ffmpeg compose)
│   └── pipeline.ts                   # orchestrator: profile in → mp4 out
├── scenes/        # primitive library: goto/click/hover/scroll/settle/waitFor
├── brands/        # brand-profile loader + Zod schema; coderover.json reference
├── voices/        # speaker presets + post-processing chains
├── examples/coderover/               # the working 6-clip setup as the reference
└── projects/                         # per-user state (gitignored)
```

**Project profile** — the central state object, one per video project, written
by `connect` + `brand`, consumed by `generate`:

```
projects/<slug>/
├── profile.json     # baseUrl, brandProfile ref, voice, output prefs
├── auth.session     # Playwright storageState (gitignored, chmod 600)
└── outputs/         # rendered .mp4s + scene plan + script per run
```

**Why:** skills are thin conversational orchestration; all real logic lives in
`core/` as unit-testable functions (the current `.mjs` scripts refactored, not
rewritten). The autonomous planner lives inside `generate`'s agentic loop where
it has live Playwright access. The STRATEGY.md repo layout drops in underneath.

**Repo decision:** Loomscape becomes its own git repo seeded from the
(currently non-git) `coderover-loom-handoff/`. The CodeRover setup moves to
`examples/coderover/` as the reference example. This spec is the first commit.

## Section 2 — Skill flows (data flow)

**`loomscape:setup`** — once per machine, idempotent.

```
detect OS/arch → check each dep → install only what's missing → verify → self-test
  Node≥20 + npm        → nvm/brew if absent
  Playwright browsers   → npx playwright install chromium
  ffmpeg-full           → brew install ffmpeg-full (path pinned)
  Python+venv+VibeVoice → clone microsoft/VibeVoice, patch weights_only=False, pip
  whisper.cpp + model   → brew install whisper-cpp; download ggml-base.en.bin
```

**Supported platform:** macOS on Apple Silicon is the supported target (RECIPE
requires M-series GPU for usable VibeVoice speed). `setup` detects the platform
first and, on anything else, states the limitation plainly and stops rather
than half-installing.

Plain-English progress per step. Ends with a self-test that runs a 2-second
throwaway clip through every stage. Re-running reports "already set up ✓".
RECIPE non-negotiables (PyTorch patch, ffmpeg-full path) are encoded here.

**`loomscape:connect`** — once per app.

```
ask app name + URL → launch HEADED browser → user logs in normally (any method)
  → detect auth (URL/DOM heuristic) AND user confirms "I'm in"  ◄ both required
  → save storageState → projects/<slug>/auth.session (chmod 600)
  → write profile.json {baseUrl, slug} → "Connected. I can reach <app> as you."
```

Auth detection is deliberately not heuristic-only: the heuristic suggests the
user is in, but the session is saved only after the user explicitly confirms,
so a partial/2FA-pending login is never persisted. Session expiry is detected
at generate-time and re-runs this flow.

**`loomscape:generate`** — the core loop.

```
"make a video about <feature>"
  → load project profile + brand + auth.session
  → PLANNER: drive live app, explore, draft {scenePlan, script}        [Section 4]
  → SHOW user plan + script in plain English → approve / tweak / redo  ◄ gate 1
  → RECIPE (core/pipeline.ts), each stage streamed as progress:
       record → vo → ffmpeg post → whisper → compose
  → deliver projects/<slug>/outputs/<feature>-vN.mp4 + open it
  → "want changes?" → re-plan / re-voice / re-grade                    ◄ gate 2
```

**`loomscape:brand`** — optional, defaults to a neutral profile.

```
"match my brand" → ask colors/font/voice OR sample a URL
  → write brands/<slug>.json (schema-validated) → render preview card
```

Only two approval gates (plan; final "want changes?"). Everything between is
autonomous with streamed progress. Re-grade/re-voice reuse cached silent
footage (the expensive step) so iteration is seconds.

## Section 3 — Core library design

The `.mjs` scripts are refactored (not rewritten) into pure, testable units —
each one job, typed interface, no hidden global state.

**`core/record/`** — wraps the proven `recorder-lib.mjs`.
- `recorder.ts` — `record(profile, scenePlan) → silent.webm`. Owns RECIPE
  non-negotiables as code: `colorScheme:'dark'`, `deviceScaleFactor:2`, cursor
  injected post-`waitForSelector` via `page.evaluate` with margin offsets
  (never `transform`, never `top/left !important`), `MutationObserver` re-attach.
- `cursor.ts` — injectable cursor system, isolated and testable.
- `session.ts` — load/refresh `storageState`; throws `SessionExpired`.

**`scenes/`** — the primitive library replacing hand-coded timings.
- Primitives: `goto`, `click`, `hover`, `scrollTo`, `settle(ms)`,
  `waitFor(selector)`, `revealHold(target, ms)`.
- A **scene plan is data**, not code:
  `{ beats: [{ primitive, target, durationMs, narrationCue }] }`. The planner
  emits this JSON; `recorder.ts` interprets it. Targets resolve by
  role/text/test-id with a fallback chain. This seam is what makes
  "no scene code" real.

**`core/voice/`**
- `vibevoice.ts` — patched VibeVoice (Samuel, single-shot, ≤50-word guard,
  throwaway tail appended automatically).
- `postprocess.ts` — the locked `atrim/afade/apad/loudnorm` chain as a pure
  function of `{trimTime}`.

**`core/caption/`** — `whisper.ts` (16 kHz → `whisper-cli` word JSON) →
`captions.ts` (token → 2–3-word chunks → ASS/Remotion captions, `OFFSET=1.0`).

**`core/compose/`** — `remotion.ts` (preferred: existing brand-parameterized
`Clip0X` compositions) with `ffmpeg.ts` (the `compose.sh` filter graph) as a
no-Remotion fallback. Selected by brand profile.

**`brands/`** — `schema.ts` (Zod) + `loader.ts`. A brand profile is the only
per-customer variance: `{ colors, fonts, scanlineOpacity, cursorColor,
captionStyle, voice, composeEngine }`. `coderover.json` is the reference;
`default.json` is neutral.

**`core/pipeline.ts`** — orchestrator `(profile, scenePlan) → mp4`, calling
stages in order, emitting structured progress events. Each stage independently
runnable for tests and for cheap re-runs (re-voice without re-record).

## Section 4 — The autonomous scene planner

Runs inside `generate`'s agentic loop with live Playwright access via the
authenticated session.

**Input:** `{ baseUrl, authSession, brandProfile, featureDescription }`.

**Phased, bounded loop:**

1. **Explore (budgeted).** Navigate from `baseUrl`, capture accessibility tree
   + screenshot per page, follow nav toward the feature. Cap: ~12 visits or
   ~90 s. Build `{route → {role-labelled elements, headings}}`. Read-only —
   never submits forms or mutates data.
2. **Locate.** Match `featureDescription` to the map. If ambiguous/not found →
   **ask the user one plain question**, never guess.
3. **Draft beats.** Emit the Section 3 scene-plan JSON: establishing beat,
   3–6 feature beats, closing beat. Each target stored as a fallback chain
   `[testId, role+name, text]`. Pacing from RECIPE (2–4 s/beat).
4. **Write the script.** 40–50 words, one clause per sentence, brand voice from
   the brand profile (CodeRover profile carries bracketed agent names +
   banned-word list; `default` neutral). Throwaway tail auto-appended.
   Narration cues aligned to beats.
5. **Self-verify before the gate.** Dry-run every beat selector headless (no
   recording). Unresolved targets are repaired or flagged in the shown plan.
   Guarantees the presented plan is recordable.

**Output to gate 1**, plain English:
> Plan: land on Dashboard → open Billing → hover the Alerts toggle → open the
> modal → settle on confirmation. Script: "[draft 44 words]". 5 beats, ~22 s.
> Approve / tweak a line / re-plan?

**Determinism guards:** exploration read-only and capped; plan is data reviewed
before any render; re-plan is cheap (no recording yet). The expensive recipe
runs only post-approval.

## Section 5 — Error handling & failure recovery

Every failure resolves to **auto-recover, or one plain-English choice — never a
traceback.**

**RECIPE failures encoded as invariants (cannot regress):**

| Failure | Guard |
|---|---|
| Cursor invisible (`!important`/`transform`) | `cursor.ts` emits only margin offsets; unit test asserts it |
| Light-mode render | `colorScheme:'dark'` set in `recorder.ts` constructor, not optional |
| Subtitles missing (brew ffmpeg) | `setup` verifies `ffmpeg-full`; path hard-pinned |
| PyTorch `weights_only` crash | `setup` applies + verifies the patch; self-test catches regressions |
| VO fades / clips last word | throwaway tail + 150 ms-past-word trim + fade + 1 s pad non-optional |
| VO doesn't cover video | footage length derived from VO duration — mismatch impossible by construction |

**Runtime failures → recovery action:**
- **Session expired** → catch `SessionExpired`, explain plainly, auto-invoke
  `connect`, resume.
- **Planner can't find feature** → one clarifying question; never a broken plan.
- **Beat selectors all fail at record time** → pause, screenshot current page,
  ask: point me at it / skip beat / re-plan.
- **VibeVoice degraded take** (loudness variance > 3 dB) → auto-regenerate up
  to 3 takes, pick best; escalate only if all fail.
- **Dependency missing/broken mid-run** → name it plainly, offer targeted
  `setup` re-run.
- **Render crash (Chromium GPU)** → retry once at `--concurrency 1` before
  surfacing anything.

**Idempotency & safety:** every run writes `outputs/<feature>-vN` (no
overwrite). Exploration and recording are **read-only** against the user's app —
the planner never submits forms or mutates data (stated so a non-dev trusts
pointing it at production). All failures log verbosely to
`projects/<slug>/outputs/<run>/log.txt` for maintainers; the user sees one
sentence.

## Section 6 — Testing strategy

Skills are thin; testing concentrates on `core/` and the invariant guards.
TDD: tests before each unit.

**Unit (fast, no browser/GPU) — bulk of coverage:**
- `cursor.ts` — asserts no `!important`/`transform` on top/left (the
  hour-long-bug regression test).
- `postprocess.ts` — `{trimTime}` → exact ffmpeg filter string.
- `captions.ts` — token fixture → 2–3-word chunking + `OFFSET=1.0`.
- `scenes/` interpreter — scene-plan fixture → ordered Playwright call
  sequence (mocked page); validates the data-not-code seam.
- `brands/schema.ts` — valid/invalid fixtures; Zod rejects malformed profiles.
- `pipeline.ts` — stage orchestration mocked: order, VO-derived footage length,
  failure surfaces a structured event (not a throw).

**Component (browser, no GPU):**
- `recorder.ts` against a static local fixture page: dark mode forced, cursor
  present after navigation, `storageState` loaded. CI headless.
- Planner exploration against the fixture site: read-only (network spy asserts
  no form submit), bounded (visit cap), ask-don't-guess (ambiguous fixture →
  question, not plan).

**End-to-end (self-test, gated/local):**
- `examples/coderover/` is canonical E2E: spin the stack, `generate` one known
  feature, assert `.mp4` produced, non-zero duration, VO length ≈ video length.
  Doubles as `setup`'s post-install self-test (2 s throwaway clip).
- Existing 6 clips are golden references; render regression caught by
  frame-probe assertions.

**CI tiers:** unit + component every change (minutes, no GPU); E2E on-demand
local (needs GPU + stack). Coverage gate on `core/`; skills excluded
(orchestration, covered by E2E).

## Out of scope (YAGNI / deferred)

Explicitly **not** in this design — deferred to later tiers from STRATEGY.md:
A/B variant generator, multi-language pipeline, web UI, personalization layer,
asset/template gallery, direct-to-platform publishing, hosted/cloud render,
adjacent products (audit-trail recorder, bug-repro generator, changelog-as-a-
service). This spec covers Tier 1 (usable by someone other than us) plus the
Tier 3 autonomous planner, because the planner is the unlock that makes Tier 1
real for a non-developer.

## Success criteria

A non-developer, in Claude Cowork, with zero terminal interaction after a
one-time guided setup, produces a brand-correct narrated `.mp4` of a real
feature in their own authenticated web app — by describing the feature in plain
English and approving a plain-English plan.
