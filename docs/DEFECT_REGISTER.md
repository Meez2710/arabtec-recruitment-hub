# Defect Register — Phase 1 UAT / Phase 2 Resolution

**Opened:** 2026-07-27 (Phase 1) · **Updated:** 2026-07-27 (Phase 2)
**Build:** `main` + Phase 2 fixes
**Note:** no browser testing was possible in either phase; browser-only defect
classes (rendering, responsive, console, cross-browser) are **not represented
here** and will be added after the browser pass.

| ID | Module | Severity | Status | Resolution |
|---|---|---|---|---|
| D-01 | Resume Parsing | **S2** | ✅ **Resolved** | parse pipeline invoked from `/:id/resume` |
| D-02 | Resume Parsing | **S3** | ✅ **Resolved** | `POST /:id/reparse` + UI controls |
| D-03 | Audit | ~~S3~~ | ⛔ **Retracted** | **false positive — not a defect** |
| D-04 | Roles | **S3** | ✅ **Resolved** | matrix gated on `role.manage`/`user.manage` |
| D-05 | User Management | **S4** | ✅ **Resolved** | at least one role now required |
| D-06 | Security | **S4** | 📋 **Closed — no action** | correct behaviour, informational only |
| D-07 | API Authorization | **S3** | 🔻 **Downgraded, deferred** | count was overstated; needs its own audit |
| **D-08** | Resume Upload | **S3** | 🔴 **Open** | 20 MB cap applied to request, not file |
| **D-09** | **Resume Parsing (PDF)** | **S2** | 🔴 **OPEN — BLOCKS RELEASE** | `@napi-rs/canvas` native binding missing; failure silently swallowed |

**Phase 2: resolved 4, retracted 1, closed 1, deferred 1.**
**Phase E: 2 NEW defects found by measurement — D-09 (S2) blocks release.**

Pre-existing items tracked in the Technical Debt Register (TD-01 error boundary,
TD-02 unguarded `api()` calls, TD-03 native `prompt()`) are **not** duplicated
here. Each remains open and is browser-visible.

---

## Correction notice — D-03 was wrong

Phase 1 reported that any authenticated user could read the audit log. **That was
a false positive caused by my own analysis method.**

My static scan counted `requirePermission` only on individual `router.get(...)`
lines. It did not look for **router-level** middleware. `audit.js:6` reads:

```js
router.use(requireAuth, requirePermission('audit.view'));
```

The route is guarded. The HR Manager received 200 because `hr_manager`
**legitimately holds `audit.view`** in the permission seed — along with
`hr_director`, `recruitment_manager` and `viewer`. Reading the audit log is an
intended capability for that role.

**No fix was applied.** Changing this would have removed a working feature.

The same flaw inflated D-07. Corrected figures are in that entry.

---

---

## D-01 — Uploading a CV to an existing candidate does not parse it

**Module:** Resume Upload / Resume Parsing · **Severity: S2 — Major Workflow Blocker**

**Steps to reproduce**

1. Log in as an admin.
2. Talent Pool → Add Candidate.
3. Fill in name and email, attach a CV file, save.
4. Open the newly created candidate.

**Expected result**
Parsed fields populated (phone, current company, current position, university,
years of experience); parse status and confidence set; parse-quality badge shows
a real colour.

**Actual result**
The file is stored and downloadable, but every parsed field is `NULL`.
`parse_status`, `parse_confidence` and `parsed_at` are all `NULL`. The badge
renders grey.

Machine-verified response after upload:

```json
{ "email": "uat.resume@example.com", "phone": null, "currentCompany": null,
  "currentPosition": null, "university": null, "yearsExperience": null,
  "parseStatus": null, "parseConfidence": null, "parsedAt": null }
```

The same fixture parsed through `/api/candidates/parse-cv` extracts these fields
correctly, so the parser itself is working.

**Root cause**
Two upload endpoints exist and only one parses.

- `POST /api/candidates/parse-cv` (`candidates.js:216`) runs the full pipeline
  and persists the result.
- `POST /api/candidates/:id/resume` (`candidates.js:553`) writes only
  `resume_path`, `resume_name`, `updated_at`, then logs an activity row. The
  parser is never called.

