# Arabtec Recruitment Hub — Phase 3 Handover Package
**Status:** Phase 3 closed & QA-accepted. **Phases delivered: 1, 2, 3.** Phase 4 not started (awaiting explicit approval).
**Date:** 14 June 2026 · **Build:** runnable Node + node:sqlite app · **Tests:** 146/146 passing.

This is the single handover reference for Phase 3. Companion documents: `PHASE3_SUMMARY.md` (implementation), `PHASE3_QA_AUDIT.md` (QA review), `README.md` (run instructions), `backend/docs/SCHEMA.sql` (Postgres DDL).

---

## 1. Final changed-files summary

### Application source (what runs)
| File | Lines | Role |
|------|-------|------|
| `backend/src/server.js` | ~70 | Express app; mounts auth, users, roles, org, settings, audit, **requests, candidates, applications**; serves SPA |
| `backend/src/lib/schema.js` | 376 | node:sqlite DDL — Phase 1 + 2 + 3 tables (source of truth at runtime) |
| `backend/src/lib/models.js` | 566 | Repositories incl. Phase 3 `Candidates, CandidateDocuments, Applications, StageHistory, CandidateNotes, CandidateActivity, RejectReasons` |
| `backend/src/lib/permissions.js` | 192 | Permission catalog, role matrix, button registry (Phase 3 perms + buttons) |
| `backend/src/lib/db.js` | 64 | node:sqlite driver + `get/all/run/exec/tx` helpers |
| `backend/src/lib/auth.js`, `audit.js` | 40 | JWT/context; append-only audit writer |
| `backend/src/middleware/auth.js` | 54 | `requireAuth`, `requirePermission` (server-side RBAC) |
| `backend/src/routes/requests.js` | 387 | Phase 2 requisition lifecycle |
| `backend/src/routes/candidates.js` | 169 | **Phase 3** candidate CRUD, dedup, documents, notes |
| `backend/src/routes/applications.js` | 227 | **Phase 3** link, pipeline moves, bulk, vacancy automation (overfill-safe, transactional) |
| `backend/src/routes/{auth,users,roles,org,settings,audit}.js` | ~520 | Phase 1 routes |
| `frontend/public/app.jsx` | 1706 | Full SPA incl. Talent Pool, candidate profile (6 tabs), pipeline (Kanban/List/Compact) |
| `frontend/public/{index.html,styles.css}` | ~330 | SPA shell + Arabtec theme |

### Schema parity files (documentation / migration targets)
| File | Role |
|------|------|
| `backend/prisma/schema.prisma` | Canonical Prisma model — **now aligned** with Phase 1+2+3 |
| `backend/docs/SCHEMA.sql` | PostgreSQL DDL — **now aligned**, incl. seat-fill columns and `UNIQUE(candidate_id, request_id)` |
| `backend/prisma/seed.js` | Idempotent seed (roles, perms, org, branding, buttons, reject reasons, counters) |

### Tests
| File | Checks |
|------|--------|
| `backend/inproc_test.mjs` | 27 (Phase 1: auth, RBAC, admin, audit) |
| `backend/phase2_test.mjs` | 31 (requisition lifecycle) |
| `backend/phase3_test.mjs` | 33 (candidates/applications/pipeline) |
| `backend/phase3_qa_test.mjs` | 49 (QA edge cases) |
| `backend/static_test.mjs` | 6 (static + SPA serving) |
| `backend/smoketest.mjs` | shared by Phase 1 suite |

### Phase 3 QA delta (changes made during the audit)
- `applications.js` — overfill guard (`hasOpenSeat`), **transactional** `fillSeatAndCount` (`tx()`), `request.vacancy_changed` audit, bulk `skipped[]` partial-failure reporting, bulk-assign recruiter existence check.
- `prisma/schema.prisma` — added all Phase 2/3 models (parity fix).
- `frontend/public/app.jsx` — bulk toast reports "N updated, M skipped".
- `phase3_qa_test.mjs` — new 49-check suite.

> Housekeeping: two `.DS_Store` files may appear in the tree; they are macOS artifacts and are already excluded by `.gitignore`. Scratch `dbg*.mjs` files (if present) are not part of the app and are gitignored.

---

## 2. Final test results
| Suite | Result |
|-------|--------|
| Phase 1 | **27 passed, 0 failed** |
| Phase 2 | **31 passed, 0 failed** |
| Phase 3 | **33 passed, 0 failed** |
| Phase 3 QA | **49 passed, 0 failed** |
| Static / SPA | **6 passed, 0 failed** |
| **Total** | **146 passed, 0 failed** |

Frontend `app.jsx` compiles cleanly with `@babel/preset-react`. Re-run any suite with `node --experimental-sqlite <file>.mjs` from `backend/`.

