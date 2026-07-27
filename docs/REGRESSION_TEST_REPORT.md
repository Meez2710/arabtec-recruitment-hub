# Regression Test Report — Phase 2

**Build:** `main` + Phase 2 fixes · **Date:** 2026-07-27
**Result:** **94 checks · 93 pass · 1 known non-defect**
**Baseline:** Phase 1 run — 75 checks, 71 pass

---

## 1. Summary

| | Phase 1 | Phase 2 | Δ |
|---|---|---|---|
| Checks executed | 75 | 94 | +19 |
| Pass | 71 | **93** | +22 |
| Genuine failures | 3 | **0** | −3 |
| Non-defect (documented) | 1 | 1 | — |

**Zero regressions.** Every Phase 1 check that passed still passes. The three
genuine Phase 1 failures (D-01 family) now pass. The one remaining "FAIL" is
check 16.6, confirmed in Phase 1 as correct behaviour reported by a different
guard — retained deliberately so the assertion keeps documenting the ordering.

## 2. Fix verification

### D-01 — CV attached to an existing candidate now parses

| Check | Assertion | Result |
|---|---|---|
| D01.1 | `POST /:id/resume` still returns 201 (contract unchanged) | ✅ |
| D01.2 | Parsed fields now populated — phone, company, position, university | ✅ |
| D01.3 | `parseStatus`, `parseConfidence`, `parsedAt` written | ✅ |
| D01.4 | Phone extracted correctly | ✅ |
| **D01.5** | **A manually entered email is NOT overwritten by the parse** | ✅ |
| D01.6 | `resume_path` still persisted (no regression on the earlier fix) | ✅ |

D01.5 is the important one. The fixture CV contains `ahmed.hassan@example.com`
while the candidate was created with `fix.verify@example.com`. After the upload
the email is still `fix.verify@example.com` — the fill-empty-only rule holds and
a recruiter's manual entry survives a later CV upload.

### D-02 — Re-parse

| Check | Assertion | Result |
|---|---|---|
| D02.1 | `POST /:id/reparse` works against the stored file | ✅ |
| D02.2 | A second re-parse is idempotent — `filled == []` | ✅ |
| D02.3 | `?overwrite=true` re-fills fields | ✅ |
| D02.4 | Re-parse with no resume on file → 400 with a clear message | ✅ |
| D02.5 | Re-parse on a missing candidate → 404 | ✅ |

### D-04 — Permission matrix exposure

| Check | Assertion | Result |
|---|---|---|
| D04.1 | Non-admin no longer receives `permissions` in `GET /roles` | ✅ |
| **D04.2** | **Role names still returned — User Management dropdown unaffected** | ✅ |
| D04.3 | `GET /roles/permissions` → 403 for non-admins | ✅ |
| **D04.4** | **Admin still receives the full matrix** | ✅ |
| D04.5 | Admin still reads the permission catalogue | ✅ |

D04.2 and D04.4 are the anti-regression pair — they prove the fix removed the
exposure without breaking either UI consumer.

### D-05 — Roleless user

| Check | Assertion | Result |
|---|---|---|
| D05.1 | Create with no `roleCodes` → 400 | ✅ |
| D05.2 | Create with `roleCodes: []` → 400 | ✅ |
| 14.7 | Duplicate email still returns 409, **not** the role error | ✅ |

Check 14.7 catches an error-precedence bug I introduced and then corrected. The
role check was initially placed before duplicate-email detection, which masked
the more useful 409. It now runs after format and duplicate validation.

## 3. Full regression sweep — Phase 1 checks re-run

| Module | Checks | Pass | Regressions |
|---|---|---|---|
| Authentication | 9 | 9 | 0 |
| Forced rotation gate | 5 | 5 | 0 |
| Password policy | 8 | 8 | 0 |
| Unauthenticated access | 7 | 7 | 0 |
| User management | 9 | 9 | 0 |
| Permission enforcement | 5 | 5 | 0 |
| Last-admin protection | 3 | 2 | 0 *(16.6 documented)* |
| Talent Pool / pagination / sort | 17 | 17 | 0 |
| Resume upload / download | 7 | 7 | 0 |
| Resume parsing | 3 | 3 | **fixed** |
| Error handling | 4 | 4 | 0 |
| **Phase 2 fix verification** | **19** | **19** | — |

Specifically re-confirmed after the changes:

- forced rotation still blocks all four protected routes and lifts after change
- the `parse-cv` bulk import path is untouched and still works
- resume download still returns the file, and still 401s without a token
- 20 MB cap, `.exe` rejection and zero-byte handling all unchanged
- `?sort=DROP TABLE candidate` still returns a safe 200

## 4. Build integrity

| Gate | Method | Result |
|---|---|---|
| Backend syntax | `node --check` on every file under `backend/src` | ✅ 0 failures |
| Frontend compiles | `app.jsx` through the vendored `babel.min.js` | ✅ 378,524 chars |
| Cache token | bumped `20260727e` → **`20260727f`** | ✅ both assets |
| Schema idempotency | 3 consecutive `ensureSchema()` passes | ✅ |
| Server error log | scanned for errors / unhandled rejections during the run | ✅ clean |
| Live boot + seed | isolated temp DB | ✅ |

**No schema change in Phase 2.** No migration, no new column, no new index.

## 5. Changes made

```
backend/src/routes/candidates.js  +80 / -2    D-01, D-02
backend/src/routes/roles.js       +16 / -1    D-04
backend/src/routes/users.js        +5         D-05
frontend/public/app.jsx           +21         D-02 UI controls
frontend/public/index.html         +2 / -2    cache token
docs/uat/uat_api.py               +72         regression coverage
```

**The parser was not modified.** All parser modules under `backend/src/lib/cv/`
are byte-identical. The fixes call the existing pipeline from a route; the freeze
holds.

## 6. Regression risk assessment

| Fix | Risk | Reasoning |
|---|---|---|
| D-01 | **Medium** | Adds async work to a previously synchronous upload path. Mitigated: the parse is wrapped in try/catch, so a parser failure records `parseStatus: 'failed'` and the upload still succeeds — the file is stored before parsing begins. |
| D-02 | **Low** | New endpoint. Nothing existing calls it. |
| D-04 | **Medium** | Changes a response shape. Mitigated: both UI consumers verified; admins see no change; non-admins lose only a field they had no legitimate use for. |
| D-05 | **Low** | New validation on one route. Risk is an integration that created roleless users — none exists; the UI always sends `roleCodes`. |
| UI re-parse | **Medium** | `app.jsx` is compiled in-browser, so any syntax error blanks the SPA. Mitigated by compiling with the vendored Babel — passed. |

**Residual risk concentrates in what could not be tested:** the two new re-parse
buttons have never been rendered or clicked. They compile, but their behaviour on
screen is unverified.

## 7. Not covered

- **No browser testing.** Chrome extension still not connected.
- **Real PDF/DOCX.** The parse fixture is `.txt`; `pdf-parse` and `mammoth` remain
  unexercised end-to-end. D-01's fix is verified for the plumbing, not for
  real-world extraction accuracy.
- **Concurrency.** No test for two simultaneous uploads to the same candidate.
- **Large-file parse timing.** A 20 MB PDF now parses inside the upload request;
  response time under that load is unmeasured.
