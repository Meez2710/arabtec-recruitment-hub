# Page-by-page product review — 30 Sep 2026

Reviewer stance: SaaS product designer and UX management consultant.
Build reviewed: `main` at `77947ef` (after PR #43), local SQLite with seeded
data: 5 hiring requests (1 pending approval), 14 candidates including three
Arabic names and one very long English name, 11 applications across stages,
4 interviews, 2 offers (one standalone). Captured at 1440×900 and 390×844 as
System Admin, Recruiter (Karim Adel) and HR Director (Layla Hassan).

Method: Nielsen's ten heuristics plus the four ATS rules in
`.claude/skills/ats-heuristic-ux-audit` (11 no unasked blockers, 12 uncertainty
labelled, 13 Arabic renders, 14 phone parity). Severity 0–4 (Nielsen).
Measured on every page: horizontal overflow at 1440 and 390 is **0 everywhere**.

Pages are ordered by how much of a recruiter's day they carry.

---

## 1. Dashboard  — overall 7/10

**What it is for.** The first screen each role sees; it must answer "what do I do next?" in one glance.

**What works.** Persona-specific dashboards (Recruiter "Your next actions", Director "Hiring plan and recruitment health") are the right idea. Every action row opens the exact record it names. Honest empty values ("—", "not yet measured") instead of fake zeros.

| # | Finding | Heuristic | Sev | Evidence | Suggestion |
|---|---|---|---|---|---|
| D1 | Every row in "Open roles" / "My roles" has a full green primary **Open** button: 5–9 identical primaries on one screen, plus the header primary. Nothing is primary when everything is. | 8 aesthetic, 4 consistency | 2 | dashboard-1440, dashboard-recruiter-1440 | Make the whole row the link; drop the button, or make it a quiet chevron. Keep one primary per screen. |
| D2 | An unlabelled **"0d"** floats above each Open button. | 2 match real world, 6 recognition | 2 | `app.jsx:2016` | Label it: "Open 12 days". |
| D3 | KPI "Time to fill" carries the subtitle "Offer acceptance not yet measured" — two different metrics in one tile. | 2, 4 | 2 | `app.jsx:2597` | Subtitle should talk about time to fill ("no role filled yet"); give offer acceptance its own tile or drop it here (Reports has it). |
| D4 | "Healthy" badge on a request still **Pending approval**: the SLA clock is presented as healthy for work that has not started. | 1 system status | 2 | dashboard-1440 (Document Controller) | Show "Awaiting approval" instead of a health badge until sourcing starts. |
| D5 | Admin sees five persona tabs; the choice is remembered per device. Good for demos, but the default is "Director" for an admin — confusing on first use. | 6 | 1 | `app.jsx:2792` | Default the admin to the Recruitment manager view, or label the tab row "View as". |
| D6 | "Open roles by age" label truncates ("Overdue · 61–90 d…"). | 8 | 1 | dashboard-1440 | Shorter labels: "61–90 d", with the colour legend carrying overdue. |
| D7 | Phone: 3,762px tall. "Hiring plan by project" becomes a stack of label/value cards (≈600px per project); KPI strip scrolls sideways with the 2nd tile cut. | 14 phone parity | 2 | dashboard-390 | On phone show the action list and KPIs only; link "Hiring plan" to Reports. Use a 2×2 KPI grid, not a scroller. |
| D8 | The floating "a" assistant button sits over the Progress column and card corners. | 8 | 1 | dashboard-1440 at x≈1390 | Reserve a bottom-right safe area (padding-right on `.content` at desktop), or dock the assistant in the top bar. |

**Priority suggestion:** turn the dashboard into a true *inbox*: a single ranked list of "things waiting on you" (approvals, feedback due, interviews today, offers to send) above the analytics, with analytics folded below. The Recruiter view is already close; the Director view leads with analytics instead.

---

## 2. Talent Pool (pipeline, cards, table)  — overall 6.5/10

**What it is for.** Where recruiters live: find people, move them through stages, link them to requests.

**What works.** One primary action (Parse CV). Ask bar for plain-English search. Arabic names and positions render right-to-left correctly in cards and table (rule 13 passes). "Returning" badge on a previously-rejected candidate is excellent (rule 12).

| # | Finding | Heuristic | Sev | Evidence | Suggestion |
|---|---|---|---|---|---|
| T1 | **Two stage vocabularies.** The board has columns "Screening / 1st interview / Offer" while cards inside say "Shortlisted", "Matched", "Interviewing", "Waiting feedback"; the Table view's STAGE column says **"New"** for every candidate, including ones in interview and offer. Screening tabs (All 14 · New 14 · Screening 0 · Fit 0) contradict the board. | 4 consistency, 2 | **3** | candidates-1440, candidates-table-1440 | One vocabulary. Rename the fitness-screen state to "Screening status" and show it only where it matters; the table's Stage column must show the pipeline stage. |
| T2 | Board shows ~5 of 6 columns at 1440; the last is cut with no visible scroll affordance. | 1, 8 | 2 | candidates-1440 right edge | Narrower columns (220px) or a visible scroll shadow + "→ 1 more stage". |
| T3 | Names truncate early ("Ahmed Mostaf…") while cards have spare width; column header "1ST INTERVIEW (HR)" wraps to two lines. | 8 | 1 | candidates-1440 | Allow two lines for names; shorten the column title to "Interview". |
| T4 | Unlinked cards reserve the full card height with only name + title, leaving ~50% empty. | 8 | 1 | candidates-1440 column 1 | Compact card variant for unlinked people with the "Link to request" action inline. |
| T5 | Table view: University / Year columns are all "—" for everyone yet take 20% of width; the Request cell stacks a pill + an empty dashed dropdown under it, doubling row height (≈97px per row). | 8 | 2 | candidates-table-1440 | Hide empty columns (column chooser); put the link dropdown behind the pill's chevron, one line per row. |
| T6 | Filter row in Table view is two ragged lines (Location, Company, Grad from, Grad to, Tag, quality, classification). | 8, 7 | 2 | candidates-table-1440 | Keep search + 2 key filters visible; move the rest to a "More filters" popover (the phone already does this with "Filters"). |
| T7 | Phone cards show only name + title + an "Action" dropdown — no stage, request, experience or location, so a recruiter must open each card. | 14, 6 | 2 | candidates-390 | Show stage badge + request code + "8y · Cairo" on the phone card; make the whole card tappable. |
| T8 | Head row on phone scrolls sideways and cuts "Add manually" mid-word. | 14 | 1 | candidates-390 | Overflow menu "More ▾" after Parse CV. |
| T9 | Opening a candidate from a pipeline card showed the list skeleton for over 4 s in the automated run; I could not confirm whether it is slow or a missed click. | 1 | ? | candidate-profile capture | Verify by hand; if slow, show the profile skeleton immediately (it currently renders a list-shaped skeleton). |

---

## 3. Hiring Requests (list + detail)  — overall 7/10

**What it is for.** The controlled ticket for each hiring need: approval, ownership, SLA.

**What works.** Clear columns (ticket, position, project, owner, pipeline count, priority, status, SLA). The detail page puts the decision (Approve / Reject) first for the approver. The per-request board (Candidates tab) reuses the Talent Pool board — good consistency.

| # | Finding | Heuristic | Sev | Evidence | Suggestion |
|---|---|---|---|---|---|
| R1 | Colour semantics collide: **Medium** priority and **Sourcing** status are the same green pill; High priority is amber like "Pending approval". | 4, 8 | 2 | requests-1440 | Priority as a small text/arrow indicator (↑ High), keep coloured pills for status only. |
| R2 | "IDLE 0d" and "SLA Healthy 0d" repeat the same number in two columns. | 8 | 1 | requests-1440 | Merge: "Healthy · idle 0d". |
| R3 | Unassigned owner shows as grey "Assign" text that reads as disabled. | 6 | 2 | requests-1440 row 1 | "Unassigned" in amber with an Assign button on hover/for managers. |
| R4 | Filter area is two rows with the search box vertically centred against both, and the count pill floating alone at the right. | 8 | 1 | requests-1440 | One row: search · status · priority · owner · "More" (Needs action, Open only, Sort). |
| R5 | Detail header carries 6 actions (Approve, Reject, Assign recruiter [disabled], Pause, Edit, Close). The disabled one gives no visible reason. | 5, 8 | 2 | request-detail-1440 | Keep Approve/Reject visible; put Pause/Edit/Close in a "More" menu; show a reason under a disabled action ("Assign after approval"). |
| R6 | Conversation author avatar shows a dot instead of initials ("• Omar Khalil"). | 8 | 1 | request-detail-1440 | Use the same initials avatar as everywhere else. |
| R7 | "Request details" is collapsed by default behind a small "Show" link; job description and justification are what an approver needs to decide. | 6 | 2 | request-detail-1440 | Expand by default when the request is pending approval. |
| R8 | "Healthy 0d" on a pending request (same as D4). | 1 | 2 | request-detail-1440 | As D4. |
| R9 | The address bar never shows a record's link: the hash is cleared on load, and opening a request, candidate or offer does not change the URL, so a recruiter cannot copy a link to "RQ-26-005" into Teams or email. (Interviews accept `#interviews?openId=<id>` on entry, but nothing produces that link for the user.) | 7 flexibility | **3** | `app.jsx:1411-1418` clears the hash | Keep `#requests/<id>` (and the same for candidates, interviews, offers) in the URL while a record is open. This matters most for approvers who arrive from an email. |

---

## 4. Candidate Review (intake exceptions)  — overall 7.5/10

**What works.** Clear promise ("CVs that need a person"), strong empty state ("Nothing needs you"), and the rule text explains why rows land here.

| # | Finding | Heuristic | Sev | Suggestion |
|---|---|---|---|---|
| CR1 | Nav says "Candidate Review", page says "Candidate Intake Review". | 4 | 1 | One name. `intake-review.jsx:495`. |
| CR2 | **Refresh** is the primary button, Upload CV is secondary. Refresh is housekeeping. | 4, 8 | 1 | Upload CV primary (or no primary when the queue is empty). |
| CR3 | The "Workflow control" info panel repeats the subtitle in more words and sits on every visit. | 8 | 1 | Collapse into a one-line hint with "How this works". |
| CR4 | "0 pending" amber chip is amber even at zero. | 1 | 1 | Neutral at zero, amber only when > 0. |

---

## 5. CV Inbox / CV Intake  — overall 6.5/10

| # | Finding | Heuristic | Sev | Suggestion |
|---|---|---|---|---|
| CV1 | The root cause ("mailbox not connected") is shown **below** the "Waiting to parse" card, after two disabled buttons. | 1, 9 | 2 | Put the connection warning first, with a "Connect Microsoft 365" button for admins; hide or collapse "Waiting to parse" until connected. |
| CV2 | "Scan inbox now" and "Refresh from mailbox" are disabled with the reason only in a tooltip. | 5, 9 | 2 | Inline reason under the disabled control. |
| CV3 | Two tab-like rows (Inbox / Failed / History) and two separate empty states on one page when nothing is connected. | 8 | 1 | One empty state explaining the setup. |
| CV4 | The "Advanced" card's "Show" toggle is covered by the floating assistant button. | 8 | 2 | See D8. |
| CV5 | Nav label "CV Intake" vs page title "CV Inbox". | 4 | 1 | Pick one. |

---

## 6. Interviews  — overall 7.5/10

**What works.** Real calendar (Day / Week / Month / List), click an open slot to schedule, today highlighted, standalone "Schedule interview". Detail page is clear and puts actions first.

| # | Finding | Heuristic | Sev | Suggestion |
|---|---|---|---|---|
| I1 | Nav badge says **4**, the page count pill says **2 interviews** (only the visible week). | 1, 4 | 2 | Label "2 this week · 4 upcoming". |
| I2 | Lower-case type labels ("technical", "hr") in events and titles ("technical interview — Omar Haddad"). | 4 | 1 | Title case from a label map: "Technical interview". |
| I3 | Detail page dates are raw locale strings ("10/1/2026, 10:00:00 AM"; activity "9/30/2026, 7:01:03 AM"), unlike the list's "20 Oct 2026". | 4 | 1 | Use the app's date formatter everywhere. |
| I4 | Video link is plain text, not a link or "Join" button. | 7 | 2 | "Join Google Meet" button on the detail page for video interviews. |
| I5 | Week view starts at 09:30 with empty hours dominating; weekend columns (Sat/Sun) shown though the site week is Sun–Thu in Egypt. | 2 | 1 | Configurable working week (Sun–Thu) and hours. |

---

## 7. Offers  — overall 7/10

| # | Finding | Heuristic | Sev | Evidence | Suggestion |
|---|---|---|---|---|---|
| O1 | **Bug:** a standalone offer (no request) renders an **empty green pill** in the Request column. Introduced by PR #39. | 8 | 2 | `app.jsx:10158` | Render "—" when `o.request` is null (same as Project). |
| O2 | "Approved by —" column is empty for most offers and takes 10% width. | 8 | 1 | offers-1440 | Merge into Status ("Approved by L. Hassan" as a sub-line). |
| O3 | Filters: a checkbox "To issue" plus "Joining from" date input without a "to", on one row with search. | 8 | 1 | offers-1440 | Status chips (All · Draft · Awaiting approval · To send · Sent · Accepted) instead of a dropdown + checkbox. |
| O4 | No expiry shown in the list although offers now carry an expiry date. | 1 | 1 | — | Show "expires in 5 days" in amber under Joining when set. |

---

## 8. Reports  — overall 7/10

Clean, honest ("—" when nothing measured), exportable. Suggestions: a date-range selector (currently all-time only); funnel conversion % between stages rather than share of total; make each bar clickable to the filtered list (sev 2, heuristic 7).

## 9. Organization Structure  — overall 5/10

| # | Finding | Sev | Suggestion |
|---|---|---|---|
| OS1 | Canvas opens with ~500px of empty space between the root and the first row of people; cards are cut at both edges. | 2 | Fit-to-screen on load; start collapsed at the department level. |
| OS2 | Tool buttons (Expand, Collapse, Zoom in, Zoom out, Fit) are unstyled text. | 1 | Group as an icon toolbar. |
| OS3 | Legend swatches are 8px and nearly invisible. | 1 | Larger swatches, or drop the legend and label cards. |

## 10. Users  — overall 5.5/10

| # | Finding | Sev | Suggestion |
|---|---|---|---|
| U1 | Row actions wrap: "Deactivate" drops onto the next row's border and overlaps it on every row. | **3** | `app.jsx:3240` `.user-actions`: one "⋯" menu per row (Activity, Reset password, Deactivate), keep Edit visible. |
| U2 | Status "active" in lower case; last login shows seconds. | 1 | "Active"; "30 Sep, 07:01". |
| U3 | No filter by role/status. | 1 | Role and status filters. |

## 11. Configuration pages (Control Center, Notification Settings, Roles, Buttons, Branding, Workflow, Email, Microsoft 365, System, Audit)

| # | Finding | Sev | Suggestion |
|---|---|---|---|
| C1 | **Duplicate homes.** Buttons are managed in Control Center → Buttons *and* in "Button Settings"; branding in Control Center → Branding *and* "Branding Settings"; notifications in Control Center → Notifications *and* "Notification Settings". Seven admin areas in the sidebar. | **3** | One Settings area with sections (General, Users & roles, Workflow, Notifications, Integrations, Appearance, Audit). Remove the duplicate pages. |
| C2 | Notification Settings has no page title (no PageHead) and repeats a 7-checkbox recipient block under each of 17 events (3,607px tall). | 2 | A matrix: events as rows, recipients as columns, one checkbox per cell. |
| C3 | Roles & Permissions is 4,000px of checkboxes. | 2 | Group by module with "select all in module" and a search. |
| C4 | Buttons page: 240 controls under 32px tall. | 1 | Table with inline toggles, filters by page. |

---

## Cross-cutting

| # | Finding | Sev | Suggestion |
|---|---|---|---|
| X1 | The whole SPA (`app.jsx`, >500 KB) is compiled by Babel **in the browser on every load**; Babel warns it "deoptimised" the file. First paint after login showed "Loading Arabtec Recruitment Hub…" for several seconds in capture. | **3** | Precompile JSX at build time (esbuild, one command) and serve a minified bundle; keep in-browser Babel only for local dev. Biggest single speed win. |
| X2 | Too many primaries: dashboard rows, CV Review Refresh, Ask bar was fixed in PR #39. | 2 | Enforce "one primary per view" in the R17 test. |
| X3 | Raw dates in several places (interview detail, users). | 1 | One date formatter. |
| X4 | Floating assistant covers content on 4+ pages. | 2 | See D8. |
| X5 | No deep links to records (R9). | 3 | See R9. |
| X6 | Every heading has an uppercase eyebrow (R11) *and* a subtitle sentence *and* often a hint box: three layers of explanation above the work. | 1 | Keep the eyebrow; drop the hint boxes once a page has been visited (remember per user). |

---

## Three patterns to keep
1. **Persona dashboards whose rows open the exact record** (Recruiter "Waiting on you").
2. **Honest data states**: "—", "not yet measured", "Returning" badge, "Nothing needs you".
3. **One board component** reused on Talent Pool and inside each request.

## Three patterns to remove
1. **Duplicate settings pages** (C1).
2. **Button-per-row primaries** in lists (D1).
3. **Two stage vocabularies** (T1).

## Suggested order of work
1. X1 precompile the app (speed, everyone, every day).
2. T1 one stage vocabulary; O1 empty pill bug; U1 users row actions.
3. R9 / X5 deep links to records.
4. C1 consolidate Settings.
5. D1–D4 dashboard as an inbox.
6. Phone: T7, D7.

No severity-4 (release-blocking) findings.
