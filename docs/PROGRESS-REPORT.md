# Arabtec Recruitment System — Progress Report

Plain-language updates on the improvement work. Newest step at the top of
"Steps". Updated by Claude at every step.

Last updated: 30 Sep 2026

---

## The company server (the live system staff use)

**Nothing has been changed on the company server.** Claude works in the cloud
and cannot reach the company network, so every change so far is saved in the
project's code library (GitHub) only. Staff still see the old version until
someone updates the server.

**To update it:** the person who looks after the server runs the update steps
Claude provided (they back up the data first, then install the new version).
It takes a few minutes. Nothing is deleted, and it can be undone.

**What staff will notice after the update** (everything below, all at once):

1. The system opens in under a second instead of about six seconds.
2. Talent Pool: one clear set of stage names, and each candidate card shows
   the stage, the hiring request, years of experience and city.
3. Dashboard: calmer, one main button, and requests waiting for approval say
   "Awaiting approval" instead of "Healthy".
4. Every request, candidate, interview and offer has its own link that can be
   pasted into Teams or email.
5. Interviews and offers can be created directly, without going through a
   hiring request first.
6. The Control Center has a place to edit the quotes shown at the bottom of
   each page.
7. Dates look the same everywhere ("1 Oct 2026, 10:00").
8. Tidier Users page, Offers list, CV Inbox and Candidate Review.

**One thing to tell the HR team:** interviews and offers can now be created
without a hiring request. Offers still need the HR Director's approval.

---

## Steps

| # | Step | Status |
|---|---|---|
| 6 | Make the system open faster | In progress (review pending) |
| 5 | Fixes from the page-by-page review | Done and approved (PR #44) |
| 4 | Page-by-page review of the whole system | Done (report in `docs/audits/heuristic-2026-09-30.md`) |
| 3 | Layout fixes, quotes editor, direct interview/offer creation | Done and approved (PR #39) |
| 2 | Update the company server | **Waiting — needs someone on the company network** |

### Coming next (in this order)

| # | Step | What you will see |
|---|---|---|
| 7 | Phone view of the dashboard | A short, easy screen on the phone instead of a very long one |
| 8 | Organization chart | Opens neatly fitted to the screen, clear buttons |
| 9 | Notification settings | One simple table: events down the side, who gets told across the top |
| 10 | Roles & permissions | Grouped by area with "select all", instead of one very long list |

---

## Step 6 — Make the system open faster

**What changed:** before, every computer had to prepare the whole system
itself each time someone opened it, which took about six seconds. Now the
server prepares it once, and every computer receives it ready to use.

**Measured:** the first screen appears in **0.4 seconds instead of about 6
seconds** (about 14 times faster). All 21 pages were opened and checked with
no errors.

**Bonus:** the system is also safer. A security setting that had to stay
loose for the old way is now tightened.

**Anything to do on the server?** No extra step. The normal update does it.
