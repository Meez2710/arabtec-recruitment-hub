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
| 9 | Notification settings as one simple table | Done — waiting for approval |
| 8 | Neater organization chart | Done — waiting for approval |
| 7 | Simpler dashboard on phones | Done — waiting for approval (PR #45) |
| 6 | Make the system open faster | Done — waiting for approval (PR #45) |
| 5 | Fixes from the page-by-page review | Done and approved (PR #44) |
| 4 | Page-by-page review of the whole system | Done (report in `docs/audits/heuristic-2026-09-30.md`) |
| 3 | Layout fixes, quotes editor, direct interview/offer creation | Done and approved (PR #39) |
| 2 | Update the company server | **Waiting — needs someone on the company network** |

### Coming next (in this order)

| # | Step | What you will see |
|---|---|---|
| 10 | Roles & permissions | Grouped by area with "select all", instead of one very long list |

---

## Step 9 — Notification settings as one simple table

**What changed:**
- Each section (Hiring requests, Candidates, Interviews, Offers) is now one
  table: the events are listed down the left, and **who gets told** runs
  across the top (Requester, Recruiter, Hiring manager, Approvers, Panel,
  Candidate, Who acted). Tick a box to switch it on. Before, the list of
  people was squeezed into each row and hard to scan.
- The **Candidate** column is shaded amber so it is obvious which alerts
  reach people outside the company.
- On a phone, swipe the table sideways; the event names stay fixed on the
  left.

**Measured:** the page is about **40% shorter** on a computer (3,607 → 2,180
pixels) and fits the screen width with no sideways scrolling. Changing a
tick still saves straight away.

## Step 8 — Neater organization chart

**What changed:**
- The chart opens on **one clear screen**: the company at the top, then Head
  Office and Projects, each with a "Show" button to open it. Before, it
  opened on a random slice of a very wide chart with a large empty area.
- The tools are proper buttons in two groups: **Expand all / Collapse all**,
  and **− 100% + / Fit to screen** (you can now see the zoom level).
- The colour key (Employee, Vacant, Unit / project) is bigger and easier to
  read.
- Searching for a person still works even if they sit inside a closed
  branch: the chart opens the branches above them.

## Step 7 — Simpler dashboard on phones

**What changed (phone only, the computer screen is unchanged):**
- The four headline numbers now sit in a neat 2 × 2 grid. Before, the second
  number was cut off at the edge of the screen.
- "Waiting on your decision" comes first.
- The charts are folded behind one button, **"Show hiring figures"**. One tap
  opens them.
- Each role in the list is two short lines. Tap the role to open it; there is
  no big button under each one any more.
- Empty boxes show one sentence instead of a large picture.

**Measured:** a director's phone dashboard went from about **4½ screens of
scrolling to about 2** (3,704 → 1,666 pixels). A recruiter's went from 2,207 to
1,744 pixels.

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
