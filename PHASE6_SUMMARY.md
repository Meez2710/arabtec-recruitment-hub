# Arabtec Recruitment Hub — Phase 6 Report
**Module:** Dashboards (read-only analytics). **Not built:** Reports (still out of scope).

**Tests:** full regression **284/284 passing** (P1 27 · P2 31 · P3 33 · P3-QA 49 · P4 32 · P4-QA 36 · P5 49 · **P6 21** · static 6); frontend compiles clean.
Run: `cd backend && npm run reset && npm start` → http://localhost:4000.

---

## 1. What was implemented
A role-aware analytics dashboard that aggregates the data built across Phases 1–5 (requests, applications/pipeline, interviews, offers). It is **purely read-only** — no new business entities, no mutations, no schema changes.

- **`GET /api/dashboard`** — a single endpoint returning KPIs + chart datasets, gated by `dashboard.view`.
- **KPI cards:** Open Requests, Fill Rate (filled/total seats), Candidates in Pipeline, Upcoming Interviews, Offers, Offer-Acceptance Rate, Joined, Avg Time-to-Fill.
- **Charts (inline SVG, no external libraries):** Requests by Status (bar), Requisition Aging buckets (0–30/31–60/61–90/90+), Pipeline Funnel (applications by stage), Offer Outcomes (bar), Recruiter Load (org-wide only), and a **My Work** panel (my open requests, my upcoming interviews, offers awaiting my approval).
- The home page (previously a placeholder/static KPI grid) is replaced with this live dashboard.

## 2. Critical constraints honored
| Requirement | Status |
|---|---|
| Dashboards only — no Reports | ✅ Reports not built |
| Read-only (no mutations) | ✅ single GET; POST/PUT to `/api/dashboard` → 404 |
| Scope-enforced server-side | ✅ `request.view_all` → org-wide; `request.view_own` → only own requests |
| No salary / restricted-field leakage | ✅ payload verified to contain no "salary"/"expected"/"benefit"; salary tables never queried |
| Permission-gated | ✅ `requirePermission('dashboard.view')`; 401 without token |
| Reuse existing foundation | ✅ aggregates existing tables; no new entity/schema |

## 3. Files changed / added
- **Added:** `backend/src/routes/dashboard.js` (aggregation endpoint); `backend/phase6_test.mjs` (21 checks); `PHASE6_SUMMARY.md`.
- **Changed:** `backend/src/server.js` (mount `/api/dashboard`); `frontend/public/app.jsx` (new `Dashboard` analytics component + inline-SVG `BarChart` / `Funnel` / `ChartLegend` helpers, replacing the placeholder); `README.md`.
- **No schema changes** (read-only analytics) → SQLite/Prisma/Postgres remain in parity from Phase 5.

## 4. Permissions
No new permissions. The dashboard uses the existing `dashboard.view` (held by all roles) for access, and the existing `request.view_all` / `request.view_own` to decide org-wide vs own scope. `offer.approve` gates the "offers awaiting my approval" widget figure.

## 5. KPI / metric definitions
- **Open Requests:** requests in non-terminal states (draft → in_progress, partially_filled, on_hold, reopened).
- **Fill Rate:** Σ headcount_filled ÷ Σ headcount (seats), scoped.
- **Candidates in Pipeline:** total applications in scope.
- **Upcoming Interviews:** interviews with status `scheduled` and a future date.
- **Offers / Offer-Acceptance Rate:** total offers; accepted (incl. joined) ÷ (accepted + candidate-rejected).
- **Joined:** offers in `joined` status.
- **Avg Time-to-Fill:** mean days from `opened_at` → close/last-update for `filled` requests (approximation; documented as such).
- **Aging:** open requests bucketed by age of `opened_at`/`created_at`.
- **Recruiter Load:** open requests grouped by owner (org-wide only).

## 6. UI components added
Analytics `Dashboard` with KPI cards, two-up chart rows (status + aging, funnel + offers), My Work panel, and (org-wide) Recruiter Load table; inline-SVG `BarChart`, `Funnel`, `ChartLegend`; Arabtec brand colors; scope badge ("Org-wide" / "My scope"); empty + loading + permission-error states.

## 7. Audit logs
None added — dashboards are read-only and intentionally write **no** audit entries (verified by test: no `dashboard.*` actions are logged). All prior audit behavior is unchanged.

## 8. Still placeholder / not in this phase
- **Reports** (exportable/scheduled reports, CSV/PDF) — not built.
- Date-range filtering and drill-down on the dashboard are basic (aging is bucketed; no custom date picker yet).
- Time-to-fill is an approximation from request open/close timestamps (no per-seat fill-time history).
- Charts are lightweight inline SVG (no zoom/tooltip library).

## 9. Assumptions made
- All seeded roles already hold `dashboard.view`; scope is derived from request-view permissions rather than a new permission.
- "Own scope" = requests the user owns, requested, or created (consistent with the request module's own-scope rule).
- Salary is deliberately excluded from all dashboard aggregates (no compensation analytics in this phase).

## 10. Known limitations
- Aggregations run on demand per request (fine at demo scale; for very large datasets, materialized views/caching would be added — a production concern, not a correctness issue).
- Recruiter Load is shown only org-wide (own-scope users see just their My Work figures).
- No real-time refresh; the page loads metrics on mount.

## 11. Manual testing checklist
1. Log in as **hr.manager@arabtec.com** → Dashboard shows **Org-wide** badge, KPI cards, and all charts.
2. Create/approve/assign a 2-seat request, link a candidate, take them through offer → **Mark Joined**; reload the dashboard → Fill Rate shows 50%, Joined = 1, request appears under "partially_filled".
3. Log in as **recruiter@arabtec.com** → Dashboard shows **My scope** badge; Recruiter Load table is hidden; only your own requests are counted.
4. Log in as **hiring.manager@arabtec.com** → **My scope**; figures limited to your own requests.
5. Confirm **no salary** anywhere on the dashboard (the offer/candidate salary never appears).
6. Confirm the dashboard is read-only (no buttons mutate data); navigating away and back reloads metrics.
7. (API) `GET /api/dashboard` without a token → 401; `POST /api/dashboard` → 404.

## 12. Readiness for Phase 6 QA
All Phase 6 scope implemented and tested; 284/284 checks pass; dashboard is read-only, permission-gated, scope-enforced, and leaks no salary/restricted data; no schema changes (parity preserved); frontend compiles clean. Ready for QA.

**Stopping after Phase 6 as instructed. Reports (or any further phase) will not begin without your explicit approval.**
