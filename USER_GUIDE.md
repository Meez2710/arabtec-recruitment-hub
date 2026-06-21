# Arabtec Recruitment Hub — User Guide

A practical, role-by-role guide to the recruitment system. The core idea: **every hiring need is a ticket, and every ticket is a shared conversation** — like an email thread the whole hiring team works inside, so nobody needs status calls.

---

## Getting started

1. Launch the app (double-click `start.command` on Mac or `start.bat` on Windows, or run `npm start` in `backend/`).
2. Open the address it prints (usually `http://localhost:4000`).
3. Sign in with one of the demo accounts:

| Role | Email | Password |
|------|-------|----------|
| Admin | admin@arabtec.com | Admin@12345 |
| HR Director | hr.director@arabtec.com | Arabtec@123 |
| HR Manager | hr.manager@arabtec.com | Arabtec@123 |
| Recruitment Manager | rec.manager@arabtec.com | Arabtec@123 |
| Recruiter | recruiter@arabtec.com | Arabtec@123 |
| Hiring Manager | hiring.manager@arabtec.com | Arabtec@123 |
| Interviewer | interviewer@arabtec.com | Arabtec@123 |
| Viewer | viewer@arabtec.com | Arabtec@123 |

What you see is filtered by your role — menus, buttons, and salary figures appear only if your permissions allow.

---

## The big picture: a request is a ticket is a conversation

```
Recruitment Requests  →  open a ticket  →  conversation thread + candidate pipeline
   (board of cards)        (one position)      (everyone collaborates in one place)
```

- The **Recruitment Requests** page is a board of ticket **cards** showing only the key info (position, department, location, seats, status, health). Click a card to open it.
- Inside a ticket, the **Conversation** tab is the heart of it: a chronological feed where the team posts messages, attaches files, uploads CVs, and records interview feedback. Approvals and stage changes post themselves automatically.
- The **Candidates** tab is the same candidates as a kanban board if you prefer the pipeline view.

---

## Raising a request (Hiring Manager / HR)

1. Recruitment Requests → **+ New Request**.
2. Fill the simplified form:
   - **Position** (free text), **Justification** (replacement / hiring plan / new hire)
   - **Department**, **Project**, **Location**, **Hiring Manager**
   - **Headcount**, **Priority**, **Target Join Date**
   - **Key Responsibilities**, **Key Requirements**
   - Optionally attach a JD or document (real file upload).
3. Save → the ticket gets an automatic **Req ID** and **Req Date**.
4. **Submit** it → it goes to the **HR Director** for a single approval step.

> The old salary band, employment type, discipline, staff category and grade fields were removed — intake is intentionally lean.

---

## Approving (HR Director)

1. Open the ticket → you'll see the **Approve** / **Reject** buttons in the red header.
2. Approve → the ticket becomes active and a system note ("Request approved by HR Director") posts into the conversation so everyone sees it.
3. Reject → you must give a reason; it's recorded in the thread and the audit log.

---

## Assigning a recruiter (Recruitment Manager)

1. Open an approved ticket → **Assign Recruiter** → pick the owner.
2. A system note posts naming the assigned recruiter, and the ticket moves to sourcing.

---

## Working a ticket (Recruiter) — the conversation

Inside the **Conversation** tab, the composer at the bottom has three modes:

- **Message** — write a note to the team. Press **⌘/Ctrl + Enter** to send. Attach any file with **Attach file**.
- **Post a CV** — enter the candidate's name (+ optional position, employer, experience, match score) and pick the CV file. This **creates the candidate, stores the CV as their résumé, and links them to this request** in one step. The CV appears as a post.
- **Feedback** — (interviewers and recruiters) post structured feedback: pick the candidate, a recommendation, a star rating, and notes.

Every post can be **replied to** (replies nest underneath, keeping each candidate's discussion together). You can edit or delete your own posts.

Moving a candidate through stages (in the **Candidates** tab) auto-posts a progress note into the conversation, so the hiring manager always sees where things stand without asking.

---

## Reviewing candidates & the pipeline

- **Candidates** tab inside a ticket: kanban / list / compact views, with search, stage and recruiter filters.
- Click a candidate card to open the side panel: profile, **résumé view/download**, and the **Interview Assessment**.

### Interview Assessment (from the Arabtec form)

Unlocks once a candidate reaches an interview stage. Two evaluations per candidate:

- **HR / Behavioral** — the Big-Five (Openness, Conscientiousness, Extraversion, Agreeableness, Emotional Stability), scored 1–5.
- **Technical** — Technical Knowledge, Relevant Experience, Problem-Solving, Tools & Software, Planning & Organizing.
- Plus **critical flags**, a **recommendation**, a **fit rating**, and a **justification**.
- A **shared final decision** (proceed / hold / reject / hired) is recorded jointly by the recruiter and technical interviewer.

---

## Offers

When a candidate is ready: **Generate Offer** from their actions menu → set salary and joining date → it runs through approval → send → accept → join. When a candidate **joins**, a seat on the request is filled automatically and the request status updates (partially filled / filled). Salary figures are masked for roles without salary visibility.

---

## Who can do what (quick reference)

| Action | Recruiter | Hiring Manager | Interviewer | Rec. Manager | HR Director | Viewer |
|--------|:---:|:---:|:---:|:---:|:---:|:---:|
| Raise a request | ✓ | ✓ | | | ✓ | |
| Approve a request | | | | | ✓ | |
| Assign recruiter | | | | ✓ | | |
| Post in the ticket thread | ✓ | ✓ | ✓ | ✓ | ✓ | read-only |
| Upload a CV | ✓ | | | ✓ | | |
| Post interview feedback | ✓ | | ✓ | ✓ | | |
| Move candidate stages | ✓ | | | ✓ | | |
| See salary figures | depends on role's salary.view permission |

(Exact rights come from the role configuration in Admin → Roles.)

---

## Tips

- **Relative timestamps** ("3h ago") show on every post; hover for the exact time.
- The **Request details** at the top of a ticket are collapsible — open them when you need the full intake, collapse them to focus on the conversation.
- Everything you do is **audited**. Approvals, rejections, posts, uploads and stage moves are all in Admin → Audit Logs.