Three UI call sites use the non-parsing endpoint — `app.jsx:3985` (Add/Edit
Candidate form), `3316` (profile attach), `4057` (card attach) — including the
most common way a recruiter adds a candidate.

**Recommended fix**
Invoke the existing parse pipeline from the `/:id/resume` handler, reusing
`parseEntitiesFromFile` → `toCandidatePayload` → `toParseMetadata` exactly as
`parse-cv` does. Fill only fields that are currently empty so manual edits are
never overwritten, and always write parse metadata.

This is a **route-level change**. It calls the parser but does not modify it, so
it respects the parser freeze.

**Screenshot reference:** n/a — no browser available.

---

## D-02 — No way to re-parse an existing candidate

**Module:** Resume Parsing · **Severity: S3 — Functional Issue**

**Steps to reproduce**
Open any candidate whose CV parsed poorly. Look for a re-parse or re-scan action.

**Expected result**
An action that re-runs the parser against the stored resume.

**Actual result**
No such control exists in the UI and no such endpoint exists in the API. The only
parsing entry point requires uploading a *new* file through the CV import flow,
which creates a new candidate rather than updating the existing one.

**Root cause**
`POST /:id/reparse` was never built; parsing is coupled to candidate creation.

**Recommended fix**
Add `POST /api/candidates/:id/reparse` (permission `candidate.edit`) that re-reads
the stored resume file and re-runs the pipeline, and expose it from the candidate
profile. The stored file is already the designated source of truth, so no schema
change is needed.

Fixing D-01 without D-02 leaves every candidate created before the fix
permanently unparsed.

---

## D-03 — Audit log readable by any authenticated user

**Module:** Audit / Security · **Severity: S3 — Functional Issue**

**Steps to reproduce**
Authenticate as an HR Manager (no admin permissions) and
`GET /api/audit`.

**Expected result** 403.
**Actual result** **200** with the full audit log.

**Root cause**
`audit.js:18` — `router.get('/', (req, res) => {…})`. No `requirePermission`.
Both routes in the file are unguarded.

**Recommended fix**
Add `requirePermission('audit.view')` (or the nearest existing permission) to
both routes. Confirm which of the 50 permissions is intended before wiring.

---

## D-04 — Full permission matrix readable by any authenticated user

**Module:** Roles / Security · **Severity: S3 — Functional Issue**

**Steps to reproduce**
As an HR Manager: `GET /api/roles` and `GET /api/roles/permissions`.

**Expected result** 403, or a reduced payload without the permission lists.
**Actual result** **200**, including `permissions: Roles.permissionsForRole(r.id)`
for every role — a complete map of the authorization model.

**Root cause**
`roles.js:10` and `roles.js:19` have no guard. Only
`PUT /:id/permissions` is guarded (with `role.manage`).

**Recommended fix**
Decide the intent first. If the UI needs role *names* to populate dropdowns, keep
the endpoint open but strip the `permissions` array unless the caller holds
`role.manage`. Otherwise guard both routes outright.

Mitigating: the role-escalation guard verified as working (16.5b), so reading the
matrix does not enable modifying it.

---

## D-05 — A user can be created with no roles

**Module:** User Management · **Severity: S4 — Functional / UX**

**Steps to reproduce**
`POST /api/users` with `fullName` and `email` but no `roleCodes`.

**Expected result**
Either rejected with a validation error, or the user is clearly marked as having
no access.

**Actual result**
201 Created. The user can log in and rotate their password successfully, then
receives 403 on every single page. From their point of view the application is
broken.

**Root cause**
`users.js:84` — `applyAssignments()` is called with whatever `roleCodes` arrives,
including `undefined`. No minimum-role validation.

*Discovered incidentally: my first UAT harness sent `role:` instead of
`roleCodes:`, the field was silently ignored, and a roleless user was created —
which is exactly how an admin would hit this.*

**Recommended fix**
Reject the create with 400 when `roleCodes` is empty or absent, or default to a
minimal read-only role. Mirror the same rule on update.

---

## D-06 — Last-admin guard on deactivate is largely unreachable

**Module:** Security · **Severity: S4 — Informational**

