# Design System — CodeRover

## Product Context

- **What this is:** An autonomous fleet of five AI code agents (Scout, Tinker, Sentinel, Beacon, Archive) that review PRs, patrol security, refactor dead code, remember decisions, and send weekly health digests. MCP-native, self-hostable.
- **Who it's for:** Engineering teams drowning in code review, onboarding lag, silent tech debt, and post-hoc security findings. Also: solo devs and vibe-coders who want a second pair of eyes on their repo.
- **Space/industry:** Developer tools. Peers by category: Cursor, GitHub Copilot, Sourcegraph, Snyk, SonarQube. CodeRover's new category is "autonomous rover fleet" — it sits above IDE assistants and orchestrates code intelligence, not competes with individual tools.
- **Project type:** Marketing landing page (single static page) + web dashboard app ("Mission Control"). The landing sells. The app is where approved engineers and team leads operate the fleet.

## Aesthetic Direction

- **Direction:** Mission Control Brutalism
- **Decoration level:** intentional — scanlines and a grayscale brand-film loop, earned by the rover/mission-control metaphor. No gradients, no blobs, no stock iconography.
- **Mood:** Dev-serious. Atmospheric. Grown-up. Zero hype. Feels like sitting at a console at 2am, not a SaaS landing page.
- **Reference:** The source concept lives at `~/Downloads/coderover_web/index-dev-video.html`. Treat it as the brand's ground truth until this doc contradicts it.

## Typography

- **Display/Hero:** `BOKEH` — custom dafont, self-hosted. Wordmark only. One use per page, maximum impact. Paired with a triple-stacked text-shadow to produce the bokeh glow effect.
- **Body:** `Inter` 300/400/500/600/700. Loaded from Google Fonts or Bunny Fonts. The workhorse.
- **UI chrome:** `Inter` 500 @ 0.04em tracking. Top-nav labels, button labels, header chrome.
- **Data/Tables:** `Inter` with `font-variant-numeric: tabular-nums`. Must align columns.
- **Code / CLI / Eyebrows:** `JetBrains Mono` 300/400/500/600. Load-bearing personality font. Used for `§ Feature` eyebrows (uppercase, 0.18em tracking), agent tags (`[scout]`, `[sentinel]`), CLI examples, metadata, status lines, file:line citations.
- **Loading:**
  - Google Fonts CSS link for Inter + JetBrains Mono, `display=swap`.
  - `BOKEH.otf` + `BOKEH.ttf` self-hosted at `coderover-frontend/src/assets/fonts/`. `@font-face` with `font-display: block` so the wordmark never flashes fallback.
- **Scale (px):**
  - Micro: 11 (mono eyebrows, tabular metadata)
  - Caption: 12 (mono badges, kickers)
  - Small: 14 (secondary body, mono CLI)
  - Base: 16 (body paragraph)
  - Lead: 18 (section lead sentence)
  - H4: 22
  - H3: 28
  - H2: 40 (section title)
  - H1: 64 (page title)
  - Wordmark: clamp(72px, 14vw, 200px) — BOKEH hero only

## Color

- **Approach:** Restrained. Bone-on-void + two muted signal colors. No primary blue. No gradients. No decorative color.
- **Primary (`bone`):** `#EDEBE5` — foreground text, wordmark, primary button background.
- **Secondary (`ink`):** `#D8D6CF` — secondary text, hover states, card emphasis.
- **Muted (`silver`):** `#8C8C87` — metadata, timestamps, placeholder text, inline title clauses.
- **Surface neutrals:**
  - `void` `#0A0A0A` — default app background
  - `black` `#050505` — hero, final CTA, maximum-depth surfaces (marketing only)
  - `graphite` `#1A1A1A` — cards, panels, input backgrounds
- **Borders:**
  - `--line` `rgba(237, 235, 229, 0.10)` — default 1px border
  - `--line-hi` `rgba(237, 235, 229, 0.22)` — hover / emphasized border
- **Semantic (dev-signal only, never decorative):**
  - `accent` (success) `#9FE0B4` — online state, pass, PR approved, accent highlights
  - `destructive` (danger) `#E89D9D` — error, block, security violation
- **What we deliberately don't have:** no `info` scale, no `warning` scale, no purple, no gradient. The existing shadcn `--color-info-*` and `--color-warning-*` ramps get deleted from `tailwind.config.cjs`. If a page needs "warning," use `destructive` at reduced opacity (`rgba(232, 157, 157, 0.6)`).
- **Dark mode:** This IS dark mode. The app also ships a light variant (see Light Mode Ramp below) for admin users who need it in bright offices. Marketing/landing is dark-only.
- **Light Mode Ramp (app only):**
  - `bone-inverted` `#0A0A0A` — foreground
  - `void-inverted` `#F7F5EF` — background
  - `graphite-inverted` `#EDEBE5` — card
  - `silver-inverted` `#6B6B66` — muted text
  - Accent/destructive colors stay the same — they read correctly in both modes.

