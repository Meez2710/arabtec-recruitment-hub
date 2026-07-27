# Browser Verification Checklist — Official UAT Document

**System:** Arabtec Recruitment Hub (ATS)
**Build under test:** `main` @ `2249fe3` (merge of auth + parser branches)
**Asset cache token:** `?v=20260727e`
**Generated:** 2026-07-27
**Status:** NOT YET EXECUTED

---

## How to use this document

This checklist validates the **merged** codebase, not any individual branch. It
is the gate between "code complete" and "approved for production push".

**Result codes**

| Code | Meaning |
|---|---|
| **P** | Pass — behaves exactly as the Expected Result describes |
| **F** | Fail — does not behave as described |
| **B** | Blocked — could not be tested (dependency missing) |
| **N/A** | Not applicable to this environment |

**Severity for any F**

| Level | Definition | Push decision |
|---|---|---|
| **S1** | Data loss, security hole, or app does not load | **Blocks push** |
| **S2** | Core recruiter workflow cannot be completed | **Blocks push** |
| **S3** | Workaround exists, workflow completes | Ship with a logged defect |
| **S4** | Cosmetic | Ship, backlog it |

### Before you start

1. **Hard-refresh.** `Cmd+Shift+R` / `Ctrl+F5`. The SPA is compiled in-browser
   by Babel; a cached `app.jsx` invalidates every result below.
2. **Open DevTools Console and leave it open.** A single JSX syntax error blanks
   the whole app; the console is the only place that says why.
3. **Confirm the cache token.** View source; both `styles.css` and `app.jsx`
   must read `?v=20260727e`. If they do not, you are testing a stale build —
   stop.
4. **Record the browser and OS** for each run in the sign-off table.
5. **Use a non-production database** for anything in §16 (Permissions) and §18
   (Error Handling), which involve deliberate breakage.

### Test accounts required

| Purpose | Needed |
|---|---|
| System admin | full permissions incl. `user.manage`, `role.manage` |
| HR Manager | normal recruiter permissions, no user management |
| Freshly created user | never logged in — `must_change_password` set |
| Second admin | required for §16.6 last-admin protection |

---

## 1. Authentication

Highest-risk module in this build. The forced-rotation gate is **new and has
never been seen in a browser**. It renders in front of the entire application,
so a defect here makes the app appear completely broken.

| # | Feature | Expected result | Result | Sev | Notes |
|---|---|---|---|---|---|
| 1.1 | Login page loads | Brand logo, email + password fields, no console errors | | | |
| 1.2 | Logo renders correctly | Approved asset, transparent background, not stretched, not a white box | | | |
| 1.3 | Valid credentials | Redirects to Dashboard; session persists on refresh | | | |
| 1.4 | Invalid password | Inline error, generic wording, no lockout of the form | | | |
| 1.5 | Unknown email | Same generic error as 1.4 (must not reveal whether the account exists) | | | |
| 1.6 | Empty submit | Client-side validation, no network request | | | |
| 1.7 | **Forced password change appears** | A newly created user logging in sees the rotation screen, not the Dashboard | | | |
| 1.8 | **Rotation screen blocks navigation** | Sidebar/topbar are unreachable; no ATS page can be opened until the password is changed | | | |
| 1.9 | Password rules are visible | The 12-char / four-class rules are displayed before the user types | | | |
| 1.10 | Weak password rejected | Rejects <12 chars; rejects a password missing any character class | | | |
| 1.11 | Password containing own name rejected | e.g. user "Doaa" cannot use `Doaa@123456!` | | | |
| 1.12 | Deny-listed password rejected | `Arabtec@12345` is refused | | | |
| 1.13 | Valid rotation succeeds | Password accepted, user lands on Dashboard, flag cleared | | | |
| 1.14 | Re-login after rotation | New password works; old password does not | | | |
| 1.15 | Rotation is not re-triggered | Logging in again goes straight to Dashboard | | | |
| 1.16 | Self-service password change | Existing user can change password from their own profile/settings | | | |
| 1.17 | Logout | Session ends; a back-button press cannot reach an authed page | | | |
| 1.18 | Expired/invalid session | A tampered or cleared token returns the user to Login, not a blank screen | | | |
| 1.19 | Direct deep entry while logged out | Reloading any state shows Login (no partial UI flash of authed content) | | | |

