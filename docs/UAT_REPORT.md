# UAT Report — Phase 1

**Build:** `main` @ `c5bdde5` (merged auth + parser)
**Executed:** 2026-07-27
**Environment:** local server, isolated database (`/tmp/uat/uat.db`), freshly seeded
**Method:** live HTTP against a running server + source inspection
**Checks executed:** 75 automated · **71 pass · 4 flagged**

---

## ⚠️ Scope limitation — read this first

**No browser testing was performed.** The Chrome extension is not connected to
this session (`list_connected_browsers` returns empty), so I could not drive a
real browser, take screenshots, read the console, or resize a viewport.

What that means for this report:

| Verified | Not verified |
|---|---|
| API response codes and payloads | UI rendering |
| Database persistence | Loading / success / error states as *displayed* |
| Permission enforcement (server-side) | Navigation and click behaviour |
| Error handling at the API boundary | Browser console errors |
| Password policy and rotation gate | Responsive layout and mobile |
| Upload limits, file-type rejection | Browser compatibility |
| Parser persistence behaviour | Screenshots |

Server-side verification is the stronger half of the two — a hidden button is
not a security control, and a green UI over a broken API is worthless. But it is
**not a substitute** for the browser pass. **This report cannot support a Go
decision on its own.** `BROWSER_VERIFICATION_CHECKLIST.md` still needs a human
executor, and this report tells that person where to look hardest.

---

## 1. Results by module

| Module | Checks | Pass | Fail | Verdict |
|---|---|---|---|---|
| Authentication | 9 | 9 | 0 | ✅ |
| Forced password rotation | 5 | 5 | 0 | ✅ |
| Password policy | 8 | 8 | 0 | ✅ |
| Unauthenticated access | 7 | 7 | 0 | ✅ |
| User management | 9 | 9 | 0 | ✅ |
| Permission enforcement | 5 | 5 | 0 | ✅ |
| Last-admin protection | 3 | 2 | 1 | ⚠️ see D-06 |
| Talent Pool / pagination / sort | 17 | 17 | 0 | ✅ |
| Resume upload / download | 7 | 7 | 0 | ✅ |
| **Resume parsing & persistence** | **3** | **0** | **3** | ❌ **see D-01** |
| Error handling | 4 | 4 | 0 | ✅ |
| Authorization sweep | 14 | — | — | ⚠️ see D-03/D-04 |

## 2. What passed, and why it matters

**The forced rotation gate works.** This was the highest-risk item in the merge —
new code, never exercised. Verified: a `must_change_password` user is blocked
with 403 on `/api/candidates`, `/api/users`, `/api/requests` and `/api/dashboard`,
while `/api/auth/me` stays reachable so the SPA can still render the rotation
screen. After a valid change the gate lifts, the new password works and the old
one is rejected.

**The launch-blocker fix holds.** `POST /api/users` returns `temporaryPassword`
exactly once, that password actually authenticates, the new user is flagged for
rotation, is blocked until they rotate, and works normally afterwards. The full
create → sign-in → rotate → use cycle completes.

**The password policy is real.** All five weak-password probes rejected: under 12
characters, missing character classes, and the deny-listed `Arabtec@12345`.

**No user enumeration.** A wrong password and an unknown email return byte-identical
responses.

**The Talent Pool rewrite is sound.** The new `{candidates, pagination}` shape is
correct, `totalPages` arithmetic checks out, `pageSize` is honoured, all ten sort
keys are accepted, an out-of-range page returns an empty list rather than an
error, and a no-match search returns 0 rows rather than a 500.

**The sort whitelist resists injection.** `?sort=DROP TABLE candidate` returns
200 with a safe fallback, not a 500 and not a executed statement.

**Upload guards work.** A 21 MB file is rejected at the 20 MB cap, a `.exe` is
rejected on extension, a zero-byte file does not produce a 500, and resume
download returns 401 without a token.

**`resume_path` persists.** The regression fixed during the parser phase is
confirmed fixed.

## 3. The significant finding

### Uploading a CV to an existing candidate does not parse it

Three of the four flagged checks share one root cause. There are two upload
paths, and only one of them parses:

| Endpoint | Parses? | Called from |
|---|---|---|
| `POST /api/candidates/parse-cv` | ✅ yes | bulk CV import; "Add Candidate" *quick-parse* flow (`app.jsx:4025`) |
| `POST /api/candidates/:id/resume` | ❌ **no** | Add/Edit Candidate form (`app.jsx:3985`), candidate profile attach (`3316`), card attach (`4057`) |