**Steps to reproduce**
As the sole system admin, `POST /api/users/:id/deactivate` against your own id.

**Expected result** 409 `LAST_ADMIN_PROTECTED`.
**Actual result** 400 `"You cannot deactivate your own account."`

**Assessment: not a security defect.** The action is refused; a different guard
fires first. Logged because the code reads as protection that is rarely exercised.

**Root cause**
The self-deactivation check precedes `isLastActiveAdmin()` in the handler. Since
the sole admin is typically the only holder of `user.manage`, they are the only
person who could trigger the last-admin branch — and the self-check catches them
first. The branch is reachable only when a non-admin role has been granted
`user.manage`.

**Recommended fix**
None required. Optionally reorder so the more informative
`LAST_ADMIN_PROTECTED` message is returned. The **demote** guard is the one
carrying real weight and it passed.

---

## D-07 — 57 of 132 API routes have no permission guard

**Module:** API Authorization · **Severity: S3 — needs triage, not a blanket fix**

**Evidence**

| File | Routes | Unguarded |
|---|---|---|
| `admin-ui.js` | 10 | 10 |
| `thread.js` | 8 | 8 |
| `auth.js` | 6 | 6 *(expected)* |
| `settings.js` | 14 | 6 |
| `interviews.js` | 8 | 4 |
| `requests.js` | 16 | 4 |
| `org.js` | 10 | 4 |
| `applications.js` | 8 | 3 |
| `notifications.js` | 3 | 3 *(likely self-scoped)* |
| `audit.js` | 2 | 2 → **D-03** |
| `roles.js` | 3 | 2 → **D-04** |
| `assessments.js` | 5 | 1 |
| `candidates.js` | 18 | 1 |
| `dashboard.js` | 1 | 1 |
| `offers.js`, `users.js` | 20 | **0** ✅ |

**Important qualifier**
Unguarded does **not** mean unauthenticated. All six endpoints probed without a
token returned 401. The exposure is horizontal — any logged-in user, regardless
of role.

`offers.js` and `users.js` are fully guarded, establishing the intended standard.

**Recommended fix**
A route-by-route authorization audit producing a table of
route → intended permission → guard present. Fix in priority order:
`thread.js` and `settings.js` first (they mutate state), then `interviews.js`,
`requests.js`, `org.js`, `applications.js`. Explicitly document the routes that
are meant to be open.

Scope this as its own task with an impact assessment — it touches the
authorization model and a wrong guard locks legitimate users out.


---

# Phase 2 Resolutions

## D-01 — RESOLVED

**Root cause**
Parsing existed only in `POST /api/candidates/parse-cv`. The second upload
endpoint, `POST /api/candidates/:id/resume` (`candidates.js:553`), wrote
`resume_path`, `resume_name` and `updated_at` and stopped. Three UI call sites
used it, including the main Add/Edit Candidate form.

**Files modified**
- `backend/src/routes/candidates.js` — added `parseAndFill()`; made the
  `/:id/resume` handler `async` and wired it in; imported `FIELD_MAP`.

**Design decision — fill empty fields only.** The helper writes a column only
when it is currently `NULL` or blank. A recruiter's manual correction must
survive a later CV upload. Parse metadata is always refreshed so the quality
badge reflects the newest file.

**Failure containment.** The parse runs inside `try/catch` *after* the file is
stored. A parser exception records `parseStatus: 'failed'` and the upload still
returns 201 — a bad CV can never cost the user their file.

**Regression risk: Medium** — converts a synchronous handler to asynchronous.

**Verification:** D01.1–D01.6 all pass, including D01.5 which proves a
manually-entered email survives a CV containing a different one.

---

## D-02 — RESOLVED

**Root cause**
No re-parse endpoint or UI control existed. Parsing was coupled to candidate
creation, so a bad parse could never be corrected.

**Files modified**
- `backend/src/routes/candidates.js` — new `POST /:id/reparse`
  (`requirePermission('candidate.edit')`), reads the stored file, supports
  `?overwrite=true`.
- `frontend/public/app.jsx` — "Re-parse" button added to both résumé panels
  (candidate drawer and résumé card), shown only with `candidate.edit`.
