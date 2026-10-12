# Org chart integration and the company org database upload — plan

Status: **plan for owner review. Nothing in this document is implemented yet.**
Date: 12 Oct 2026. Builds on `docs/org-chart/ORG_CHART_V2_PLAN.md` (merged in PR #47).

---

## 0. The answer on one page

1. **Production runs code that is not on GitHub.** The live Hub at
   `10.20.0.9:4001` serves asset version `v=20261004j`. Five of its six
   stylesheets and its `index.html` match no commit on any of the 39 branches.
   The closest commits are from 27–30 Sep. Production has work that GitHub
   never received, including the interactive interview assessment form,
   *Assessment Settings* and the 4 Oct "row rules". `main` has work production
   lacks, including the WhatsApp interview messages and Org chart v2. "Match
   the on-prem UI exactly" therefore starts with getting the server's code into
   git (§4). Until then any deploy from `main` rolls those screens back. That is
   the same failure as 20 Sep.
2. **The launch feature is an Employee Register fed by an upload.** The Hub
   has no employee table today. HR uploads the company org database (Excel or
   CSV, one row per employee with a *reports-to* column). The Hub validates it,
   shows exactly what will change, and applies it on confirmation. The charts
   are then **drawn from the register**, so a person who moves, joins or leaves
   in the register moves, joins or leaves on every chart at once. No one redraws
   anything (§6).
3. **People changes are live; structure changes go to the HR Director.** This
   follows the earlier decision. A new hire in an existing box, a transfer
   between existing boxes, or a leaver shows on the charts as soon as the upload
   is confirmed. A new box, a removed box or a changed reporting line becomes a
   draft for HR Director approval (§6.5).
4. **Of production's 23 other sections, 10 should connect to the org chart,
   2 only as light suggestions (Interviews, Talent Pool), and 11 need nothing
   beyond flags, permissions or settings.** The join step, which is not a nav
   section, is the twelfth strong link. The matrix is in §7. The strongest links, in order:
   - **Hiring Requests**: a vacant position on a chart becomes a request, with
     the reporting line and designation filled in.
   - **Join and onboarding**: joining a candidate fills the seat on the chart
     and adds them to the register.
   - **Projects / Sites / Departments**: the manager fields are checked against
     the chart.
   - **Users**: the employee number links the user, and project/site scope is
     *suggested* from the person's position.
   - **Dashboard / Reports**: planned vs actual headcount, and vacancies with no
     request.
   - **Workflow / Notifications**: "the line manager" becomes a resolvable
     approver.
5. **Skills, in the order to use them:**
   - ats-launch-readiness, because the containment gate is already red;
   - ats-pattern-consistency-audit, for UI parity;
   - ats-hr-domain-patterns;
   - ats-security-review, since a bulk upload of personal data is a new upload
     path;
   - ats-vendor-risk, if an Excel parser is added;
   - ats-heuristic-ux-audit, for the import preview;
   - ats-prd-and-improvement-plan, for this document's shape.

   No new outside skill is needed (§3).

---

## 1. Problem, users, constraints, success

**Problem.** Today the org charts are Visio files kept by hand. They drift from
the HR Master Sheet. They are not connected to hiring, so an open position on a
chart and an open request in the Hub are unrelated facts. For launch, HR wants
to load the company's real org data once and keep it current. Every place in the
Hub that depends on "who reports to whom, and which seats are empty" should then
read the same source.

**Users.**
- **Manpower planning and org chart owner (Eman's role).** Uploads and
  maintains the register and the structure.
- **HR Director.** Approves structural changes.
- **Recruiters (two serve the company).** Need vacancies and reporting lines
  without retyping them.
- **Hiring managers and project managers.** Read their own project's chart and
  vacancies.
- **System Admin.** Runs the deploy and owns the server.

**Constraints.**
- On-prem: one Node 22/Express host, plain HTTP on :4001, a PostgreSQL
  database, and no build step for the screens beyond the server's own JSX
  compile.
- Arabic names occur in the data.
- Employee data is personal data. Real names never enter git, tests, seeds or
  fixtures.
- Launch-readiness rule: *no seed, reset, demo or import script in a deploy.*
  The upload must therefore be a user action in the UI, audited. It must never
  be a script run at deploy time.

**Success, measured in the Hub's own data.**
- 100% of active employees in the uploaded file are in the register. Every
  rejected row has a stated reason.
- Each project chart's headcount equals the register's headcount for that
  project. A nightly check reports any mismatch.
- Every open requisition seat links to a chart position, and every vacant
  approved position either has a request or appears on the "vacancies without a
  request" list.
- Time from confirming an upload to the charts showing it is under 5 seconds for
  the people viewing them.
- Zero deploys from a commit that does not contain production (containment
  gate).

---

## 2. Goals and non-goals

**Goals**
1. Production's UI and `main` become one line of history, and Org chart v2
   ships inside it with no visual drift (§4, §5).
2. HR can upload the company org database:
   - Excel `.xlsx` or CSV, preview, confirm;
   - re-upload any time;
   - the Hub reconciles by employee number.
3. Charts are generated from and stay in sync with the register. Hand layout in
   the editor survives later uploads.
4. Each Hub section that holds org information reads it from one place, as set
   out in §7.
5. Every write is audited, permissioned and reversible: a previous upload can be
   rolled back.

**Non-goals (for this launch)**
- Payroll, contracts, salaries, leave and attendance. The register holds who
  and where, not pay.
- Automatic permission grants from the chart. Scope is *suggested*; an admin
  grants it.
- Two-way sync back to the HR Master Sheet or any HRIS. The Hub is the register
  (decision of 1 Oct); the sheet is the first source.
- Automatic hiring actions. A vacancy never opens a request by itself; a person
  clicks *Open request*. The rule is that the system prepares and people decide.
- A live connector to SharePoint or Entra. It is listed as a later option in
  §6.7, not built now.
- Changes to `frontend-v2/` or the TypeScript rebuild.

---

## 3. Skills to use, and when

| Order | Skill | Why first / what it decides |
|---|---|---|
| 1 | `ats-launch-readiness` | Gate 1 (containment) is **red today**: production is not an ancestor of `main`. Gate 6 bans import scripts in a deploy, which forces the UI-only upload design. Run it before *any* deploy in this plan. |
| 2 | `ats-pattern-consistency-audit` | "Exactly matched UI" means reusing production's head row, filter row, table, modal, notice and badge patterns. Run it on the recovered production code. The v2 page's toolbar, side panel, import preview and register table must each map to an existing surface. |
| 3 | `ats-hr-domain-patterns` | Requests take a level from the 459-designation catalogue plus a reporting line, which is what the chart supplies. Rule: the system prepares, people decide. This sets which links are *suggestions* and which are automatic. |
| 4 | `ats-security-review` | New upload path, bulk personal data, a new permission (`employee.import`), and CSV formula injection on export. Review the route before merge. |
| 5 | `ats-vendor-risk` | Only if an `.xlsx` parser is added (SheetJS or ExcelJS). Decide between vendoring a pinned file and asking HR to save as CSV. |
| 6 | `ats-heuristic-ux-audit` | The import preview is the risky screen: it must make "212 unchanged, 9 moved, 3 leavers, 4 rows rejected" obvious before confirming. |
| 7 | `ats-prd-and-improvement-plan` | This document's shape. |

The repo already has these skills. No outside skill is needed. The built-in
`xlsx` skill is for *producing* spreadsheets; it does not help the Hub *parse*
one at runtime.

---

## 4. Finding: production is not on GitHub

Method: on 12 Oct I downloaded every asset `10.20.0.9:4001` serves and
compared its git blob hash against every commit on all 39 remote branches. I
then diffed it against the nearest commit.

| File served by production | In any GitHub commit? | Nearest commit | Lines different from `main` |
|---|---|---|---|
| `styles.css` | no | 129a825 (27 Sep) | 230 (interview assessment form styles, notice changes) |
| `arabtec-approved-ui.css` | no | 129a825 | 8 |
| `arabtec-design-system.css` | no | 960dd2d (30 Sep) | 88 |
| `claude-system.css` | no | 960dd2d | 82 ("18c Row rules", owner review 4 Oct) |
| `arabtec-responsive.css` | no | 129a825 | 2 |
| `arabtec-mobile.css` | **yes** | 90b5fea (30 Sep) | 4 |
| `index.html` | no | 4455cbb | 28 |
| `build/app.js` | n/a (compiled) | — | has *Assessment Settings* (`interview.assessment_policy`), which appears nowhere in git history. Lacks WhatsApp interview messages, which are in `main`. |
| `build/org-structure.js` | n/a | — | v1 page. v2 is not deployed (flag off and code absent). |

**What this means.**
- Someone edited the server checkout, or deployed from a local machine, between
  30 Sep and 4 Oct. The work exists only on the server, and perhaps on that
  person's laptop.
- `08-redeploy.sh` refuses a dirty tree. If the server tree is dirty, the next
  redeploy stops, which is good. If the work was committed locally on the server
  and never pushed, a redeploy from `main` **silently removes** Assessment
  Settings, the assessment form and the row rules.
- "Match production exactly" cannot mean "match `main`". It has to mean
  "recover production into git first, then build on it".

**Recovery steps (owner: System Admin, read-only first).**
1. On the host:

   ```
   cd <checkout>
   git status --porcelain
   git log --oneline -15
   git log origin/main..HEAD --oneline
   git stash list
   ```

   This records whether the work is uncommitted edits or unpushed commits.
2. Bundle it without changing anything:

   ```
   git bundle create /tmp/prod-<date>.bundle --all
   git diff > /tmp/prod-uncommitted.patch
   ```

   Copy both off the host.
3. In a cloud session, push the bundle as branch `recover/prod-20261004j`.
4. Merge `main` into it. Conflicts are expected in `app.jsx`, `styles.css`,
   `claude-system.css`, `index.html` and the `?v=` strings.
5. Open a PR. Set `?v=` above both histories.
6. Run the full suite. Visually compare against the saved production assets
   (§5).
7. Only then does `main` contain production, and the containment gate turns
   green.

Until step 7 is done, **no deploy to 10.20.0.9 from `main`**. That includes the
Org chart v2 work.

Also outstanding: commit `66fcacf`, the round-2 review fixes for Org chart v2, is
on the feature branch but **not in `main`**, because PR #47 merged before it. It
needs a follow-up PR before v2 can ship.

---

## 5. UI parity with production

**Source of truth.** Production's six stylesheets and its compiled screens. They
are saved locally in a git-ignored folder, `docs/org-chart/reference/`, as
`onprem-snapshot-20261012.tgz`; nothing personal is in them. After §4 they are
the recovered branch.

**Rules for every new surface in this plan.**
- Page chrome:
  - `PageHead` with crumb `Workspace / Organization Structure`;
  - one head row of 40px controls (production's rule R-a);
  - 8/16/12 spacing (R-b);
  - filter rows as equal-column grids (R-c/R-d).
- Tables, cards, badges, modals, notices and empty states: reuse the components
  `app.jsx` already uses. Do not add new classes outside `.org2-*` sheet
  internals. Production's `.notice` has no left accent bar, so the v2 import
  banner must use the production `.notice`, not the `main` one.
- Sheet internals keep the clean minimal look that is already approved:
  - white cards, hairline borders, grey team headers, grey lines;
  - the green selection ring;
  - red only on joiner names;
  - no logo.
- Phone: the existing drill-down list stays. The sheet is desktop and tablet
  only.

**How parity is checked (not by eye alone).**
1. Use Playwright with Chromium, which is already installed in the cloud
   workspace. Run the recovered branch with seed data and the flag on, at
   1920×1080, 1440×900 and 390×844.
2. Screenshot each nav section. Diff the screenshots against production taken
   with the same viewport and a read-only account. Only Organization Structure
   may differ.
3. Run a computed-style check on the shared parts on both builds: head row
   height, control height, gap, notice border, badge colours. It must be
   identical.
4. Add the v2 page, the register table and the import preview to
   `component-gallery.html`.

---

## 6. The launch feature: upload the company org database

### 6.1 What HR uploads

One file, one row per employee, `.xlsx` or `.csv` (UTF-8). The Hub accepts the
HR Master Sheet's own column names through a mapping step. HR does not reformat
the sheet.

| Field | Required | Used for |
|---|---|---|
| Employee number | **yes** | The match key on every re-upload. Never the name. |
| Full name (English); name (Arabic) | yes; optional | Display |
| Job title / designation | yes | Matched to the 459-designation catalogue. Unmatched titles go to a review list. |
| Grade | optional | Checked against the designation's grade |
| Department | yes | Matched to `department` by code or name |
| Project | yes for site staff | Matched to `project`. The project picks the chart. |
| Site | optional | Matched to `site` |
| Reports to (employee number) | yes except the top | Builds the structure |
| Dotted line to (employee number) | optional | Dotted links |
| Share (e.g. 0.5) and a second project | optional | People shared between projects (the Al-Burouj & Aliva case) |
| Status | yes | `active`, `joining` (+ date), `leaving` (+ date), `left` |
| Joining date / leaving date | when relevant | Red joiner names with dates; leaver handling |
| Email, phone | optional | Links to Hub users |

**Open question Q1:** the actual HR Master Sheet columns. The CSV built from it
in September had `id, name, title, department, status, reports_to_id,
dotted_line_to_id, grade, employee_id, location, notes`. That was our extract,
not the sheet itself.

### 6.2 Data model (additive only)

- **`employee`** — the register:

  ```
  id, employee_no UNIQUE, full_name, full_name_ar, designation_id → designation,
  title_raw, grade, department_id, project_id, site_id, manager_employee_id → employee,
  dotted_manager_employee_id, status (active|joining|leaving|left), join_date,
  leave_date, email, phone, user_id → users (nullable, unique), application_id
  (the hire that created them, nullable), source_upload_id, created_at, updated_at
  ```

- **`employee_share`** — `(employee_id, project_id, share)`, for people split
  across projects. The existing shares invariant (total ≤ 1) moves from
  `org_assignment` to here.
- **`employee_upload`** — one row per upload:

  ```
  id, file_name, file_sha256, uploaded_by, status (previewed|applied|rolled_back|discarded),
  counts_json, mapping_json, created_at, applied_at
  ```

  The file itself is stored through the existing `file_blob` mechanism, readable
  only with `employee.import`.
- **`employee_upload_row`** — the staged rows and their outcome:

  ```
  upload_id, row_no, employee_no, action (new|update|move|leave|unchanged|reject),
  reason, before_json, after_json
  ```

  This is what the preview shows and what a rollback replays.
- **`org_assignment.employee_id`** already exists. It now references
  `employee.id`, so an assignment *is* "this employee in this box".
- **`recruitment_request.designation_id`** and **`.org_position_id`** — two
  nullable columns that link a request to the catalogue and to the chart seat.
  `org_position.requisition_seat_id` already exists for the reverse link.

All changes go through `addColumnIfMissing` and `CREATE TABLE IF NOT EXISTS`,
with parity in `prisma/schema.prisma` and `docs/SCHEMA.sql`. Nothing is dropped.

### 6.3 The upload flow (one screen, three steps)

It sits on Organization Structure → **Employee register** tab, behind the new
permission `employee.import`. HR Director and HR Admin hold it by default.

1. **Upload.** Drop the file. The Hub reads the header row and proposes a column
   mapping, remembered from last time. The person confirms the mapping.
2. **Preview.** Nothing is written yet. It shows:
   - Counts: new, updated, moved (changed manager, box or project), leavers,
     unchanged, rejected.
   - A table of every non-unchanged row, with before → after.
   - Rejected rows with the reason, for example:
     - "reports-to 10432 not found";
     - "creates a loop: A → B → A";
     - "share totals 1.5";
     - "duplicate employee number on rows 14 and 88".
   - **Structure changes**, listed separately: new boxes, removed boxes and
     changed reporting lines per chart. They will become drafts for approval.
   - Unmatched designations, departments, projects and sites, each with a
     one-click "map to…" or "add to catalogue".
   - The rejected rows can be downloaded as CSV to fix in Excel and re-upload.
3. **Confirm.** In one transaction:
   - update `employee`;
   - apply people changes live to each published chart;
   - create one draft per chart that has structure changes;
   - write `employee_upload_row` and the audit entries.

   This uses `lockChart` per chart plus an advisory lock on the register. It
   follows `lib/join.js`: one module owns the transaction.

**Partial uploads.** A file covering one project only must not turn every other
project's staff into leavers. The upload asks: "This file covers: ☐ whole
company ☐ only these projects [..]". People missing from the file are leavers
only inside the covered scope, and the leaver count is shown in red in the
preview before confirming.

**Rollback.** "Undo this upload" is offered on the most recent applied upload. It
replays `before_json` for its rows and discards drafts that were created by it
and not yet approved.

### 6.4 From register to chart

- **One chart per project**, plus head-office charts per department; `org_chart`
  already has `project_id`, `department_id` and `scope`.
- **Boxes are positions, not people.** A role box is (chart, designation,
  manager box). People with the same designation under the same manager share a
  box, which is how the Aliva sheet works ("Site Engineer ×6"). This is the
  grouping the v1 → v2 migration already does.
- **Placement.** A person is placed in the box whose designation matches theirs
  and whose manager box contains their manager.
  - If no such box exists, that is a *structure change*: a new box is created in
    the draft.
  - If the box exists, the person is added live.
- **Layout is kept.**
  - Re-uploads never move existing boxes.
  - New boxes go to the right of their siblings, and Auto-arrange respects
    *Arrange team* settings.
  - The editor's hand layout is the chart's own data, not the register's.
- **Joiners and leavers.**
  - `joining` + date shows a red name with the date.
  - `leaving` shows the existing leaving style.
  - `left` removes the person from the box and frees the seat. The seat becomes
    vacant: an approved position with no assignment.
- **Planned / proposed counts.** These stay chart data, edited by the chart owner.
  The register supplies *actual*. Planned versus actual is the gap that hiring
  closes.

### 6.5 Live vs approval, explicitly

| Change in an upload | Effect | Why |
|---|---|---|
| New employee into an existing box | Live | People change; the box exists |
| Employee moves between existing boxes (transfer) | Live | Same |
| Leaver | Live: seat becomes vacant | Same |
| Name, grade or contact change | Live (register only) | Not structural |
| New box needed, box empty and not in file, changed reporting line between boxes | Draft → HR Director approval | Structure; decided 1 Oct |
| Person's manager changed but both stay in the same boxes | Live | Box-level structure unchanged |

**Open question Q2:** should transfers *between projects* also need approval?
Recommended: no. It is a people change, and audit covers it.

### 6.6 "Real time" — what it means here

- **Within the Hub, it is immediate.** After confirming, the published chart's
  `updated_at` changes. Open chart pages check
  `GET /api/org/charts/:id/stamp` on focus and every 20 s, then reload the
  chart. That is cheap, works through plain HTTP and proxies, and needs no
  websockets.
- **Every section in §7 reads the register or chart at request time.** Nothing
  copies org data into other tables except the two link columns, so nothing
  goes stale.
- **Source to Hub runs at upload cadence.** HR re-uploads when the sheet
  changes. The Hub cannot see the sheet change by itself. §6.7 covers that.

### 6.7 Later option: automatic feed (not in this launch)

There are two possible sources, both behind a decision (**Q3**):

1. **SharePoint/OneDrive file.** The Hub already holds a Microsoft Graph
   connection for the career mailbox. A scheduled read of the HR Master Sheet
   from a named SharePoint path could run the same preview. It auto-applies only
   people changes, and posts structure changes as drafts.
2. **Entra ID `manager` attribute.** It may be incomplete for site staff.

Either source needs new Graph scopes (`Files.Read.All` or `User.Read.All`) and a
vendor-risk update.

### 6.8 Excel parsing

The repo has no `.xlsx` reader. There are two options (**Q4**):

- **(a) CSV only at launch.** HR uses Save As → CSV UTF-8. This needs no new
  dependency, but it is one more step for HR, and Arabic encoding mistakes are
  likely.
- **(b) Add `.xlsx` support.** Server-side ExcelJS or SheetJS via npm,
  pinned. Run ats-vendor-risk, cap the file at 5 MB, and treat formula cells as
  their values only. *Recommended (b)*: the HR Master Sheet is Excel, and a
  failed Arabic CSV is a launch-day support call.

---

## 7. Section by section: does it hold org-chart information, and how to connect it

Direction key:
- **chart → section**: the section reads org data.
- **section → chart**: the section's actions change the chart or register.
- **reference**: the chart reads the section's master data.

Phase: L = launch, P2 = after launch.

| Section | Holds info that should come from the org chart? | What, specifically | Direction | How to implement | Phase |
|---|---|---|---|---|---|
| **Organization Structure** | It *is* the chart | v1 page on production today | — | Replace with v2 behind `org_chart_v2`. Add the **Employee register** tab (list, filters by project, department and status, upload) and a **Vacancies** tab. | L |
| **Hiring Requests** | **Yes, strongly** | A request is a vacancy on a chart: designation, grade, department, project, site, reporting line (`hiring_manager_id`) and seat count | chart → section; section → chart | 1. "Open request" on a vacant position, or on a box's planned-actual gap, prefills the wizard: designation (→ title, grade, function), department, project, site, and the hiring manager = the person in the parent box. The requester still reviews and submits. 2. Store `org_position_id` and `designation_id` on the request. Each `requisition_seat` links to an `org_position`. 3. On the chart, a vacant seat with a request shows the request number. 4. Cancelling a request frees the link only; the position stays vacant. | L |
| **Talent Pool** | Minor | Whether a candidate is already an employee (rehire or internal move) | chart → section | Match candidate email or phone against `employee`. Show a "Current employee: <project>" badge. No blocking. | P2 |
| **Candidate Review** | No | Its own screening data | — | Nothing. It can show the request's reporting line, which comes via the request. | — |
| **CV Inbox** | No | Mailbox intake | — | Nothing. A future duplicate check uses the same employee match as Talent Pool. | — |
| **Interviews** | Some | Who should be on the panel: the line manager of the position, and the department head | chart → section | When scheduling for a request linked to a position, *suggest* the parent-box person and the department head as panel members, if they are Hub users. Suggest only; the recruiter picks. | P2 |
| **Assessment Settings** (production only) | No | Scoring policy | — | Nothing. It must be recovered (§4). | — |
| **Offers** | Yes, as an output | The accepted offer's joining date is the "red joiner with date" on the chart | section → chart | When an offer is **accepted**, add a `joining` assignment with `effective_date = joining_date` to the request's position. This only *shows* the expected joiner; it creates no employee yet. If the offer is withdrawn or rejected, remove that assignment. (**Q5**: show joiners from acceptance, or only from join?) | L |
| **Join / onboarding** (`lib/join.js`) | **Yes, strongly** | Joining fills a seat and creates an employee | section → chart | Inside the existing join transaction: create the `employee` row (status `joining` → `active` on the joining date), turn the position's joining assignment into `in_post`, and mark the seat filled. The `fillSeatAndCount` CAS already exists. The next HR upload then *matches* this employee by number; it does not duplicate them. **Q6**: who enters the employee number, and when? Recommended: HR at join, as a required field of the join dialog once the register is on. | L |
| **Dashboard** | Yes, as a read | Headcount actual vs planned per project; vacancies; vacancies without a request; upcoming joiners and leavers | chart → section | Add four tiles that read from the register and chart. Respect `user_scope`: a project manager sees their project. | L |
| **Reports** | Yes, as a read | Headcount by project, department and designation; vacancy ageing; time-to-fill per position; turnover | chart → section | Add new report tabs over `employee`, `org_position` and `requisition_seat`. Export through the existing CSV with the formula guard. | P2 |
| **Projects** | Yes, both ways | `project_manager_id`; the list of projects charts belong to | reference + check | A chart's scope picks from Projects. The upload matches the project column to `project`. On publish, compare the chart's top box with `project_manager_id` and show "differs: update?" to an admin. Never update it silently. | L (reference), P2 (check) |
| **Sites** | Yes, both ways | `site_manager_id`; employee site | reference + check | Same pattern as Projects. | L / P2 |
| **Departments** | Yes, both ways | `head_user_id`; the department of every employee | reference + check | Same. The head-office department charts use `scope='department'`. | L / P2 |
| **Users** | **Yes** | `employee_no`, `job_title` and `department_id` already exist on `users`; project and site scope | chart → section (suggest) | 1. Link `employee.user_id` by matching `users.employee_no`, then email. Unmatched users are listed. 2. On the Users page, show the employee's position read-only, and "Title/department differ from register: update?". 3. **Scope suggestion:** "This person sits on Aliva and Al-Burouj: suggest scope = those projects". An admin applies it. Permissions are never granted automatically. | L (link), P2 (suggest) |
| **Roles & Permissions** | No data | Needs new permissions | — | Add `employee.view` (register read; HR roles), `employee.import`, and `org_chart.approve` (HR Director; today this is a role check). The existing `org_chart.manage` stays. | L |
| **Workflow Settings** | Yes | Approval levels resolve by `role_code` today, so "line manager" is not expressible | chart → section | Add an approver type **"Line manager of the position"** that resolves through `request.org_position_id` → parent box → in-post person → their `user_id`. Fall back to the role if empty. Optional per workflow. | P2 |
| **Notification Settings** | Some | Recipients such as "the hiring manager's manager" | chart → section | Add the same resolver as a recipient option. | P2 |
| **Control Center** | No data | Feature flags | — | Add the flags `org_chart_v2` (exists) and `employee_register` (new), both off until the launch gate. | L |
| **Branding / Button Settings** | No | — | — | Nothing. | — |
| **Microsoft 365** | Later | The Graph connection could feed §6.7 | — | Nothing at launch. | P2+ |
| **Email & Mailbox** | No | — | — | Nothing. | — |
| **System Settings** | Some | Chart warning thresholds (`system_setting`, already in the v2 plan) and the upload size limit | — | Add the keys. | L |
| **Audit Log** | Receives | Every upload, row outcome, live change, draft and approval | section → audit | `writeAudit` with before and after. Uploads are recorded as one parent entry, with rows in `employee_upload_row`, so the log stays readable. | L |

**Count.** 10 nav sections read from or write to the chart: Hiring Requests,
Offers, Dashboard, Reports, Projects, Sites, Departments, Users, Workflow and
Notifications. The join step does too. Interviews and Talent Pool get light
suggestions. The remaining 11 need nothing, or only flags, permissions and
settings.

---

## 8. API (additions under `/api/org`)

| Method and path | Permission | Purpose |
|---|---|---|
| `POST /employees/uploads` (multipart) | `employee.import` | Store the file, parse it, propose a mapping → `{uploadId, columns, mapping}` |
| `PUT /employees/uploads/:id/mapping` | `employee.import` | Confirm the mapping and scope → runs the preview, returns counts and rows (paged) |
| `GET /employees/uploads/:id/rows?action=&page=` | `employee.import` | Preview table |
| `GET /employees/uploads/:id/rejected.csv` | `employee.import` | Download the rejects, with the formula guard |
| `POST /employees/uploads/:id/apply` | `employee.import` | Apply (one transaction) → summary, plus the drafts created |
| `POST /employees/uploads/:id/rollback` | `employee.import` | Undo the latest applied upload |
| `GET /employees?project=&department=&status=&q=` | `employee.view` | Register list |
| `GET /employees/:id` | `employee.view` | One employee, with position and history |
| `GET /charts/:id/stamp` | signed in | `{updatedAt, currentVersionId}`, for the live refresh |
| `GET /vacancies?project=` | signed in, scoped | Approved positions with no in-post person, plus their request link |

Validation uses zod, like `lib/org-charts.js`. The upload cap is 5 MB. Files
are only `.xlsx` and `.csv`, checked by magic bytes as well as extension.
Stored names are server-generated.

---

## 9. Phases and order

| Step | What | Owner | Done when |
|---|---|---|---|
| 0 | Recover production into git (§4); merge `main`; follow-up PR for `66fcacf` | System Admin (host), agent (merge and PR) | `git merge-base --is-ancestor <prod-sha> main` passes; suite green; production screenshots identical |
| 1 | Parity harness: Playwright screenshots and the computed-style check (§5) | agent | The script runs in CI and diffs against the stored production baseline |
| 2 | Register schema, upload, preview, apply, rollback; permissions; audit | agent | Tests on SQLite and PGlite: re-upload is idempotent, partial scope, loops, shares, rollback, Arabic names, formula cells |
| 3 | Register → chart generation; live vs draft split; stamp refresh | agent | A synthetic 300-person file builds charts. A second file with 5 moves, 2 leavers and 1 new box gives 7 live changes and 1 draft |
| 4 | Hiring Requests ↔ positions; Offers and Join → chart; Dashboard tiles | agent | "Open request" from a vacancy prefills 6 fields. Join fills the seat and creates the employee. Tiles match the register counts |
| 5 | Launch readiness sweep; security review; vendor risk (xlsx) | agent + owner | All gates green, with owners named |
| 6 | Pilot: upload one project (the Aliva file) on production with the flags on for HR only | Org chart owner + HR Director | Chart matches the PDF box for box. HR Director approves one structural draft |
| 7 | Company-wide upload; turn the flags on for all roles | Org chart owner | Success metrics in §1 hold for one week |
| P2 | Users scope suggestions, Workflow and Notification resolvers, Interviews suggestions, Reports, Talent Pool badge, SharePoint feed | agent | Each behind its own setting |

Steps 2–4 are one PR each, behind `employee_register`. None of them deploys
until step 0 is complete.

---

## 10. Risks

| Risk | Harm | Mitigation |
|---|---|---|
| Deploying from `main` before recovery | Production loses Assessment Settings, the assessment form and the row rules | Step 0. The launch-readiness containment gate blocks the deploy. |
| Upload of a partial file marks the company as leavers | Charts emptied; seats shown vacant; false requests | Scope question, red leaver count in the preview, and rollback |
| Employee number missing or inconsistent in the sheet | Duplicates on re-upload | Employee number is required, rows without it are rejected, and duplicates are flagged in the preview |
| Titles that don't match the catalogue | Boxes split wrongly | Unmatched list with "map to…" in the preview; the mapping is remembered |
| Personal data in a new store | Exposure | `employee.view` is limited to HR roles. Everyone else sees charts (names in boxes) as today. No export of the register except by HR. The security review runs before merge. |
| The chart shows a joiner who never arrives | Misleading chart | Joiner from offer acceptance is removed on withdrawal. Elapsed joiners are flagged (already in v2). |
| Real names leaking into git | Personal data in a repo | Reference data stays git-ignored. Tests use invented names. The upload files live in the database, not on disk in the checkout. |

---

## 11. Open questions (who decides)

| # | Question | Recommended | Decides |
|---|---|---|---|
| Q1 | The exact HR Master Sheet columns, and is the employee number on every row? | Send a header-only copy | Org chart owner |
| Q2 | Do transfers between projects need approval? | No: live and audited | HR Director |
| Q3 | Automatic feed from SharePoint/Entra after launch? | Decide after the pilot | HR Director + IT |
| Q4 | Accept `.xlsx` at launch, or CSV only? | `.xlsx` (vendor review) | Owner |
| Q5 | Do joiners show from offer acceptance, or only from join? | From acceptance, in red with the date | HR Director |
| Q6 | Is the employee number required at join, and who enters it? | HR, in the join dialog | HR Director |
| Q7 | Who may see the register (as opposed to the charts)? | HR roles and the HR Director only | HR Director |
| Q8 | Who did the 30 Sep – 4 Oct production changes, and is there a local copy? | — | Owner / System Admin |
| Q9 | Is the production work uncommitted edits or unpushed commits on the host? | Run §4 step 1 | System Admin |

---

## 12. Acceptance (owner checks in the browser)

1. Production's pages and the recovered build's pages are pixel-identical at
   1440×900 in every section except Organization Structure.
2. Upload the September Aliva extract → preview shows N new, 0 rejected →
   confirm. The Aliva chart matches the October PDF's people box for box.
3. Edit 5 rows in Excel (2 transfers, 1 leaver, 1 joiner with a date, 1 new role
   under the DPM) and re-upload. The preview shows 4 live changes and 1
   structure change. After confirming, the chart shows the 4 at once, and a
   draft holds the new box. The HR Director approves it, and it appears.
4. Undo the upload: everything from step 3 reverts, and the draft is discarded.
5. On a vacant Site Engineer seat, click *Open request*. The wizard opens with
   designation, grade, department, project, site and hiring manager filled in.
6. Join a candidate on that request. The seat fills, the person appears on the
   chart and in the register, and the next upload containing them changes
   nothing.
7. The Dashboard headcount for Aliva equals the register's count.
8. Every step above appears in the Audit Log. `npm test` passes on SQLite and
   PGlite.
