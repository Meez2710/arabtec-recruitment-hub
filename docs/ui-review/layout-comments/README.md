# Desktop layout comments — evidence

`before/` is `main` at dc19fcb; `after/` is this branch. Same seeded data (six
Talent Pool candidates), admin session, Chromium via Playwright.

| Tag | Viewport | Meaning |
|---|---|---|
| `-1440` | 1440×900 @1x | desktop |
| `-1440-zoom125` | 1152×720 @1.25x | a 1440 screen at 125% browser zoom |
| `-1280-zoom200` | 640×450 @2x | a 1280 laptop at 200% browser zoom |
| `-390` | 390×844 @2x | phone |

`button-metrics.json` in each folder is the measured box of every Talent Pool
head button. Before: 40px at desktop but a 44/40 mix at 390 and at 200%, with
a page-only padding. After: all 40px at every size, each as wide as its label.

`after/` also has the new surfaces: `interview-create-modal`,
`offer-create-modal`, `control-knowledge-lines`, `user-create-modal`.

Re-run: start the server (see the PR), then
`node docs/ui-review/layout-comments/capture.mjs <port> <outdir> <backendDir>`
(set `EXTRAS=1` to open the modals).
