# Organization Structure v2 — plan

Status: approved by owner · 2026-10-11
Scope: the Organization Structure page in the live Recruitment Hub (legacy monolith: `backend/src` + `frontend/public`).
Blueprint: `reference/Aliva_OC_-_Oct.pdf` and `reference/Aliva_OC_-_Sep.vsdx` (the Visio file is the source of truth for layout).

---

## 1. What exists today (verified in the repo)

| Piece | File | What it does |
|---|---|---|
| Data | `organization_node` table, `backend/src/lib/organization-nodes.js` | One row per person or unit. Free-text name, title, department, project. Optional `user_id`, `department_id`, `project_id` FKs exist but are unused ("for Phase 2 transfers"). |
| API | `backend/src/routes/org-chart-routes.js` on `/api/org/chart` | List, create, update, move, delete (node / branch / reassign children). Cycle checks. Every write goes to `audit_log`. Guarded by `org_chart.manage`. |
| Seed | `backend/src/lib/org-chart-seed.js` | Rebuilds HO + project charts from "Project Org Charts.zip" if the table is empty. Advisory-locked for multi-instance start. |
| Page | `frontend/public/org-structure.jsx`, injected by `lib/org-structure-app-patch.js` | Tree view with pan/zoom, drill-down list on phone, add/edit modal. One card per person. |
| Tests | `backend/org_chart_test.mjs` | Permissions, CRUD, cycles, delete rules, canvas-fit maths. |
| Related data | `designation` (title, grade, function, department), `project`, `site`, `department`, `recruitment_request` → `requisition_seat`, `lib/join.js` (single place an application becomes `joined`) | Everything the later integration needs already exists, except an employee register. |

**Gap against the blueprint.** The October chart is not one box per person. It is one box per **role**: title, planned headcount (`X4`, `X0.34 Shared`, `X5 zati`), then the names in that role, with new joiners in red with a date. Team header boxes ("QA/QC Team") group roles. Layout is hand-placed on an A3 landscape sheet with maroon bands. The current model cannot express planned headcount, shared people, or zati labour, and its auto-tree cannot reproduce the hand layout.

---

## 2. Target: what the user sees

The canvas **is** the A3 sheet, drawn exactly like the October PDF:

