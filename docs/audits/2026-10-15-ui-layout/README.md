# UI layout fixes — 15 October 2026

Branch `ui/onprem-layout-fixes`, from the on-prem release line `release/2026-10-15-onprem` at `2864590`.
Scope: confirmed alignment and layout defects only. Colours, typography, components, workflows, permissions, backend and data are unchanged. This is not the design-system migration described in Codex's DESIGN.md.

## Defects fixed (root cause → fix)

| Defect | Root cause | Fix |
|---|---|---|
| Every phone page was 78px wider than the screen and could slide sideways (the page title touched the left edge) | `.content::before` watermark defined in four files; negative offsets (`right: -20vw; width: 108vw`) widened `<main>`, and `overflow-x: hidden` let focus scroll the hidden strip into view | One definition (design-system), anchored inside `.content` with zero insets; phone shell uses `overflow-x: clip` |
| Talent Pool / Interviews header actions hidden off-screen ("Add manually", "Scheduling Setup", "Schedule interview"…) | A later block in `arabtec-mobile.css` turned the action grid into a `nowrap`, `overflow-x: auto` strip with its scrollbar hidden | Removed the override; the existing two-column grid (view switch on its own row) owns the row |
| Talent Pool table: Download icon clipped by 10px; icons at a different x per row | `.talent-pool-table .pool-candidate > div { flex: 1 1 auto }` (specificity 0,2,1) beat the action slot's `flex: 0 0 auto` (0,2,0) | Candidate cell is a grid: `36px minmax(0, 1fr) 92px`; one layout rule |
| Dialogs opened under the phone app bar; title and close button covered | Dialogs rendered inside `<main>`, whose `isolation: isolate` traps their z-index below the fixed app bar | Every overlay portals into one stable overlay host, placed inside `.shell` outside `<main>` (phone control sizing still applies) |
| Selects 21px tall next to 40/44px inputs in Safari / every iOS browser | WebKit ignores `min-height`/`padding` on a select drawn with the native menulist appearance | Single-value selects draw their own box (`appearance: none` + chevron); native arrow restored under `forced-colors` |
| Candidate cards 16px past a 320px screen | `.cand-grid` `minmax(320px, 1fr)` loads after the phone rules | `minmax(min(320px, 100%), 1fr)` |
| Crossing 900px (window resize, tablet rotation) remounted the page: open dialog, typed draft, filters, selection and focus lost | Phone and desktop chrome were two element trees around `<main>` | One tree: `shell > .main > main` with fixed chrome slots; React keeps the page mounted |

## Verification

`verify.mjs` drives real WebKit 18.2 (Safari engine) and Chromium 131, Playwright 1.49.1, against two throwaway servers holding identical synthetic data (audit seed plus `test-cv.pdf` attached to each candidate): **before** = `2864590` worktree, **after** = this branch.
It covers widths 320, 390, 640, 1024 and 1440, plus WebKit with the iPhone 13 profile (touch, mobile UA, dpr 3). `measurements.json` holds every number.

| Measure (phone widths 320–640, both engines) | Before | After |
|---|---|---|
| `<main>` scroll width vs viewport | 384/320, 468/390, 768/640 | equal to viewport |
| Talent Pool header actions hidden | 4 / 3 / 1 | 0 |
| Interviews header actions hidden | 2 | 0 |
| Table action icon clipped | 10px | 0 |
| Distinct action-icon x positions per table | 3 | 1 |
| Dialog title visible / close tappable | no / no | yes / yes |
| Select height (WebKit) | 21px | 44px (= input) |
| Select height at 1024/1440 (WebKit) | 21px | 40px (= input) |

Remount: with a draft typed into "Add candidate manually", resizing 390 → 1280 → 390 kept the same `<main>` node, the same dialog node, the draft value and focus.

Production mode: the branch also ran with `NODE_ENV=production` behind a local TLS proxy standing in for Apache (production sends HSTS and `upgrade-insecure-requests`). WebKit/iPhone: CSP `img-src` allows the `data:` chevron, no console errors, dialog title visible, select 44 = input 44. PostgreSQL was not available on this machine; the change touches no server or database code.

Not covered: a physical iPhone (software keyboard, safe areas), desktop Safari.app itself (WebKit 18.2 via Playwright was used), and pages not listed above beyond the per-route overflow probe.