## 2. Dashboard

| # | Feature | Expected result | Result | Sev | Notes |
|---|---|---|---|---|---|
| 2.1 | Page loads | KPI row, panels render; no console errors | | | |
| 2.2 | KPI values are real | Numbers match the underlying records, not placeholders | | | |
| 2.3 | KPI zero state | With an empty dataset shows `0`, not blank or `NaN` | | | |
| 2.4 | Charts/visuals render | No overflow, no clipped labels | | | |
| 2.5 | Panel links navigate | Each shortcut opens the correct page | | | |
| 2.6 | Recent activity | Ordered newest-first, timestamps human-readable | | | |
| 2.7 | Loading state | A spinner or skeleton is shown while data loads — never a flash of "0" | | | |
| 2.8 | Slow network | Throttle to Slow 3G: page degrades gracefully, no duplicate requests | | | |

## 3. Recruitment Requests

| # | Feature | Expected result | Result | Sev | Notes |
|---|---|---|---|---|---|
| 3.1 | List loads | All requests visible with code, title, status | | | |
| 3.2 | Create request | Form validates required fields; new request appears in the list | | | |
| 3.3 | Short request code | Code is generated in the shortened format | | | |
| 3.4 | Search by request code | Short code matches | | | |
| 3.5 | Edit request | Changes persist after reload | | | |
| 3.6 | Status change | Transition is applied and reflected in the list | | | |
| 3.7 | Request health indicator | Colour/label matches the underlying state | | | |
| 3.8 | Empty state | Clear message plus a create action, not a bare empty table | | | |
| 3.9 | Required-field errors | Errors appear next to the field, not only as a banner | | | |

## 4. Request Detail / Candidate Board

| # | Feature | Expected result | Result | Sev | Notes |
|---|---|---|---|---|---|
| 4.1 | Detail page loads | Header card, stage columns, candidate cards render | | | |
| 4.2 | Ticket header card | Title, meta and eyebrow are legible; no text overlap | | | |
| 4.3 | Stage counts | Each column count equals the number of cards in it | | | |
| 4.4 | **Move candidate — every target** | **Test all six targets individually.** Each returns success. *(Regression watch: five of six previously returned 400 because the UI sent display keys the API does not accept.)* | | | |
| 4.5 | Move persists | Reload; candidate remains in the new stage | | | |
| 4.6 | Reject with reason | Reject reasons are selectable and stored | | | |
| 4.7 | Disqualify button styling | Renders as a danger button — red text on red-tinted background, never red-on-blue | | | |
| 4.8 | Link existing candidate | Modal opens, search works, link succeeds | | | |
| 4.9 | Board with 0 candidates | Columns render with empty states | | | |
| 4.10 | Board with 50+ candidates | Columns scroll; page does not freeze | | | |

## 5. Talent Pool (Candidate List)

**Most-changed screen in this build.** The `GET /api/candidates` response shape
changed from an array to `{ candidates, pagination }`. If the table is empty
while records exist, that is the cause.

| # | Feature | Expected result | Result | Sev | Notes |
|---|---|---|---|---|---|
| 5.1 | List loads | Candidates render — **not an empty table** | | | |
| 5.2 | Total count | The reported total matches the true record count | | | |
| 5.3 | **Sticky header** | Column headers remain visible while scrolling the table body | | | |
| 5.4 | Horizontal scroll | Wide table scrolls sideways inside the card; is not clipped | | | |
| 5.5 | Sort — Name | Ascending then descending; arrow indicator reflects direction | | | |
| 5.6 | Sort — Created | Newest/oldest ordering is correct | | | |
| 5.7 | Sort — Experience | Numeric ordering, not lexical (10 sorts after 9) | | | |
| 5.8 | Sort — Company / Position / University / Graduation / Location / Updated / Confidence | Each sorts correctly | | | |
| 5.9 | Sort is server-side | Sorting page 2 sorts the whole dataset, not just the visible page | | | |
| 5.10 | Sort survives paging | Changing page keeps the active sort | | | |
| 5.11 | Invalid sort key | A hand-edited/unknown sort key falls back to default, does not 500 | | | |
| 5.12 | Parse-quality badge | Green/amber/red/grey badge shown per candidate | | | |
| 5.13 | Badge matches data | Badge colour corresponds to the stored confidence value | | | |
| 5.14 | Badge for un-parsed record | Neutral/grey state, not an error | | | |