- A3 landscape page (1190 × 842 pt) on the Hub's grey canvas. Maroon header band `#860915` with the two heading lines, logo top-right, date bottom-right, maroon footer band.
- Role boxes: 81 pt wide (resizable), black 0.75 pt border, Arial Bold 8 pt centred, line height 9.6 pt, 4.5 pt padding. Lines: title, count, `- name` per person. Joiners in red with their date (`- Mohamed Khaled 30/10`).
- Team boxes: same style, title only ("Technical Team").
- Connectors: orthogonal, black 0.75 pt, arrowhead at the child. Default route: bottom-centre of the parent → mid-gap bus → top-centre of the child.
- Several pages per chart, as Visio tabs (page 1 = project chart, page 2 = "QA/QC" with a full-names text panel).
- Everything around the sheet uses the Hub shell: page head, `.card`, `.btn` (green `--action` #008064), red brand accent, sidebar, modals — the same components `org-structure.jsx` already uses. No new visual language outside the sheet.

**PDF/Visio export = the sheet.** What is on screen is what prints (vector PDF; `.vsdx` with real shapes and glued connectors).

---

## 3. Data model (new tables, old table kept)

```
org_chart            id, name, project_id?, department_id?, scope ('project'|'head_office'|'department'),
                     status ('active'|'archived'), current_version_id, created_by, created_at, updated_at

org_chart_version    id, chart_id, label, state ('draft'|'pending_approval'|'published'|'superseded'),
                     based_on_version_id?, payload_json (pages, boxes, links, layout — see below),
                     created_by, submitted_by?, approved_by?, published_at?, created_at, updated_at

org_position         id (stable Position ID, never reused), chart_id, box_key, slot_no,
                     approval ('approved'|'proposed'|'frozen'), requisition_seat_id? (Phase B),
                     created_in_version_id, closed_in_version_id?, created_at, updated_at

org_assignment       id, chart_id, box_key, position_id?, person_name, employee_id? (Phase C), user_id?,
                     status ('in_post'|'joining'|'leaving'), effective_date?, share (0–1, default 1),
                     suffix ('Sr.','Deputy',…), application_id? (Phase B/C), sort_order, notes,
                     created_at, updated_at
```

`payload_json` (one document per version, validated with zod):

```
{ pages: [{ key, name, title1, title2, date, paper:'A3', boxes:[...], links:[...], notes:[...] }] }
box  = { key, kind:'role'|'team'|'text', title, designationId?, planned, shared:bool, zati:bool,
         countLabel?, parentKey?, x, y, w, h?, text? }
link = { childKey, kind:'reports'|'dotted', fromSide, toSide, points?, style? }
```

Why this split:

- **Layout and structure are versioned as one document.** A restructure is a new version, not 200 row updates. Undo, compare and approval work on whole versions.
- **People are rows, not text.** Assignments live outside the layout so transfers, onboarding and the employee register can update them without rewriting a chart, and so "who is where" is queryable across every chart.
- **Every seat has a stable Position ID.** A role box showing `X4` owns four `org_position` rows. The ID survives title changes, moves and the person leaving, so an open requisition seat, a joiner and a later transfer all point at the same seat. Users never see the ID unless they open the box's "Seats" tab; the box still reads `X4` with names.
- **Approval, recruiting and occupancy are separate fields.** A seat can be approved and open at once; a proposed seat (drawn dashed, labelled "Proposed") is never counted as authorised hiring and cannot have a requisition until approved.
- **Shared people are one assignment per chart with a `share`.** Ahmed Hussien = 0.5 Aliva + 0.5 Al-Burouj, shown with "Shared" on both.
- `organization_node` stays readable. A one-off migration converts each existing node tree into an `org_chart` + first published version (grouping people into role boxes by title, like the export already does). The old routes stay until the new page ships; then they are marked deprecated, not deleted.

---

## 4. Editing model — the easy way to do each job

Principle: **small edits happen live; anything structural happens in a draft.** A draft is a full copy of the published version. Nothing a draft does reaches the published chart until it is published.

### Three modes, one switch in the page head

| Mode | Who | What it allows | How it looks |
|---|---|---|---|
| **View** | Everyone signed in | Pan, zoom, search, hide/show teams, export | Sheet only; side panel shows details read-only |
| **Edit** | `org_chart.manage` | People rows (add, remove, joining date, move between boxes), box text, line routes, positions on the sheet | Green "Editing live" pill; every save is audited |
| **Restructure** | `org_chart.manage` | Everything, including layers, splits, merges, deletes, imports | Draft banner "Restructure draft — not published" with Compare and Submit |

One right-click menu on any box (and a ⋯ button for touch) holds every structural action, so nobody has to learn where things are:
**Add report · Add peer · Insert manager above · Insert level below · Arrange team ▸ (Row · Column left · Column right · Two columns) · Hide/show team · Move people… · Transfer people… · Delete ▸ (Promote reports · Delete branch)**. Structural items are greyed with "Use Restructure" in Edit mode.

**Arrange team** is a per-manager layout setting stored on the box, like Visio's Arrange Subordinates. Auto-arrange respects each box's choice, so the Admin column stays a column and site teams stay in a row. This is what makes the October layout reproducible without hand-placing every box.

### Live checks while editing (from org-design practice)

A metrics strip above the sheet updates on every change: **Planned · In post · Joining · Open · Proposed · Layers · Widest span**. Soft warnings (toast plus an amber dot on the box, never blocking):

- Span of control above 12 or below 3 direct report boxes (staff roles only; zati/labour boxes are excluded because site crews legitimately run large).
- More than 6 layers from the Project Manager down.
- A manager box with nobody in post (single point of failure).
- A person whose shares across charts add up to more than 1.

Thresholds live in `system_setting` so HR can tune them for site versus head-office charts.

| Job | How the user does it | Where |
|---|---|---|
| Edit a role | Click the box → side panel: title (designation picker), planned count, Shared, zati, width. | Live or draft |
| Add / remove a person | Side panel "People" list: add row, type name or pick employee (Phase C), mark Joining + date. Remove = row ✕. | Live |
| Reorder names | Drag rows in the panel. | Live |
| Transfer within a chart | Drag a name from one box onto another box on the canvas, or "Move to…" in the row menu. | Live |
| Transfer to another project | Row menu "Transfer…" → pick chart + box + effective date. Creates `leaving` in the source and `joining` in the target until the date, then settles. | Live (logged) |
| Add a box under / beside | Select box → `Tab` (report) / `Enter` (peer), or drag "Role box" from the palette onto a parent. | Live or draft |
| **Add a layer** | Select one or more boxes → "Insert manager above": new box takes their place, they report to it. "Insert level below": new box takes over the selected box's reports. | Draft |
| **Remove a layer** | Delete box → choose "Promote its reports to the parent" (default) or "Delete the whole branch" (confirm, shows count). Same rules the API enforces today. | Draft |
| Move a team | Drag a box; its whole branch moves with it (Alt = box only). Drop onto another box = new manager. | Live or draft |
| Re-route a line | Click a line → drag segment squares; drag end dots to another side or another box. | Live or draft |
| **Full restructure** | "Start restructure" → draft opens with an **effective date**. Bulk moves, merges, splits, layer changes, re-import from Visio/Excel. Several drafts may exist side by side ("Option A / Option B"). **Compare** shows the two sheets side by side with changes highlighted, plus a change list: roles added / removed / moved, seats ± (approved vs proposed), people moved, layers and spans before → after. Submit → HR Director approves → publishes on the effective date. Old version stays in history. | Draft only |
| Tidy | "Auto-arrange" (tree with stacked leaf columns, top level wraps to fit A3) — selection or whole page. Hand-placed positions are kept unless the user runs it. | Live or draft |

Always available: undo/redo, multi-select (Shift / frame), align & distribute, smart alignment guides while dragging, snap to 1/16 in, zoom/fit, search (jumps to a person), keyboard shortcuts.

**Guard rails** (server-side, same style as `join.js`): no cycles; one box per `box_key` per version; a person may hold several assignments only if shares sum ≤ 1; a published version is immutable; every change writes `audit_log` with before/after.

---

## 5. Import / export

- **Import Visio (.vsdx)** in the browser (JSZip + DOMParser). Mapping proven on the October file: top-level "Executive Belt" shapes → boxes (title = first sub-shape text; main text → `X…` count line + `- name` lines; red character runs → `joining`; trailing `dd/mm` → effective date; `– Sr.` / `- Deputy` → suffix); `Dynamic connector` + `Connects` → links with sides (`Connections.Top/Bottom/Left/Right`) and route points; bands → page titles; "Date: …" → date; second page → second chart page. Import always creates a **draft**.
- **Import Excel/CSV** (existing column mapping from the prototype) → draft with auto-arrange.
- **Export**: PDF (A4–A1, vector; raster fallback for Arabic), Visio `.vsdx`, SVG, CSV of assignments, JSON backup. All from the published version or the open draft.

---

## 6. Hub integration (later phases, designed in now)

| Hub data | Link | Effect on the chart |
|---|---|---|
| Designations (`designation`) | `box.designationId` | Title and grade come from the catalogue; renaming a designation updates every chart. Free text still allowed for odd roles. |
| Projects / departments | `org_chart.project_id` / `department_id` | One chart per project; HO chart per department. Chart list grouped by business unit. |
| Open positions (`recruitment_request` / `requisition_seat`) | Seats carry `org_chart_id` + `box_key` | Box shows `Open 2 · REQ-0412`. Vacant slot → "Raise request" pre-fills project, designation, headcount. |
| Onboarding (`lib/join.js`) | When an application joins against a linked seat, the same transaction inserts an `org_assignment` (status `joining`, date = joining date) | Name appears in red on the chart with its date; turns black on the date. No manual typing. |
| Employees (new `employee` register, Phase C) | `org_assignment.employee_id` | Import from the HR Master Sheet; full name, MB number, grade, location on hover and in exports. Leavers flow from the register. |

Reconciliation: each chart shows "Data from: HR Master Sheet, imported 04 Oct 2026" (source + date). A monthly re-import of the register lists differences (in chart but not in register, and the reverse) for HR to accept one by one — the same check done by hand for the Aliva CSV.

Respect the module seams in `docs/MODULE_EXTRACTION_MAP.md`: the chart reads hiring data through route DTOs and the join transaction calls one exported function (`OrgAssignments.fromJoin(...)`); org code never writes hiring tables.

---

## 7. Phases

| Phase | Delivers | Size |
|---|---|---|
| **A — Editor v2** | New tables + migration from `organization_node`; versioned charts (draft / published / history = "Saved charts" tab); A3 sheet canvas matching the blueprint; side panel; people rows; live vs draft rules; Visio + CSV import; PDF/Visio/SVG/CSV export; permissions & audit; tests. | Largest. Ship behind a feature flag (`lib/feature-flags.js`). |
| **B — Hub links** | Designation picker; project/department binding; seats ↔ boxes, "Raise request" from a vacant slot; open-count badges. | Medium |
| **C — People** | `employee` register + HR Master Sheet import; assignments by employee; Transfer workflow with effective dates; onboarding hook in `join.js`; shared people across charts. | Medium–large |
| **D — Restructure** | Version diff view, submit / approve / publish (HR Director, matching the single-approval rule), headcount plan vs actual report per chart. | Medium |

Phase A acceptance is listed in `CLAUDE_CODE_HANDOFF.md`.

---

## 8. Owner decisions (2026-10-11)

1. **Publishing a restructure**: editors with `org_chart.manage` build drafts; the **HR Director approves** before a draft is published. Small live edits (names, joiners, moves within a chart, line routes) do not need approval.
2. **Red names** mean **new joiners**: red with their start date until that date, then black. No leaver marking for now.
3. **Employee register**: the **Hub becomes the register**, seeded once from the HR Master Sheet; charts, transfers and onboarding update it from then on.
4. **Logo**: use the Hub's vector `frontend/public/arabtec-logo.svg` on every chart (the logo inside the Visio file is a low-resolution bitmap).
5. **Delivery**: Claude Code builds Phase A in a cloud session on a branch and opens a PR for owner review.

---

## References used for the editing model

- Workday Adaptive Planning 2026R1, org design and scenario modeling (sandbox scenarios, drag-and-drop, side-by-side comparison, live span/layer metrics with soft warnings, approval routing): https://doc.workday.com/adaptive-planning/en-us/what-s-new/releases/2026r1-release-notes/2026r1-planning-for-hcm-and-financials/org-design-and-scenario-modeling.html
- ChartHop, creating jobs in a scenario: https://docs.charthop.com/creating-new-jobs-in-a-scenario
- Creately, turning workforce plans into hiring plans with org charts (stable Position IDs, separate approval / recruiting / occupancy status, approved vs proposed labelling, reconciliation): https://creately.com/guides/turn-workforce-plans-into-hiring-plans-with-org-charts/
- Microsoft Visio, lay out the shapes in an organization chart (Arrange Subordinates, Show/Hide Subordinates, Re-Layout keeps per-manager choices): https://support.microsoft.com/en-US/Visio/lay-out-the-shapes-in-your-organization-chart
