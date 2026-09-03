# Arabtec ATS UI Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a production-safe visual stabilization of the deployed Arabtec Recruitment Hub today.

**Architecture:** Keep the deployed in-browser React SPA and the current three-stylesheet cascade. Add a source-level UI regression gate, make surgical JSX resilience/accessibility changes, and place visual overrides only in the last-loaded design-system stylesheet so the existing cascade remains predictable.

**Tech Stack:** React 18 via local browser assets, Babel standalone, CSS, Node.js test scripts, Express static serving.

**Spec:** `docs/superpowers/specs/2026-09-03-ui-readiness-design.md`

## Global Constraints

- Production UI changes are limited to `frontend/public/` and source-level tests in `backend/`.
- Do not change backend routes, response shapes, database schema, permissions, recruitment workflows, salary masking, CV parsing, email, secrets, or Render resources.
- Preserve `styles.css` → `arabtec-approved-ui.css` → `arabtec-design-system.css` load order.
- Do not edit `frontend-v2/`.
- Build the TypeScript bridge before running the full suite because `backend/dist/` is absent from a fresh clone.
- Deliver on `fix/ui-readiness`; do not merge directly to `main`.

---

### Task 1: Add the UI readiness regression gate

**Files:**
- Create: `backend/ui_readiness_test.mjs`
- Modify: `backend/run_tests.mjs`
- Test: `backend/ui_readiness_test.mjs`

**Interfaces:**
- Consumes: UTF-8 source from `frontend/public/index.html`, `app.jsx`, `intake-review.jsx`, and `arabtec-design-system.css`.
- Produces: a zero-exit source regression test that protects the readiness contract without adding browser dependencies.

- [ ] **Step 1: Write the failing test**

Create assertions that require `AppErrorBoundary`, `role="dialog"`, `aria-modal="true"`, a labelled modal close button, the rendered `icon` value in `Empty`, the `ui-readiness` CSS marker, responsive table and KPI rules, readable intake typography, and one shared cache version across all production JSX/CSS script and link URLs. Add `ui_readiness_test.mjs` to the explicit suite list in `run_tests.mjs`.

- [ ] **Step 2: Run test to verify it fails**

Run: `node ui_readiness_test.mjs`

Expected: FAIL because `AppErrorBoundary` and the `ui-readiness` CSS marker do not exist yet.

- [ ] **Step 3: Commit the failing test**

```bash
git add backend/ui_readiness_test.mjs backend/run_tests.mjs
git commit -m "test: define production UI readiness contract"
```

---

### Task 2: Add render resilience and shared-state accessibility

**Files:**
- Modify: `frontend/public/app.jsx`
- Test: `backend/ui_readiness_test.mjs`

**Interfaces:**
- Consumes: existing `Modal`, `Empty`, `Shell`, and root render functions.
- Produces: `AppErrorBoundary`, an accessible shared modal, context-aware empty states, and a guarded authenticated app surface.

- [ ] **Step 1: Implement `AppErrorBoundary`**

Add a class component with `getDerivedStateFromError`, `componentDidCatch`, and a recovery card with Reload and Sign out actions. Wrap the authenticated `<Shell>` route surface, leaving Login and forced password rotation reachable.

- [ ] **Step 2: Upgrade the shared `Modal`**

Add `role="dialog"`, `aria-modal="true"`, `aria-labelledby`, Escape handling, initial focus, focus restoration, and `aria-label="Close dialog"`. Keep the current `onClose` API and existing modal call sites unchanged.

- [ ] **Step 3: Repair `Empty` rendering**

Render the caller-provided icon when present, retain the cube as fallback, and add an error variant based on an explicit `tone="error"` prop. Update existing error call sites without changing request logic.

- [ ] **Step 4: Run the focused test**

Run: `node ui_readiness_test.mjs`

Expected: accessibility and resilience assertions pass; CSS assertions remain failing until Task 3.

- [ ] **Step 5: Commit**

```bash
git add frontend/public/app.jsx
git commit -m "fix: protect and clarify shared UI states"
```

---

### Task 3: Apply the production visual stabilization layer

**Files:**
- Modify: `frontend/public/arabtec-design-system.css`
- Modify: `frontend/public/intake-review.jsx`
- Modify: `frontend/public/app.jsx`
- Test: `backend/ui_readiness_test.mjs`