## 6. Search, Filtering, Pagination

| # | Feature | Expected result | Result | Sev | Notes |
|---|---|---|---|---|---|
| 6.1 | Search by name | Matching candidates only | | | |
| 6.2 | Search by email | Matches | | | |
| 6.3 | Partial search | Substring matching works | | | |
| 6.4 | Search with no results | Explicit "no results" state plus a way to clear | | | |
| 6.5 | Search + filter combined | Conditions apply together (AND), not separately | | | |
| 6.6 | Each of the 14 filters | Every filter narrows results correctly | | | |
| 6.7 | Filter chips appear | Active filters show as removable chips | | | |
| 6.8 | Remove one chip | Removes only that filter; others stay applied | | | |
| 6.9 | Clear all | Removes every filter and returns to the full list | | | |
| 6.10 | Filter resets to page 1 | Applying a filter does not leave the user stranded on an out-of-range page | | | |
| 6.11 | Pager — Next | Advances one page; content changes | | | |
| 6.12 | Pager — Previous | Goes back correctly | | | |
| 6.13 | Pager — first/last page | Disabled controls at boundaries, not an error | | | |
| 6.14 | Page size change | Re-queries and recalculates total pages | | | |
| 6.15 | Total pages arithmetic | `totalPages` matches `ceil(total / pageSize)` | | | |
| 6.16 | Single page of results | Pager hides or disables sensibly | | | |
| 6.17 | Zero results | Pager shows page 0/0 or hides — never "page 1 of 0" | | | |
| 6.18 | Rapid clicking Next | No duplicated rows, no race condition | | | |

## 7. Candidate Profile

| # | Feature | Expected result | Result | Sev | Notes |
|---|---|---|---|---|---|
| 7.1 | Profile opens | All stored fields display | | | |
| 7.2 | Empty fields | Show as "—" or "Not provided", never `null` or `undefined` | | | |
| 7.3 | Phone number | Displays correctly *(regression watch: previously mangled)* | | | |
| 7.4 | Email is a mailto link | Opens the mail client | | | |
| 7.5 | Edit candidate | Changes save and persist after reload | | | |
| 7.6 | Parse metadata shown | Parse status, confidence and parsed-at are visible | | | |
| 7.7 | Applications list | Every request this candidate is linked to is listed | | | |
| 7.8 | Long values | A very long name/company wraps or truncates; does not break layout | | | |

## 8. Resume Upload, Download & Parsing

| # | Feature | Expected result | Result | Sev | Notes |
|---|---|---|---|---|---|
| 8.1 | Upload PDF | Succeeds; filename displayed | | | |
| 8.2 | Upload DOCX | Succeeds | | | |
| 8.3 | Upload DOC | Succeeds or fails with a clear message | | | |
| 8.4 | Upload TXT | Succeeds | | | |
| 8.5 | Upload disallowed type (e.g. `.exe`, `.zip`) | Rejected with a readable message | | | |
| 8.6 | **File just under 20 MB** | Accepted | | | |
| 8.7 | **File just over 20 MB** | Rejected with a size message — **not a silent failure or a 500** | | | |
| 8.8 | Zero-byte file | Rejected gracefully | | | |
| 8.9 | Corrupt PDF | Parser returns empty/low confidence; no crash | | | |
| 8.10 | Password-protected PDF | Handled gracefully | | | |
| 8.11 | Scanned/image-only PDF | Low confidence, `review` or `uncertain` status; no crash | | | |
| 8.12 | **Download resume** | Downloads the original file with its original filename | | | |
| 8.13 | Download is authenticated | The URL cannot be fetched in a logged-out private window | | | |
| 8.14 | Download when no resume exists | Control is hidden or disabled — not a broken link | | | |
| 8.15 | Parse populates fields | Name/email/phone/company/position/university appear on the profile | | | |
| 8.16 | Low-confidence values not persisted | Values validated as `uncertain` or `rejected` are not written into candidate fields | | | |
| 8.17 | Parse status set | Status is one of `done` / `review` / `partial` / `failed` (as designed) | | | |
| 8.18 | Re-parse same file | Idempotent — no duplicate candidate, no field corruption | | | |
| 8.19 | Arabic-language CV | Section headings detected; no mojibake | | | |
| 8.20 | Mixed Arabic/English CV | Both handled | | | |
| 8.21 | Upload during parse | UI shows progress; the page is not frozen | | | |