- `frontend/public/index.html` — cache token → `20260727f`.

Default behaviour fills empty fields only; `?overwrite=true` replaces existing
values for deliberate correction. No schema change — the stored file was already
the designated source of truth.

**Regression risk: Low** on the API (nothing else calls it); **Medium** on the
UI, since `app.jsx` compiles in-browser.

**Verification:** D02.1–D02.5 pass, including idempotency and both error paths.
The buttons compile but have **not been clicked in a browser.**

---

## D-03 — RETRACTED (not a defect)

See the correction notice above. No code changed.

---

## D-04 — RESOLVED

**Root cause**
`roles.js:10` and `:19` had no guard, so `GET /api/roles` returned
`permissions: Roles.permissionsForRole(r.id)` for every role — a complete map of
the authorization model — to any authenticated user.

**Files modified**
- `backend/src/routes/roles.js` — added `canSeeMatrix(req)`
  (`role.manage || user.manage`). `GET /` omits the `permissions` array for
  everyone else; `GET /permissions` returns 403.

**Why not a blanket 403 on `GET /roles`:** the User Management page needs role
*names* for its dropdown. Guarding the whole route would have broken it. Only
the sensitive field is withheld.

**Regression risk: Medium** — response shape changes. Both consumers were traced
in `app.jsx` (lines 1244 and 1507) before the change.

**Verification:** D04.1–D04.5. D04.2 and D04.4 specifically prove no regression
for either consumer.

---

## D-05 — RESOLVED

**Root cause**
`POST /api/users` passed `roleCodes` to `applyAssignments()` without validation.
An omitted or empty array produced a user who could log in, rotate their
password, and then receive 403 on every page.

**Files modified**
- `backend/src/routes/users.js` — reject with 400 when `roleCodes` is absent or
  empty.

**Placement matters.** The check was first placed before duplicate-email
detection, which masked the more useful 409. Caught by regression check 14.7 and
moved to run after format and duplicate validation.

**Regression risk: Low.** The UI always sends `roleCodes`; no integration
creates users.

**Verification:** D05.1, D05.2 pass; 14.7 confirms 409 still wins for duplicates.

---

## D-06 — CLOSED, no action

Confirmed correct behaviour: the self-deactivation check fires before the
last-admin check, so the action is refused either way — just with a different
message. The **demote** guard carries the real protection and passes (409
`LAST_ADMIN_PROTECTED`).

Regression check 16.6 is deliberately retained in a failing state so the
assertion keeps documenting the ordering. It is **not** an open defect.

---

## D-07 — DOWNGRADED and DEFERRED

**Correction.** Phase 1 reported 57 of 132 routes unguarded. That count was
produced by the same flawed scan that caused D-03: it ignored router-level
middleware. Corrected figures:

| File | Routes | Genuinely unguarded |
|---|---|---|
| `admin-ui.js` | 10 | 10 *(includes the public logo endpoint)* |
| `thread.js` | 8 | 8 |
| `auth.js` | 6 | 6 *(login/logout — correct)* |
| `settings.js` | 14 | 6 |
| `interviews.js` | 8 | 4 |
| `requests.js` | 16 | 4 |
| `org.js` | 10 | 4 |
| `applications.js` | 8 | 3 |
| `notifications.js` | 3 | 3 *(self-scoped — likely correct)* |
| `roles.js` | 3 | **0 after the D-04 fix** |
| `assessments.js` | 5 | 1 |
| `candidates.js` | 19 | 1 |
| `audit.js` | 2 | **0 — router-level guard** |
| `dashboard.js` | 1 | **0 — router-level guard** |
| `offers.js`, `users.js` | 20 | 0 |

Roughly **50**, of which ~15 are correctly open. All still require
authentication — verified, six probes returned 401 without a token. The exposure
is horizontal, not public.

**Deferred deliberately.** Guessing the intended permission for ~35 routes and
applying guards in bulk is how you lock legitimate users out of a production
system. This needs a route-by-route table of
*route → intended permission → guard present*, reviewed before implementation.

**Recommendation:** schedule as its own Phase 1 task with an impact assessment,
starting with `thread.js` and `settings.js` (both mutate state).