## Spacing

- **Base unit:** 4px
- **Density:** Comfortable on marketing (padding 80-96px section blocks). Compact in app (padding 16-24px card bodies, 12px table rows).
- **Scale:**
  - `2xs` 2 · `xs` 4 · `sm` 8 · `md` 16 · `lg` 24 · `xl` 32 · `2xl` 48 · `3xl` 64 · `4xl` 96

## Layout

- **Approach:** Grid-disciplined. Container-centered. No editorial asymmetry — this isn't an art project, it's a terminal in a clean room.
- **Grid:**
  - Marketing: 12-col, content column 1100px max, full-bleed hero and CTA blocks
  - App: 12-col, shell max 1400px, sidebar 240px + main
- **Max content width:**
  - Marketing: 1100px
  - App: 1400px
  - Reading text column: 720px (docs, post-style content)
- **Border radius (brutalist scale):**
  - `none` 0 — default for cards, tables, inputs (intentional — this is the brutalist signal)
  - `sm` 2px — chips, badges, kbd keys
  - `md` 4px — only where interactive affordance demands it (sliders, thumbs)
  - `full` 9999px — kicker pills only
  - No `lg`/`xl`/`2xl`. Delete them from the Tailwind config.
- **Borders:** 1px solid `--line`. On hover or focus, transition to `--line-hi`.

## Motion

- **Approach:** Minimal. Atmospheric, not kinetic.
- **Easing:**
  - Enter: `cubic-bezier(0.2, 0, 0, 1)`
  - Exit: `ease-in`
  - Move: `ease-in-out`
- **Duration:**
  - Micro (button press, hover): 80ms
  - Short (fade, color swap): 180ms
  - Medium (drawer, modal): 280ms
  - Long: not used.
- **Scanlines:** Static. No animation. The vibe is analog, not glitchy.
- **Brand film:** Background video, autoplay muted loop, grayscale(1) + contrast(1.12) + brightness(0.72) filter. Used only on hero and final-CTA blocks of the landing page. Not in the app.
- **Reduced motion:** Always honor `prefers-reduced-motion: reduce`. Replaces any transition with none. Brand film still loops because it's ambient, not kinetic — pause would be worse UX.

## Textures

- **Scanline overlay:** A single global `body::before` at `position: fixed`, `inset: 0`, `pointer-events: none`, `z-index: 90`, `mix-blend-mode: multiply`. Background is `repeating-linear-gradient(to bottom, transparent 0 2px, rgba(0,0,0,0.12) 3px 4px)`.
  - Marketing opacity: 100% (uses the 12% band directly).
  - App opacity: 50% effective (wrap the `body::before` in `opacity: 0.5` so data remains legible in tables and CodeDiff views).
- **Everything else:** nothing. No grain. No noise. No gradient accents. No decorative SVG blobs. If it isn't typography or a scanline, it shouldn't be there.

## Voice & Microcopy

- **Eyebrows:** `§ Eyebrow Text`. Mono, uppercase, 0.18em tracking, silver.
- **Titles:** Two clauses, second clause wrapped in a silver-colored span. Pattern: `Built for the things that <span>actually slow you down.</span>`
- **Agent tags in text:** `[scout]`, `[tinker]`, `[sentinel]`, `[beacon]`, `[archive]` — mono, lowercase, bracketed. Never "Scout agent said..." — always `[scout] reviewed PR #412 in 1.8s`.
- **Status phrases:** `online`, `armed`, `patrolling`, `downlinked`, `landed`. Match the mission-control metaphor.
- **Empty states:** Never "No data". Always "`[beacon] armed · next downlink in 3d`" or "`[scout] online · watching 4 open PRs`".
- **Error states:** `[sentinel] BLOCK api_key hardcoded @ src/auth.ts:42`. Red `BLOCK` token, file:line citation, never pure prose.
- **Ban:** "seamlessly," "robust," "delightful," "supercharge," "unleash," "game-changer." The brand voice is 2am-terminal, not TechCrunch.

## Component Inventory (to build)

These are new primitives required to carry the brand into the app. See `phase12-brand-primitives` wave in the implementation plan.

- `<Wordmark size="lg|md|sm" />` — BOKEH with triple-stacked text-shadow glow
- `<Eyebrow>§ Features</Eyebrow>` — mono, uppercase, tracked, silver
- `<Kicker status="live|beta|armed">Live · v1.0</Kicker>` — bordered pill with optional dot indicator
- `<Terminal title="~/my-app — rover"><TerminalLine prompt>rover land</TerminalLine></Terminal>` — traffic-light dots, bone-on-graphite body, mono
- `<CLIInstallBlock command="npm i -g coderover" />` — install bar with copy button
- `<RoverBadge unit={1} name="Scout" role="pr-review agent" status="online" />` — reusable across PR reviews, agent page, dashboard fleet strip
- `<ProofRow items={[{label, value}]} />` — 4-col compact stat strip
- `<CompareTable rows={...} highlight="us" />` — category comparison table
- `<AgentStatusLine agent="sentinel" level="block|ok|warn">api_key hardcoded @ src/auth.ts:42</AgentStatusLine>` — one-line status with color-coded token