---

## 3. Migration / schema notes
- **Runtime DB:** the app runs on **Node's built-in `node:sqlite`** (`src/lib/schema.js` creates tables idempotently on boot). Requires **Node ≥ 22.5**.
- **Three schema artifacts are in parity:** `schema.js` (SQLite/runtime), `schema.prisma` (canonical model), `docs/SCHEMA.sql` (PostgreSQL DDL). When changing the data model, update **all three**.
- **Phase 3 tables:** `candidate` (no application status; only `candidate_state` lifecycle), `candidate_document`, `application` (owns status + `UNIQUE(candidate_id, request_id)`), `application_stage_history`, `candidate_note`, `candidate_activity`, `reject_reason`. Seat-fill columns `requisition_seat.filled_by_application_id` and `filled_at` are present in all three files.
- **Integrity:** `application.candidate_id` / `application.request_id` are `NOT NULL` FKs with `ON DELETE CASCADE` → no orphan applications. Seat fill is transactional (`tx()`).
- **Counters/settings seeded:** `candidate_counter`, `application_counter`, `application_prefix`, `allow_duplicate_application` (+ Phase 2 request counter and SLA/thresholds).
- **Production migration path:** for PostgreSQL, either run `docs/SCHEMA.sql` or adopt Prisma Migrate against `schema.prisma`, then point a `pg`-backed `db.js` at it (the repository layer in `models.js` and all routes are unchanged — only the `get/all/run` driver swaps).

---

## 4. Known limitations & confirmed Phase 4 scope
**Known limitations (intentional, documented):**
- File uploads & embedded CV viewer are metadata-only today (the API records document metadata + an optional CV hash for dedup).
- Interviews and Offers tabs are placeholders.
- Full candidate **record-merge** (combining two candidates' applications) is not built; only the audited duplicate-**override-with-reason** flow exists. No non-functional "Merge" button is exposed.
- Kanban stage moves are click-driven (Actions menu), not HTML5 drag-and-drop.
- Candidate visibility is permission-based, not yet project-scoped.
- In-app notifications/email are not yet implemented.

**Confirmed Phase 4 scope (do NOT start until approved):**
1. **Interview Management** — scheduling, panels, scorecards, interviewer feedback (attaches to an `application`).
2. **Offer Management** — offer builder, approval chain, send/track, accept/decline → ties to the existing `offer_*` application statuses.
3. **Notifications** — in-app + email on key events (assignment, stage change, HM feedback, offer, SLA).
4. **Document storage** — real CV/attachment upload + viewer + CV-hash dedup enforcement.
5. (Stretch) Candidate record-merge tool; drag-and-drop Kanban.

---

## 5. Deployment / production caution notes
- ⚠️ **`npm run reset` is destructive and local-demo only.** It deletes the SQLite database file and re-seeds from scratch. **Never run it against any shared or production database.** In production, use **migrations** (Prisma Migrate or versioned SQL from `docs/SCHEMA.sql`) — never reset.
- ⚠️ **Set a strong `JWT_SECRET`** in `.env` for anything beyond local use; the committed default is for local demo only. Set `NODE_ENV=production` to enable secure cookies, and serve over **HTTPS**.
- ⚠️ **SQLite is single-process and file-local.** Its transactions are synchronous and adequate for the local demo, but production should run **PostgreSQL** for concurrency, connection pooling, and full transactional guarantees under load. The code is structured for this swap (see §3).
- ⚠️ **`node:sqlite` is an experimental Node feature** (requires the `--experimental-sqlite` flag, already wired into the npm scripts) and needs **Node ≥ 22.5**. Pin the Node version in your deployment environment.
- ⚠️ **Audit log is append-only by convention** in this build. In PostgreSQL, additionally `REVOKE UPDATE, DELETE ON audit_log` from the app role (noted in `SCHEMA.sql`) to enforce immutability at the database level.
- ⚠️ **Seed accounts use shared demo passwords** (`Admin@12345`, `Arabtec@123`). Rotate/disable them before any non-local deployment.
- ℹ️ **Backups:** before any schema change in a real environment, back up the database; the local `.db` file is gitignored and not a backup mechanism.

---

## 6. How to run (recap)
```bash
cd backend
cp .env.example .env        # set a real JWT_SECRET for non-local use
npm install
npm run reset               # LOCAL ONLY: create + seed the demo DB
npm start                   # http://localhost:4000
```
Admin login: `admin@arabtec.com` / `Admin@12345`. Role accounts: `<role>@arabtec.com` / `Arabtec@123`.

---

**Phase 3 handover is complete. No Phase 4 work will begin until you explicitly say: “Approved. Continue to Phase 4.”**