The `/:id/resume` handler does exactly three things — write `resume_path`,
`resume_name`, `updated_at` — then logs an activity row. The parser is never
invoked.

**Recruiter-visible consequence:** a recruiter who fills in the Add Candidate
form and attaches a CV gets the file stored and **nothing extracted**. No phone,
no company, no position, no university, no years of experience. `parse_status`,
`parse_confidence` and `parsed_at` all stay `NULL`, so the parse-quality badge
renders grey and sorting the Talent Pool by confidence silently excludes those
records.

That undercuts the headline value of the entire parser phase for the most
natural way a recruiter adds a candidate.

**Related:** there is **no re-parse endpoint and no re-parse UI control anywhere**.
Once a candidate exists, the parser can never be run against them again — so a
bad parse cannot be corrected, and this defect cannot be remediated for existing
records without a fix.

## 4. Authorization observations

An empirical sweep with a plain HR Manager token found two endpoints readable
that probably should not be:

| Endpoint | HR Manager | Exposure |
|---|---|---|
| `GET /api/audit` | **200** | full audit log — who did what, to which record, when |
| `GET /api/roles` | **200** | every role **with its complete permission list** |
| `GET /api/roles/permissions` | **200** | the full permission catalogue |

Static analysis puts this in context: **57 of 132 API routes carry no
`requirePermission` guard.**

| File | Routes | Unguarded |
|---|---|---|
| `thread.js` | 8 | **8** |
| `admin-ui.js` | 10 | **10** |
| `auth.js` | 6 | 6 *(expected — login/logout)* |
| `settings.js` | 14 | **6** |
| `interviews.js` | 8 | **4** |
| `requests.js` | 16 | **4** |
| `org.js` | 10 | **4** |
| `applications.js` | 8 | **3** |
| `notifications.js` | 3 | 3 *(likely self-scoped)* |
| `audit.js` | 2 | **2** |
| `roles.js` | 3 | **2** |
| `dashboard.js` | 1 | 1 *(probably fine)* |
| `assessments.js` | 5 | **1** |
| `candidates.js` | 18 | 1 |
| `offers.js` / `users.js` | 20 | **0** ✅ |

To be precise about severity: **unguarded ≠ unauthenticated.** Every one of these
still requires a valid session — verified, all six probed endpoints return 401
without a token. The issue is horizontal: *any* logged-in user reaches them
regardless of role. `offers.js` and `users.js` are fully guarded, which shows the
intended standard; the rest have drifted from it.

This needs per-route triage, not a blanket fix — some are legitimately open.

## 5. Two flagged items that are **not** defects

Recorded so they are not re-investigated later.

**16.6 — "deactivating the last admin returned 400, not 409."** The outcome is
correct; a different guard fired first. `POST /users/:id/deactivate` checks
"you cannot deactivate your own account" *before* the last-admin check. Since the
sole admin is usually the only person holding `user.manage`, the self-check
almost always fires first, making the last-admin branch on *deactivate* largely
unreachable. Harmless defence-in-depth. The **demote** guard is the one that
does real work, and it passed (409 `LAST_ADMIN_PROTECTED`).

**`PUT /users/:id {active:false}` returned 200.** Initially suspected as a bypass
of the last-admin guard. It is not: the field is unrecognised and ignored. Verified
by re-reading the user afterwards — `status` remained `active`.

## 6. Not tested

Beyond the browser gap:

- **Interviews, Offers, Notifications, Thread, Settings, Feature Flags, Email
  Configuration, Privacy, CV Inbox** — CRUD workflows not exercised. The sweep
  confirms the list endpoints respond, nothing more.
- **Real PDF and DOCX parsing.** The parse test used a `.txt` fixture. `pdf-parse`
  and `mammoth` are untested against real files. The Parser Validation Report
  (~30 real resumes) remains outstanding and is the only thing that will produce
  a real accuracy number.
- **Arabic and mixed-language CVs.** Section detection is unit-verified (26/26
  headings) but never exercised end-to-end through an upload.
- **Concurrency.** No double-submit, race or rapid-paging tests.
- **Production data shape.** Tested against a fresh seed, not against the
  restored dataset.
