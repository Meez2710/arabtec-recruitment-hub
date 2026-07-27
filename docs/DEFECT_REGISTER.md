# Defect Register — Phase 1 UAT

**Build:** `main` @ `c5bdde5` · **Opened:** 2026-07-27
**Source:** server-side UAT (75 automated checks) + source inspection
**Note:** no browser testing was possible; browser-only defect classes
(rendering, responsive, console, cross-browser) are **not represented here** and
will be added after the browser pass.

| ID | Module | Severity | Status |
|---|---|---|---|
| D-01 | Resume Parsing | **S2** | Open |
| D-02 | Resume Parsing | **S3** | Open |
| D-03 | Audit | **S3** | Open |
| D-04 | Roles | **S3** | Open |
| D-05 | User Management | **S4** | Open |
| D-06 | Security | **S4** | Open (informational) |
| D-07 | API Authorization | **S3** | Open (audit task) |

Pre-existing items already tracked in the Technical Debt Register (TD-01 error
boundary, TD-02 unguarded `api()` calls, TD-03 native `prompt()`) are **not**
duplicated here, but each is browser-visible and expected to generate defects
during §18 of the browser checklist.

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
