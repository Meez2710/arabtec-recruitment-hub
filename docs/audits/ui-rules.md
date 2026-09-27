# UI rules — defects fixed once, guarded forever

Every rule here was a real defect seen on a real screen, fixed, and then
turned into a check in `backend/ui_layout_rules_test.mjs` (core CI suite) so
it cannot come back unnoticed. Add a rule the same way: fix the screen, write
the smallest static check that would have caught it, list it here with the
screen it came from.

| Rule | Defect it came from | Where the fix lives |
|---|---|---|
| R1 A filter select never clips its own label on wide toolbars | Hiring Requests at 1440 showed "All statu", "All priori" | `claude-system.css`, `.toolbar-secondary > select { min-width: max-content }` (≥641px) |
| R2 The phone candidate header is a grid; actions take their own row | Talent Pool profile at 390px wrapped "Ahmed Mostafa" letter by letter and stacked every chip | `arabtec-responsive.css`, phone block, `.profile-header` |
| R3 A card title never wraps under its subtitle on a phone | Dashboard "My roles" read as "My / roles" beside its subtitle | `arabtec-responsive.css`, phone block, `.card-head` |
| R4 Buttons on the brand-coloured bulk bar keep readable labels | Pipeline bulk bar: "Clear" was white on white, "Move" green on green | `arabtec-design-system.css`, `.bulk-bar .btn`, `.bulk-bar .btn-ghost` |
| R5 Five pipeline columns fit the 1440 content column; below that the board shows its scrollbar | Board columns ran past the right edge with no visible affordance, reading as a cropped page | `claude-system.css`, `.kanban` |
| R6 No form value is read back through `document.getElementById(...).value` | Bulk destination was a DOM lookup, so React state and the DOM could disagree | `app.jsx`, `bulkSelectionSummary` + controlled select |
| R7 Every KPI tile can withhold its number | Dashboard showed 0 for lists that had failed to load | `app.jsx`, `KpiCard({ unavailable })` |
| R8 A disabled control uses the product's one opacity | A local `.55` broke `ui_form_controls_test` | every stylesheet |
| R9 An in-card error state is the shared `Empty` / `LoadError`, never a hand-rolled red box | Keeps one error vocabulary across pages | `app.jsx` |

Companion guards that already existed: `ui_form_controls_test.mjs` (control
metrics and disabled opacity), `ui_toolbar_layout_test.mjs` (toolbar wrap
rules), `ui_sort_stability_test.mjs`, `ui_behavior_test.mjs` (state and
recovery behaviour, including honest loading, approvals and bulk scope).

## How a new screen is checked before it ships

1. Capture it at 1280, 1440 and 390 with synthetic data (the Playwright
   scripts in this repo's PR evidence show the pattern).
2. Measure, do not eyeball: `document.documentElement.scrollWidth` must equal
   `clientWidth` on every route; no element's right edge may pass the
   viewport except inside a scroll container that draws its scrollbar.
3. Every text control must show its full label at every width it is
   rendered at; every button on a coloured field must pass 4.5:1.
4. If the fix is a CSS declaration, add a rule above and a check in
   `ui_layout_rules_test.mjs` that reads that declaration.

## R10 Emoji policy
Emoji appear only through the `EMOJI` map in app.jsx, and only in a `Hint` or the knowledge line, one per element, leading it. Never in a button, a page title, a badge, a table cell or a notification. Origin: the owner asked for premium visuals with emojis and quotes; unbounded emoji use reads as consumer chat, bounded use reads as a considered voice.

## R11 The crumb is the eyebrow
Every page title carries a tracked uppercase eyebrow led by the 18×2px brand-red dash. Origin: the premium spec; titles without an eyebrow read as orphaned.

## R12 Chrome and controls
Sidebar charcoal (`#1A1A1A`) with one 3px red bar on the active item; `.btn` is the one solid green action, `.btn-secondary` white, `.btn-ghost` transparent; badges 6px, never pills. Colour rules never touch a control's box (height, padding, border width), which stays in claude-system.css so the form-control tests keep holding.

## R13 One page, not stacked rectangles
Headers, toolbars, tabs and detail heads never carry their own bordered white surface above the working content. The toolbar and the Ask bar sit on the canvas; tabs are an underline row; the request and candidate heads sit on the canvas over a hairline; stat tiles reserve no height. Origin: at 1440×900 the first table or board began at y=260–571 behind two to four full-width rectangles ("three rectangles before the table"). Measured after: dashboards at 161, lists at 220–268.

## R14 The phone has its own composition
One scrolling row of 40px actions under the title (never a grid of full-width buttons), search + Filters on one row with no count chip, underline tabs that scroll, two stat tiles per row, one board stage per screen with snap scrolling, and the content padding always clears the fixed top bar. Origin: the phone stacked the desktop head vertically (title, 2×3 buttons, Ask bar, two-row filter bar, pill tabs) and the first card began at y=346–556.

## R15 No bare zero from a conditional render
`{(a && b.length) && <X/>}` renders "0" when the list is empty. Use `b.length > 0`. Origin: a stray "0" above the Talent Pool board.

## R16 One spacing scale
Every margin, padding and gap is a step of the scale: 4 / 8 / 12 / 16 / 24 / 32px, which are `--sp-1` … `--sp-6` in `claude-system.css`. New rules use the tokens. The fixed gutters built from it:

| Gutter | Value |
|---|---|
| Content padding (page) | 16 phone / 24 desktop (`--sp-page-x`, `--sp-page-y`) |
| Card inset | 16 |
| Card head | 10 vertical / 16 horizontal (the one named exception to the scale) |
| KPI tile gap | 12 |
| Section gap | 12 inside a card / 16 between cards |
| Controls in one row (select + button, button + button) | 8 |

Guard: `ui_layout_rules_test.mjs` R16 scans the six sheets (`backend/test-support/spacing-scan.mjs`). Every off-scale px value that predated the rule is listed, declaration by declaration, in `docs/audits/spacing-legacy.json` (538 at introduction). The test fails on any declaration not on that list, and also on a listed one that has since been fixed, so the list can only shrink. Origin: CV Intake's "Waiting to parse" row had no rule at all, so the Period select and "Refresh from mailbox" touched with no gap; the Talent Pool head spaced its buttons 20px apart while every other row used 8.

## R17 One button spec
`.btn` is 40px (`--cl-ctl-lg`) on `0 16px`, `.btn-sm` is 32px (`--cl-ctl-sm`) on `0 12px`, both in `claude-system.css` section 6 and nowhere else; the phone raises every control to the 44px touch floor there too. No sheet other than `claude-system.css` gives a page-scoped `.btn` selector a height or padding (`arabtec-mobile.css`, the phone shell, is the documented exception, R14). A head row has one primary action and equal secondaries; buttons take their label's width (`flex: 0 0 auto`), never grow to fill a row, and never become `width: 100%` above the phone. Origin: the Talent Pool head carried a pill toggle, a primary, a borderless ghost, two bordered secondaries and a wrapper that re-laid out Bulk Upload with `display: contents`, and its buttons had a page-only padding. Measured before (`docs/ui-review/layout-comments/before/button-metrics.json`): at 390 and at 200% zoom the head mixed 44px and 40px buttons (Bulk Upload 40, the rest 44), and the generic ≤640px rule let every head button grow (`flex: 1 1 auto`). Measured after: Parse CV / Add manually / Bulk Upload CVs / Scan CV Inbox all 40px tall at 1440, at 125%, at 200% and at 390, each as wide as its label.
