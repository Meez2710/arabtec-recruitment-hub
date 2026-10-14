# Claude Code handoff — Organization Structure v2, Phase A

Read first, in this order:
1. `docs/org-chart/ORG_CHART_V2_PLAN.md` — the approved plan. Sections 2–5 are the spec for this phase.
2. `docs/org-chart/reference/` — the blueprint (local only, not in git; see the README there).
3. `.claude/skills/` in this repo — especially `ats-hr-domain-patterns`, `ats-pattern-consistency-audit`, `ats-security-review`.
4. `docs/MODULE_EXTRACTION_MAP.md` (Org structure row) and `docs/design/PREMIUM_UI_SPEC.md`.

## Ground rules

- Work on a new branch from an up-to-date `main` (`git pull` first; the local copy may be behind GitHub). Open a PR; do not push to `main`.
- Never move or rename project folders. Do not touch `frontend-v2/` or the TypeScript/DDD rebuild in `backend/src/api` and `backend/src/modules`; this phase is the live legacy stack only.
- Both databases must work: SQLite locally (`npm run dev`) and PostgreSQL in production. Follow the patterns in `lib/org-chart-seed.js` (advisory lock for bootstrap) and `lib/join.js` (one module owns a transaction).
- Every write goes through `writeAudit` with before/after, behind `requirePermission('org_chart.manage')`. Reading needs a signed-in user only.
- Ship behind a feature flag in `lib/feature-flags.js` (`org_chart_v2`). With the flag off, the current page and `/api/org/chart` routes behave exactly as today.
- Outside the A3 sheet, use only existing Hub components and tokens (`page-head`, `card`, `btn`, `btn-secondary`, `btn-ghost`, `modal`, `field`, `form-grid`, `error-banner`, `--action`, `--brand`, `--line`). Inside the sheet, match the blueprint exactly (plan §2).
- Real names in `reference/` are personal data: never copy them into code, seeds, fixtures or tests. Tests use invented names.

## Build list (Phase A)

1. **Schema** in `lib/schema.js` (+ `prisma/schema.prisma` and `docs/SCHEMA.sql` for parity): `org_chart`, `org_chart_version`, `org_position`, `org_assignment` as in plan §3. Indexes on `chart_id`, `(chart_id, box_key)`, `employee_id`.
2. **Migration**: on start, if `org_chart` is empty and `organization_node` has rows, convert each root tree into a chart + published version (group people into role boxes by title + department, then auto-arrange). Idempotent, advisory-locked, never deletes `organization_node`.
3. **Domain module** `lib/org-charts.js`: payload validation (zod), version state machine (`draft → pending_approval → published → superseded`; published is immutable), cycle check, seat/assignment invariants (shares ≤ 1 per person across charts), diff between two versions.
4. **Routes** `routes/org-chart-v2-routes.js` under `/api/org/charts`: list charts; get chart (published version + assignments); create chart; create draft from published; save draft (whole payload, optimistic concurrency via `updated_at`); live edits (assignment CRUD, box text, layout) on the published version; submit; approve/reject (HR Director role); publish; list versions; diff `?a=&b=`; import endpoints accept the parsed payload from the browser.
5. **Page** `frontend/public/org-structure-v2.jsx`, registered through the existing `org-structure-app-patch.js` mechanism when the flag is on:
   - A3 sheet canvas (plan §2), pages as tabs, pan/zoom/fit, smart alignment guides, snap 1/16 in.
   - Modes View / Edit / Restructure (plan §4), right-click and ⋯ menu with the listed actions, **Arrange team** per box, Auto-arrange that respects it.
   - Side panel: box fields; People list (add, remove, reorder, Joining + date, suffix, Move to…); Seats tab (Position IDs, approval state).
   - Draft banner with Compare (side-by-side sheets + change list) and Submit.
   - Metrics strip and soft warnings (plan §4), thresholds from `system_setting`.
   - Undo/redo, multi-select, keyboard shortcuts.
   - Phone: keep the existing drill-down list view; the sheet is desktop/tablet.
6. **Import**: `.vsdx` parser in the browser (JSZip from the existing vendor folder or a pinned CDN already allowed by the CSP) following the mapping in plan §5; CSV import reusing the prototype's column mapping. Imports always create a draft.
7. **Export**: vector PDF A4–A1 (jsPDF), `.vsdx` with shapes, glued connectors, header/footer bands and the logo (`frontend/public/arabtec-logo.svg`), SVG, CSV of assignments, JSON. Raster PDF fallback when text is not Latin-1.
8. **Tests** `backend/org_chart_v2_test.mjs`, added to `run_tests.mjs`: permissions (view vs manage vs HR Director approve), version state machine, published immutability, cycle rejection, delete promote vs branch, shares invariant, migration from `organization_node` (count preserved), diff output, flag off = old behaviour. A Visio import unit test on a small synthetic `.vsdx` built in the test (not the real file).

## Acceptance (owner checks these in the browser)

- Import `reference/Aliva_OC_-_Sep.vsdx` → draft whose sheet matches `reference/Aliva_OC_-_Oct.pdf` page 1 box for box: titles, counts, names, red joiners with dates, team headers, connectors with arrows, maroon bands, date.
- Publish it, export PDF A3 → prints readable on A3 like the original.
- Edit mode: add a person to "Site Engineer", mark a joiner with a date, drag a name to another box, re-route one line. Each shows in the audit log.
- Restructure: insert a manager above two boxes, delete a box promoting its reports, Compare shows those changes and the layer count change, Submit → approve as HR Director → published; the old version is in history.
- Visio export opens in Visio with boxes and attached connectors.
- `npm test` passes; flag off shows the current page unchanged.

When Phase A is merged, stop and report; Phases B–D follow the plan after owner review.
