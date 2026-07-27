# Pre-Merge Snapshot — Rollback Reference

**Generated:** 2026-07-27
**Purpose:** Authoritative record of repository state immediately **before** the
consolidation merge of `feature/auth-user-security-system` and
`feature/cv-parsing-engine` into `main`. If the merge must be undone, this
document is the reference for restoring the prior state.

---

## 1. Rollback Instructions (read this first)

The merge is **local only** — nothing was pushed. `origin/main` still points at
`e08bb82`. Rollback is therefore non-destructive to any remote or deployment.

```bash
# Full rollback — restore main to its pre-merge commit
git checkout main
git reset --hard e08bb82

# The feature branches are untouched by the merge and still exist:
#   feature/auth-user-security-system -> d457322
#   feature/cv-parsing-engine         -> e1ee1c9
```

Because `origin/main` was never advanced, a `git fetch && git reset --hard origin/main`
also restores the pre-merge state.

---

## 2. Branch Topology (pre-merge)

```
* e1ee1c9  (feature/cv-parsing-engine)          feat(cv): modular parser, structured persistence, stabilization fixes
| * d457322 (feature/auth-user-security-system) fix(auth): secure password change and user management gates
|/
* e08bb82  (origin/main, main, origin/HEAD)     fix: make user password create/reset usable from the UI
* 981f880  (feature/ats-ui-enhancement-phase-1) fix: correct candidate pipeline stage vocabulary and smooth move UX
* 2b7ec96                                       feat: polish ATS UI for publish-ready shell and core pages
* aff5d6b                                       feat(ui): apply approved app shell
* 9bcfd67                                       feat(ui): apply approved internal design tokens foundation
* 3246f8c                                       chore: bump frontend asset cache version
```

Both feature branches share the same parent, `e08bb82`. Neither has been
rebased. There is no divergence between `main` and `origin/main`.

## 3. Active Branches and Commit Hashes

| Branch | Hash | Tracking | Ahead/Behind `main` | Pushed |
|---|---|---|---|---|
| `main` | `e08bb82` | `origin/main` | — | yes |
| `feature/auth-user-security-system` | `d457322` | none | +1 / 0 | **no** |
| `feature/cv-parsing-engine` | `e1ee1c9` | none | +1 / 0 | **no** |
| `feature/responsive-mobile-tablet-ui` | `e08bb82` | none | 0 / 0 | n/a — **empty** |
| `feature/user-password-create-reset-ui` | `e08bb82` | `origin/...` | 0 / 0 | yes |
| `feature/ats-ui-enhancement-phase-1` | `981f880` | `origin/...` | 0 / −1 | yes |
| `consolidation` | `92bca64` | none | historical | no |
| `stage1-production-blockers` | `217ccee` | none | historical | no |
| `master` | `faf5d97` | `origin/master` | behind 37 | yes — **abandoned** |

`origin` = `https://github.com/Meez2710/arabtec-recruitment-hub.git`

**Note on `feature/responsive-mobile-tablet-ui`:** this branch is empty. The
responsive CSS work it was created for was made in the working tree, never
committed, and followed a branch switch into `d457322`. The auth commit
therefore contains responsive/shell CSS despite its title. This is corrected by
amending the commit message during the merge.

## 4. Files Changed Per Branch

### `feature/auth-user-security-system` (`d457322`) — 9 files, +402 / −23

| File | Δ |
|---|---|
| `backend/src/lib/passwords.js` | +89 |
| `backend/src/lib/models.js` | +3 |
| `backend/src/middleware/auth.js` | +26 |
| `backend/src/routes/auth.js` | +2 / −1 |
| `backend/src/routes/roles.js` | +26 |
| `backend/src/routes/users.js` | +41 |
| `frontend/public/app.jsx` | +161 |
| `frontend/public/index.html` | +2 / −2 |
| `frontend/public/styles.css` | +73 |

### `feature/cv-parsing-engine` (`e1ee1c9`) — 19 files, +2,078 / −252

| File | Δ | Status |
|---|---|---|
| `backend/src/lib/cv/extractor.js` | +72 | new |
| `backend/src/lib/cv/section-detector.js` | +116 | new |
| `backend/src/lib/cv/dictionaries.js` | +186 | new |
| `backend/src/lib/cv/entity-parser.js` | +422 | new |
| `backend/src/lib/cv/normalizer.js` | +97 | new |
| `backend/src/lib/cv/validator.js` | +100 | new |
| `backend/src/lib/cv/confidence-engine.js` | +129 | new |
| `backend/src/lib/cv/ai-parser.js` | +52 | new |
| `backend/src/lib/cv/index.js` | +122 | new |
| `backend/src/lib/cv-mapper.js` | +95 | new |
| `backend/src/lib/cv-parser.js` | −217 net | rewritten as facade |
| `backend/src/lib/models.js` | +47 | modified |
| `backend/src/lib/schema.js` | +21 | modified |
| `backend/src/lib/upload.js` | +1 / −1 | modified |
| `backend/src/routes/candidates.js` | +72 | modified |
| `frontend/public/app.jsx` | +161 | modified |
| `frontend/public/styles.css` | +46 | modified |
| `frontend/public/index.html` | +2 / −2 | modified |
| `docs/PARSER_TECHNICAL_SPECIFICATION.md` | +327 | new |

### Overlapping files (both branches touch)