**Interfaces:**
- Consumes: existing class names and the current effective green/neutral/red visual language.
- Produces: a final `UI READINESS RELEASE` section that normalizes actions, responsive grids, tables, admin layouts, drawers, modals, and intake readability.

- [ ] **Step 1: Define release tokens and action hierarchy**

Add namespaced readiness tokens for action green, danger red, focus ring, control height, and readable muted text. Make `.btn-primary` a filled green action, keep `.btn-danger` visibly destructive, normalize min-height/padding/alignment, and prevent button-label clipping.

- [ ] **Step 2: Fix responsive layout rules**

Override the four-KPI `:has()` specificity defect at 1180, 900, and 640 pixels. Add safe wrapping for page heads and action rows, responsive admin split layouts, full-width narrow drawers/modals, and table overflow protection without changing table data.

- [ ] **Step 3: Fix typography and contrast**

Raise intake tables, citations, badges, and decision rows to a minimum readable scale. Override the selected role row to dark high-contrast text and improve muted/focus colors.

- [ ] **Step 4: Remove generic red accents from targeted surfaces**

Use green or neutral borders/underlines for conversation posts, field chips, candidate quick-view tabs, final decision cards, intake summaries, popovers, and Control Center tabs. Keep red for rejection, delete, failure, and critical status.

- [ ] **Step 5: Run the focused test until green**

Run: `node ui_readiness_test.mjs`

Expected: all UI readiness assertions pass.

- [ ] **Step 6: Commit**

```bash
git add frontend/public/app.jsx frontend/public/intake-review.jsx frontend/public/arabtec-design-system.css
git commit -m "fix: polish production layouts and responsive states"
```

---

### Task 4: Invalidate stale frontend assets

**Files:**
- Modify: `frontend/public/index.html`
- Test: `backend/ui_readiness_test.mjs`

**Interfaces:**
- Consumes: current query-string asset versioning.
- Produces: one new shared version value on every production CSS and JSX URL.

- [ ] **Step 1: Update all frontend asset query strings**

Change each CSS and JSX query string in `index.html` to the same new release value `20260903-ui1`.

- [ ] **Step 2: Run the focused test**

Run: `node ui_readiness_test.mjs`

Expected: PASS with one distinct production asset version.

- [ ] **Step 3: Commit**

```bash
git add frontend/public/index.html
git commit -m "chore: invalidate cached production UI assets"
```

---

### Task 5: Build, regression-test, and inspect representative routes

**Files:**
- No production file changes expected.
- Test: `backend/run_tests.mjs`, `backend/static_test.mjs`, browser screenshots.

**Interfaces:**
- Consumes: the complete release branch.
- Produces: fresh build/test evidence and desktop/tablet/mobile visual evidence.

- [ ] **Step 1: Build exactly as Render does**

Run: `npm run build`

Expected: TypeScript compilation exits 0 and creates `backend/dist/`.

- [ ] **Step 2: Rerun the previously failing intake route suite**

Run: `node --experimental-sqlite intake_route_http_test.mjs`

Expected: 9 passed, 0 failed after the build creates the required compiled bridge.

- [ ] **Step 3: Run the full test suite**

Run: `npm test`

Expected: 33 suites pass; real Claude parsing and PostgreSQL-only gates may report explicit skips when their credentials/services are absent, but no suite may fail.

- [ ] **Step 4: Start the seeded local application**

Run: `npm run seed && npm run start:sqlite`

Expected: `/api/health` becomes ready and the login page loads from the production static surface.

- [ ] **Step 5: Inspect representative routes**

Using a seeded administrator and recruiter, inspect Login, Dashboard, Requests, Request Detail, Talent Pool, Candidate Intake, Roles, Control Center, and the shared modal at 1440×900, 900×900, and 375×812. Confirm navigation remains usable, tables scroll instead of clipping, controls do not crop, and no route white-screens.

- [ ] **Step 6: Review the final diff**

Run: `git diff --check origin/main...HEAD && git status --short && git diff --stat origin/main...HEAD`

Expected: no whitespace errors, no untracked production files, and changes limited to the approved release boundary.