## 9. Interviews

| # | Feature | Expected result | Result | Sev | Notes |
|---|---|---|---|---|---|
| 9.1 | Interviews page loads | List renders | | | |
| 9.2 | Schedule interview | Saved and visible on the candidate and the request | | | |
| 9.3 | Date/time display | Correct timezone, unambiguous format | | | |
| 9.4 | Reschedule | Updates persist | | | |
| 9.5 | Cancel | Status updates; record is not silently deleted | | | |
| 9.6 | Past vs upcoming | Correctly separated/labelled | | | |
| 9.7 | Interview feedback | Can be entered and read back | | | |
| 9.8 | Empty state | Clear message | | | |

## 10. Offers

| # | Feature | Expected result | Result | Sev | Notes |
|---|---|---|---|---|---|
| 10.1 | Offers page loads | List renders | | | |
| 10.2 | Create offer | Saved and linked to the candidate | | | |
| 10.3 | Salary/currency formatting | Formatted consistently; no floating-point artefacts | | | |
| 10.4 | Offer status transitions | Draft → sent → accepted/declined all work | | | |
| 10.5 | Offer appears on candidate | Visible from the candidate profile | | | |
| 10.6 | Empty state | Clear message | | | |

## 11. Reports

| # | Feature | Expected result | Result | Sev | Notes |
|---|---|---|---|---|---|
| 11.1 | Reports page loads | Report grid renders | | | |
| 11.2 | Figures are accurate | Cross-check at least two totals against the raw data | | | |
| 11.3 | Date range filter | Changes the reported figures correctly | | | |
| 11.4 | Export (if present) | Produces a valid file | | | |
| 11.5 | Empty dataset | Shows zeros/empty state, not an error | | | |

## 12. Notifications

| # | Feature | Expected result | Result | Sev | Notes |
|---|---|---|---|---|---|
| 12.1 | Notification indicator | Badge count matches unread items | | | |
| 12.2 | Open notifications | List renders, newest first | | | |
| 12.3 | Mark as read | Count decrements and persists after reload | | | |
| 12.4 | Notification link | Navigates to the referenced record | | | |
| 12.5 | Empty state | Clear message | | | |

## 13. Settings / Control Center

| # | Feature | Expected result | Result | Sev | Notes |
|---|---|---|---|---|---|
| 13.1 | Settings loads | All sections render | | | |
| 13.2 | Branding — upload logo | Logo updates across the app | | | |
| 13.3 | **Branding — remove logo** | Reverts to the default asset *(this is the fix for the white-box logo in production)* | | | |
| 13.4 | System settings save | Values persist after reload | | | |
| 13.5 | `password_min_length` | Can be raised; **cannot lower the 12-char floor** | | | |
| 13.6 | Reject reasons list | Loads and is editable | | | |
| 13.7 | Workflow settings | Save and take effect | | | |
| 13.8 | Button configs | Save and take effect | | | |

## 14. User Management