## Accessibility

- **Contrast:** bone (`#EDEBE5`) on void (`#0A0A0A`) is 18.8:1 — far above AAA. ink on void is 16.2:1. silver on void is 5.4:1, which passes AA for body text but not AAA — use silver only for metadata, never for critical body copy.
- **Focus rings:** Visible at all times. 2px solid `accent` (`#9FE0B4`) with 2px offset from the bone-bordered element.
- **Reduced motion:** Honor globally (see Motion section).
- **Font sizes:** Minimum 14px for any non-decorative text. Mono eyebrows at 11px are explicitly decorative chrome, not content.
- **Color-only signals:** Never rely on color alone. `[sentinel] BLOCK` pairs color with a text token. `[scout] ok` pairs color with a word.

## Decisions Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-04-20 | Initial design system created | Translated the `coderover_web/index-dev-video.html` concept into a token system. Driven by `/design-consultation`. |
| 2026-04-20 | Collapse shadcn `info` + `warning` color scales instead of deleting | 77 usages across 9 pages would break on delete. Wave 1 remapped `--color-warning-*` to a muted amber-coral and `--color-info-*` to silver so legacy components degrade on-brand. Full delete deferred to a future cleanup. |
| 2026-04-20 | Border-radius defaults to 0 | Brutalist choice. Rounded corners fight the mission-control atmosphere. Exceptions: kicker pills (999px) and tiny chip/kbd (2px). Legacy `.card` / `.btn` / `.input` classes in `App.css` still use `0.375rem–0.5rem`; brand primitives use 0. |
| 2026-04-20 | BOKEH font wordmark-only | Custom dafont with `font-display: block`. One use per page. Using it for general headings would cheapen the identity and slow first paint. Self-hosted at `src/assets/fonts/BOKEH.{otf,ttf}`. |
| 2026-04-20 | Scanline opacity dialed to 50% in app | Full 12% bands degrade table legibility during long dashboard sessions. Marketing keeps 100%. Light mode disables scanlines entirely. Single `body::before` layer, `mix-blend-mode: multiply`. |
| 2026-04-20 | Landing page stays static HTML at `public/landing/` | The concept is polished, ships the brand film, deploys as a separate nginx `location` block. Rebuilding in React adds risk and gains nothing. nginx maps `/ → /landing/index.html`, SPA owns everything else. Contract documented in `docs/deploy/landing-nginx.md`. |
| 2026-04-20 | Default `:root` = dark mode; light mode lives behind `[data-theme="light"]` | Brand is dark-first. Admin users who need light-mode get an inverted bone-on-paper ramp; marketing/landing is dark-only. Scanlines suppressed in light mode. |
| 2026-04-20 | Active sidebar nav item uses `bg-foreground/[0.06]` + accent icon | Blue-tinted shadcn default (`bg-primary-500/10` + `text-primary-600`) renders bone-on-bone in this palette — unreadable. The 6%-foreground highlight sits cleanly on the graphite surface and the accent-green icon carries the signal. |
| 2026-04-20 | Landing served on the same domain, not a subdomain | Deploying on Contabo alongside an existing HR-lead-gen Next.js app. Single-subdomain routing (`/ → landing`, `/login → SPA`, `/api → backend`) keeps the SPA routes at root (zero base-path changes) and coexists with the existing nginx on the box. |
| 2026-04-20 | `/design-system` route is public, not admin-gated | It's a dev/design tool. Discoverability > "security"; no sensitive data, just primitives. Mounted outside the `ProtectedRoute` block so designers can hit it without login. |
| 2026-04-20 | React Flow theming via global CSS overrides in `App.css` | Cheaper than wrapping every node type. Overrides `.react-flow__node` / `.react-flow__edge-path` / `.react-flow__controls` with brand tokens so the Orbital Map renders without touching graph-page internals. |
| 2026-04-20 | PR Reviews finding rows: no severity-tinted backgrounds | Tinted backgrounds (error-50 / warning-50 / info-50) in shadcn colors fight the graphite card surface. Replaced with mono `[scout] BLOCK src/auth.ts:42` one-liners where only the level token carries signal color. |
| 2026-04-20 | Dashboard Fleet Strip uses hardcoded rover status | Real fleet-status API doesn't exist yet. Hardcoded as a design-first placeholder so the UI ships ahead of the backend. Wiring happens when the status endpoint lands. |
| 2026-04-20 | Kept legacy `.card` / `.btn` / `.alert` CSS classes in `App.css` for compat | 18 pages and several hundred components reference these. A full Tailwind-utility migration would be its own multi-day refactor. The classes now inherit brand colors via the CSS variables, so they look on-brand even while the class names stay. |