`backend/src/lib/models.js`, `frontend/public/app.jsx`,
`frontend/public/styles.css`, `frontend/public/index.html`

## 5. Database / Schema Differences

**Auth branch: no schema change.** Zero migrations, zero column additions. The
password-rotation gate reads the pre-existing `must_change_password` column,
which was already present on `main` (it was written but never consumed).

**Parser branch: three additive columns plus nine indexes**, all applied through
the existing idempotent helpers in `backend/src/lib/schema.js`:

```js
addColumnIfMissing('candidate', 'parse_status',     'TEXT');
addColumnIfMissing('candidate', 'parse_confidence', 'REAL');
addColumnIfMissing('candidate', 'parsed_at',        'TEXT');
```

Indexes, each wrapped in `try { run(stmt); } catch {}`:

`idx_candidate_created_at`, `idx_candidate_full_name`, `idx_candidate_company`,
`idx_candidate_university`, `idx_candidate_grad_year`,
`idx_candidate_years_exp`, `idx_candidate_screening`,
`idx_candidate_parse_status`, `idx_candidate_state` — all on `candidate`.

**Deliberately absent:** no `resume_text` column. The uploaded resume file
remains the single source of truth and is re-read on demand. This was an
approved design decision.

**Rollback impact:** additive-only. Rolling back the code leaves the three
columns and nine indexes in place on any database that has already started. They
are unused by pre-merge code and cause no error. **No down-migration is
required, and none exists.**

## 6. API Differences

**No endpoint was added, removed, or renamed on either branch.** Every change is
behavioural, within existing routes.

### Auth branch

| Endpoint | Change | Backward compatibility |
|---|---|---|
| `POST /api/auth/login` | unchanged contract | compatible |
| *all authenticated routes* | `requireAuth` now returns **403 `password_change_required`** when `must_change_password` is set, except for an allow-list (self password change, logout, session read) | **BREAKING for any client that does not handle 403** — the SPA handles it; no other client exists |
| `POST /api/users` | enforces 12-char policy; returns `temporaryPassword` once | compatible |
| `PUT /api/users/:id` | refuses to deactivate or demote the last active admin (409) | new failure mode only |
| `PUT /api/roles/:id/permissions` | refuses to grant governance permissions (`user.manage`, `role.manage`) to a role the caller does not already hold (403) | new failure mode only |

### Parser branch

| Endpoint | Change | Backward compatibility |
|---|---|---|
| `GET /api/candidates` | **response shape changed** from a bare array to `{ candidates: [...], pagination: { page, pageSize, total, totalPages, hasMore } }`. Accepts new `page`, `pageSize`, `sort`, `dir` query params. | **BREAKING** — the only consumer is `CandidatesPage` in `app.jsx`, updated in the same commit |
| `POST /api/candidates/:id/parse-cv` | now persists structured fields, stores a SHA-256 `fileHash`, returns a `report` object | additive |
| candidate serializer | adds `parseStatus`, `parseConfidence`, `parsedAt` | additive |

The `GET /api/candidates` shape change is the single most significant
compatibility risk in this merge. It is contained: no external integration
consumes this endpoint.

## 7. Frontend Differences

Both branches modify `frontend/public/app.jsx`, but **touch disjoint components**:

| Branch | Components touched |
|---|---|
| auth | `App`, `Login`, `Shell`, `ReqHealth`; new `ChangePasswordForm`, `ForcedPasswordChange`, `Forbidden`, `PasswordRules` |
| parser | `CandidatesPage`, `LinkCandidateModal`; new `downloadResume`, `SortTh`, `ParseQuality`, `Pager` |
| **both** | **none** |

CSS: both append a new block at end-of-file. Auth adds shell/responsive rules
(`@media` breakpoints, forced-password-change layout). Parser adds
`.sort-th`, `.pq*`, `.filter-chips`, `.chip-filter`, `.pager`.

`.card.flush` appears 2× on `main`, 2× on auth, 3× on parser — worth verifying
post-merge that the `overflow-x: auto; overflow-y: hidden` correction is not
duplicated.

Frontend has **no build step**. `app.jsx` is compiled in-browser by
Babel-standalone. A syntax error blanks the entire SPA, so post-merge syntax
verification is mandatory.

## 8. Configuration Differences

| Item | `main` | auth | parser |
|---|---|---|---|
| `render.yaml` | unchanged | unchanged | unchanged |
| `package.json` (root/backend) | unchanged | unchanged | unchanged |
| Upload cap (`upload.js`) | 15 MB | 15 MB | **20 MB** |
| `index.html` cache token | `v=20260726k` | `v=20260727b` | `v=20260727d` |
| New env vars | — | — | `CV_AI_PARSING_ENABLED` (default false), `ANTHROPIC_API_KEY` (optional) |

No new runtime dependency was added by either branch. No secret is present in
either commit.

**Deployment note (unchanged by this merge):** `render.yaml` uses
`rootDir: backend` with `autoDeploy: true` and **no `buildFilters`**.
Frontend-only commits therefore do not trigger an automatic deploy. This merge
contains backend changes, so it will deploy automatically once pushed —
which is precisely why it must not be pushed before browser verification.

## 9. Known Excluded File

`HR_DIRECTOR_HANDOVER.md` is intentionally **untracked**. It contains a live
credential and must never enter git history. It is present in the working
directory only.

---

*This snapshot is a point-in-time record. It is not updated after the merge;
the post-merge state is described in the Merge Report.*