| # | Feature | Expected result | Result | Sev | Notes |
|---|---|---|---|---|---|
| 14.1 | User list loads | All users with role and status | | | |
| 14.2 | **Create user** | Succeeds and the temporary password is **displayed once and is copyable** *(this was the launch-blocker defect)* | | | |
| 14.3 | New user can sign in | The displayed temporary password actually works | | | |
| 14.4 | New user is forced to rotate | Lands on the rotation screen (cross-check §1.7) | | | |
| 14.5 | Reset password | Produces a new temporary password, shown once | | | |
| 14.6 | Weak password on create | Rejected with the specific rule that failed | | | |
| 14.7 | Duplicate email | Rejected with a clear message | | | |
| 14.8 | Edit user role | Saves; permissions change on the user's next request | | | |
| 14.9 | Deactivate user | User can no longer log in | | | |
| 14.10 | Reactivate user | Login works again | | | |

## 15. Roles & Permissions (Configuration)

| # | Feature | Expected result | Result | Sev | Notes |
|---|---|---|---|---|---|
| 15.1 | Roles list loads | All 9 roles | | | |
| 15.2 | Permission matrix | All 50 permissions render, current grants checked | | | |
| 15.3 | Grant a permission | Saves; takes effect for users in that role | | | |
| 15.4 | Revoke a permission | Saves; the UI control disappears for affected users | | | |
| 15.5 | Matrix on a narrow screen | Scrolls; is not clipped | | | |

## 16. Permission Enforcement (Security)

Run these as a **non-admin** user. Server-side enforcement is what matters —
a hidden button is not a control.

| # | Feature | Expected result | Result | Sev | Notes |
|---|---|---|---|---|---|
| 16.1 | Restricted nav hidden | HR Manager does not see User Management / Roles | | | |
| 16.2 | Restricted action hidden | Buttons the role cannot use are absent, not merely disabled | | | |
| 16.3 | **Forbidden state renders** | Reaching a page without permission shows the Forbidden component, not a blank screen or a crash | | | |
| 16.4 | **Server rejects a forged request** | `POST /api/users` as HR Manager returns **403** even though the UI hides it | | | |
| 16.5 | **Role-escalation guard** | A non-admin cannot grant `user.manage` or `role.manage` to any role — **403** | | | |
| 16.6 | **Last-admin protection — deactivate** | Deactivating the only remaining admin is refused with a clear message | | | |
| 16.7 | **Last-admin protection — demote** | Demoting the only remaining admin is refused | | | |
| 16.8 | Two admins present | With a second admin, deactivating the first **is** allowed | | | |
| 16.9 | Rotation gate does not lock out | A user mid-rotation can still reach logout and their own password change | | | |
| 16.10 | Resume download authorization | A user without candidate access cannot download a resume by URL | | | |

## 17. Responsive & Mobile

Test at each width. The responsive CSS in this build has **never been seen in a
browser**.

| # | Viewport | Expected result | Result | Sev | Notes |
|---|---|---|---|---|---|
| 17.1 | 1920 wide | Full sidebar; content not stretched to unreadable line lengths | | | |
| 17.2 | 1440 | Normal layout | | | |
| 17.3 | **1180 (breakpoint)** | Sidebar collapses to the rail automatically | | | |
| 17.4 | 1024 (iPad landscape) | Usable; no horizontal page scroll | | | |
| 17.5 | 768 (iPad portrait) | Usable; tables scroll inside their card | | | |
| 17.6 | **700 (breakpoint)** | Pager stacks vertically | | | |
| 17.7 | 414 (phone) | No content clipped or unreachable | | | |
| 17.8 | 375 (small phone) | Login and Dashboard both usable | | | |
| 17.9 | Sidebar toggle | Manual collapse/expand works at every width | | | |
| 17.10 | Topbar search on mobile | Reachable and usable | | | |
| 17.11 | Modals on mobile | Fit the viewport; close control reachable | | | |
| 17.12 | Forced-password screen on mobile | Card fits; the submit button is reachable | | | |
| 17.13 | Landscape phone | No layout break | | | |
| 17.14 | Browser zoom 150% | Layout holds | | | |

## 18. Error Handling & Resilience

