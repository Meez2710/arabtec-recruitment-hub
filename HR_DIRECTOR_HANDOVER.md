# Arabtec Recruitment Hub — Review Access & Status

**Prepared:** 26 July 2026
**Build deployed:** `981f880` (asset version `20260726j`)
**For:** HR Director review

---

## 1. Access

**System link:** https://arabtec.onrender.com

**Login details**

| Field | Value |
|---|---|
| Email | `layla.hassan@arabtec.com` *(to be created — see below)* |
| Password | *(sent separately — not written in this document)* |
| Role | HR Director |

> **Action required before sending this to the HR Director.**
> Sample accounts are deliberately **not** created on the live system, so no
> publicly-known password exists there. The System Administrator must create
> her account first:
>
> 1. Sign in at https://arabtec.onrender.com as `admin@arabtec.com`
>    (first-run password appears once in the Render deploy log; you will be
>    asked to change it at first login).
> 2. Go to **Administration → Users → Add User**.
> 3. Create the user with role **HR Director** and set a temporary password.
> 4. Send that password to her by a separate channel — not in this document.
>
> The HR Director role is **approval-focused**: she can view everything and
> approve or reject hiring requests, but cannot create requests or candidates
> herself. If she needs to create records during the review, use the
> **HR Manager** role instead.

**Note:** the live system starts **empty** — no hiring requests or candidates
yet. To review the full workflow, create one test request and add a couple of
candidates to it.

---

## 2. Where the project stands

The system is **live and usable for review**. This release focused on the user
interface and on making the core recruitment workflow visually complete and
consistent. The underlying data model, permissions and audit trail were already
in place and were not changed.

### Working now

| Area | Status |
|---|---|
| Login & security | Working — role-based access, 9 roles, 50 permissions, full audit log |
| Dashboard | Working — 8 live metrics, hiring funnel, SLA health, recruiter load |
| Hiring Requests | Working — list and card views, filters, search by short code (RQ-26-001) |
| Request detail / ticket | Working — conversation thread, details, activity, approvals |
| Candidate Board | Working — Board / List / Table views, stage movement, disqualify |
| Talent Pool | Working — candidate database, screening states, search and filters |
| Interviews | Working — schedule list, status and outcome tracking |
| Offers | Working — offer list, approval states, joining dates |
| Reports | Working — funnel, request status, ageing, offer outcomes, CSV export |
| CV import | Working — import CVs directly against a hiring request |

### Deliberately hidden

**Salary and compensation are not displayed** anywhere in the Talent Pool,
Offers list or Candidate Board. This was a deliberate decision for this
release. Salary remains available inside permission-controlled detail screens
only.

---

## 3. Known limitations in this release

These are known and accepted — not defects to report:

1. **Interviews shows an empty state** until interviews are scheduled.
2. **No trend indicators** on dashboard metrics (no "+3 vs last week"). The
   system does not yet store historical snapshots.
3. **Reports has no time-series charts**, for the same reason.
4. **Second interview round** is not tracked as a separate pipeline stage. The
   system models a single "Interview" stage.
5. **Detail sub-screens** (conversation thread, assessment forms, some pop-up
   dialogs) have not yet had the new visual treatment applied.
6. **Record ownership** on any restored records shows the recovering user
   rather than the original owner.

---

## 4. What we would like feedback on

1. Does the **Dashboard** show the numbers an HR Director actually needs first?
2. Is the **Hiring Requests** list clear enough to work from daily?
3. Does the **Candidate Board** match how the team actually moves candidates?
4. Is the **approval flow** (submit → approve → sourcing) correct for Arabtec?
5. Anything in the wording, labels or terminology that does not match how the
   business speaks?

---

## 5. Next stages

**Stage A — Detail screens polish**
Apply the new visual standard to the conversation thread, assessment forms and
dialogs. These work correctly but look older than the rest.

**Stage B — Interview scheduling depth**
Calendar view, panel management, feedback capture and scorecards.

**Stage C — Reporting & history**
Store periodic snapshots so trends, time-to-fill history and week-on-week
comparisons become possible.

**Stage D — Access model refinement**
Three-tier access presets (Own Requests / Department / Organisation-wide) to
simplify role assignment.

**Stage E — Operational hardening**
Automated database backups, restore drills, and monitoring alerts.

---

## 6. Support

Report anything that looks wrong with:

- the **page** you were on,
- what you **expected**, and
- a **screenshot** if possible.

If a page appears out of date, refresh with **Cmd+Shift+R** (Mac) or
**Ctrl+F5** (Windows) before reporting it.
