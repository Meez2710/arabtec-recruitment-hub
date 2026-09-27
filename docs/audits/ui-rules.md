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