| # | Scenario | Expected result | Result | Sev | Notes |
|---|---|---|---|---|---|
| 18.1 | Backend stopped mid-session | A readable error appears — **not a blank white screen** | | | |
| 18.2 | Backend returns 500 | Error surfaced to the user with a retry path | | | |
| 18.3 | Network offline | Handled; the UI does not hang forever | | | |
| 18.4 | Session expires while working | Redirect to Login with an explanatory message; work in progress is not silently lost | | | |
| 18.5 | 403 on a page load | Forbidden state, not a crash | | | |
| 18.6 | 404 on a record | "Not found" state, not a crash | | | |
| 18.7 | Slow response | Loading indicator persists; no duplicate submission | | | |
| 18.8 | Double-submit a form | Only one record created | | | |
| 18.9 | **Native `prompt()` dialogs** | Note every place a raw browser prompt appears — these are scheduled for replacement | | | |
| 18.10 | **Unhandled render error** | Record whether a React error boundary catches it, or the app blanks *(no boundary exists yet — expected failure)* | | | |
| 18.11 | Console errors | Record **every** console error/warning encountered during the whole run | | | |

## 19. Cross-Browser

| # | Browser | Scope | Result | Sev | Notes |
|---|---|---|---|---|---|
| 19.1 | Chrome (latest) | Full checklist | | | |
| 19.2 | Safari (latest) | §1, §5, §8, §17 | | | |
| 19.3 | Edge (latest) | §1, §5, §8 | | | |
| 19.4 | Firefox (latest) | §1, §5, §8 | | | |
| 19.5 | Mobile Safari (iOS) | §1, §5, §17 | | | |
| 19.6 | Chrome Android | §1, §5, §17 | | | |

## 20. Build Integrity & Regression Watch

| # | Check | Expected result | Result | Sev | Notes |
|---|---|---|---|---|---|
| 20.1 | Cache token | Source shows `?v=20260727e` on both assets | | | |
| 20.2 | No stale assets | Network tab shows no 304 on `app.jsx` after a hard refresh | | | |
| 20.3 | Babel compiles | Zero "Uncaught SyntaxError" in the console | | | |
| 20.4 | Vendor assets load | `react`, `react-dom`, `babel` all 200 | | | |
| 20.5 | Font fallback | With fonts.googleapis.com blocked, text still renders in the fallback stack | | | |
| 20.6 | Merge artefact scan | No `<<<<<<<` or `>>>>>>>` visible anywhere in the UI | | | |
| 20.7 | Logo background | Transparent, correct on both light and dark surfaces | | | |
| 20.8 | Design token consistency | No stray colours outside the approved token set | | | |

---

## Sign-off

| Field | Value |
|---|---|
| Tester name | |
| Date executed | |
| Browser / version | |
| OS | |
| Environment (local / staging / production) | |
| Database (fresh seed / restored data) | |
| Build commit | `2249fe3` |
| Cache token observed | |

### Result summary

| | Count |
|---|---|
| Total checks | **~230** |
| Pass | |
| Fail | |
| Blocked | |
| N/A | |

### Defects found

| # | Section | Description | Severity | Ticket |
|---|---|---|---|---|
| | | | | |

### Verdict

- [ ] **Approved for push to `origin/main` and deploy** — zero S1, zero S2
- [ ] **Approved with conditions** — S3/S4 defects logged and accepted
- [ ] **Rejected** — S1 or S2 present; fix and re-run affected sections

**Approver:** ______________________  **Date:** ____________

---

## Priority order if time is short

Run these first — they cover everything new or previously broken in this build:

1. **§1.7–1.15** forced password rotation (new, unseen, blocks the whole app)
2. **§5.1–5.2** Talent Pool loads (breaking API shape change)
3. **§14.2–14.4** create user + temporary password (the launch-blocker fix)
4. **§8.12–8.14** resume download (new)
5. **§4.4** move candidate to all six targets (known prior defect)
6. **§16.4–16.8** server-side permission enforcement
7. **§17.3, §17.6** the two new responsive breakpoints
8. **§20.1–20.3** build integrity
