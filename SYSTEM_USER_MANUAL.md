# Arabtec Recruitment Hub — System User Manual

**Audience:** Recruitment, HR, Hiring Managers, Interviewers, and authorized system administrators  
**Purpose:** Practical operating guide for day-to-day use of the Arabtec Recruitment Hub  
**Status:** Current user-facing guidance; update when workflows or permissions change

---

## 1. What the Recruitment Hub is

Arabtec Recruitment Hub is the centralized workspace for managing the recruitment lifecycle.

The core operating model is:

```text
Hiring Request → Recruitment Workspace → Candidate Pipeline → Interview / Assessment → Offer → Join
```

A hiring request acts as the central workspace. The team can work from the request, follow the conversation, manage candidates, record decisions, and keep recruitment activity visible in one place.

The system is role-aware: what users can view or change depends on their assigned permissions. Salary information and sensitive actions are permission-controlled.

> **Important:** Never share user passwords or credentials inside this manual. Credentials should be distributed separately and securely.

---

## 2. Getting started

### Sign in

1. Open the Recruitment Hub using the company-provided URL.
2. Enter your work email and password.
3. Complete any required password-change step.
4. Confirm that the dashboard and navigation match your role.

If you cannot sign in, contact the system administrator or Recruitment Manager. Do not create duplicate accounts.

### First-time checklist

After your first sign-in:

- Confirm your name and role are correct.
- Review the navigation items available to you.
- Open one active recruitment request to understand the workspace.
- Confirm that you can access only the candidate, salary, and administrative information appropriate to your role.

---

## 3. Roles and responsibilities

| Role | Main responsibility in the system |
|---|---|
| **System Admin** | User, role, configuration, security, and platform administration |
| **HR Director** | Request approval, high-level recruitment oversight, and controlled HR decisions |
| **HR Manager** | HR workflow support and recruitment coordination within assigned permissions |
| **Recruitment Manager** | Recruiter assignment, team oversight, candidate movement, and recruitment operations |
| **Recruiter** | Day-to-day sourcing, candidate management, CV intake, pipeline movement, and communication |
| **Hiring Manager** | Raise hiring requests, review progress, participate in candidate decisions and interviews |
| **Interviewer** | Review assigned candidates and submit interview feedback / assessment |
| **Viewer** | Read-only visibility where permitted |

Exact permissions are controlled by the system role configuration. A user should not assume that another role has the same actions or visibility.

---

## 4. The core workflow

### Step 1 — Raise a hiring request

Used by authorized Hiring Managers / HR users.

1. Open **Recruitment Requests**.
2. Select **New Request**.
3. Complete the core request information:
   - Position
   - Hiring justification
   - Department
   - Project
   - Location
   - Hiring Manager
   - Headcount
   - Priority
   - Target join date
   - Key responsibilities
   - Key requirements
4. Attach supporting documents such as a job description when required.
5. Save and submit the request.

The request receives a system-generated request identifier and enters the approval workflow.

### Step 2 — Approve the request

Used by authorized HR approval roles.

1. Open the submitted request.
2. Review the role, business need, headcount, and requirements.
3. Select **Approve** or **Reject**.
4. When rejecting, provide a clear reason.

Approvals, rejections, and related workflow changes are recorded in the system activity/audit history.

### Step 3 — Assign a recruiter

Used by the Recruitment Manager or another authorized role.

1. Open an approved request.
2. Select **Assign Recruiter**.
3. Select the responsible recruiter.
4. Confirm the assignment.

The assignment becomes part of the request's visible workflow history.

---

## 5. Working inside a recruitment request

A request is the main collaboration workspace for a position.

### Conversation

Use the conversation to keep recruitment context in one place.

You may be able to:

- Post messages to the hiring team.
- Attach files.
- Post candidate / CV information.
- Add interview feedback.
- Reply to existing posts.
- Review system-generated workflow events.

Use the conversation for decisions and context that other team members need to understand later.

### Request details

The request details area contains the core hiring information. Expand it when reviewing requirements; collapse it when you need a cleaner view of the ongoing recruitment conversation.

### Candidates / Pipeline

The candidate area provides the working view of people linked to the request.

Depending on the enabled view, candidates may be displayed as:

- Cards / Kanban
- List / Table
- Compact view

Use filters and search to narrow the working set.

---

## 6. Candidate management

### Add a candidate manually

Use **Add manually** when the candidate information is already known or when you do not need automatic CV extraction.

Typical information includes:

- Candidate name
- Contact details
- Current position / employer
- Experience
- Education
- Skills
- Source / notes where supported
- CV attachment

Save only after reviewing the information.

### Parse a CV with AI

Use **Parse CV** when you want the system to read a CV and prepare structured candidate information.

Current workflow:

```text
Choose CV
   ↓
Parsing starts
   ↓
AI processing continues in the background
   ↓
Review extracted information
   ↓
Confirm / Save
```

The current asynchronous flow is designed so the recruiter does not have to keep the request open while the AI processing is running. A parse may show a status such as **parsing…** and later **ready** for review.

> **AI is assistive, not final authority.** Always review extracted information before saving a candidate.

### What to review in parsed CV information

Pay special attention to:

- Candidate name
- Phone and email
- Current position
- Current company
- Employment history
- Education
- Skills
- Location
- Years of experience
- Any field marked as uncertain, not stated, or requiring review

A value should be treated as missing when it is not supported by the CV, not as an error in the system.

---

## 7. CV Intake and Scan CV Inbox

The Recruitment Hub can support CV intake through manual upload and, when properly configured, an inbox/folder-based intake workflow.

### Manual CV upload

Use **Upload CV** or the equivalent candidate upload action when bringing an individual CV into the system.

### Scan CV Inbox

**Scan CV Inbox depends on a configured source folder/integration.** If the source is not configured, the button may report that the inbox is unavailable instead of finding files.

Do not interpret an unconfigured inbox as a parsing failure.

When the inbox is configured, the intended workflow is:

```text
Recruitment mailbox / shared folder
            ↓
        New CV files
            ↓
       CV Inbox Scanner
            ↓
        AI / CV Parser
            ↓
     Review and candidate creation
```

For the company operating model, the inbox connection should be treated as an integration/configuration responsibility rather than something recruiters should change themselves.

---

## 8. Candidate pipeline

Move candidates through the recruitment stages used by the company configuration.

Typical stages include:

- Sourced
- Screening
- HR Interview
- Technical Interview
- Offer
- Hired

Some deployments may also include waiting, rejected, or other controlled stages.

### Good practice

- Move a candidate only when the recruitment state actually changes.
- Do not use stage movement as a substitute for a conversation note when context is important.
- Record meaningful decisions and feedback where the workflow provides a structured field for them.
- Use disqualification / rejection actions only when the decision is final and authorized.

Stage changes can become part of the request history so stakeholders can understand progression without asking for repeated status updates.

---

## 9. AI shortlist and smart search

The Recruitment Hub can provide AI-assisted candidate discovery tools where enabled.

### Smart / natural-language search

You can describe a requirement in normal language, for example:

> “Quantity surveyors in Riyadh with more than 10 years of experience.”

The system translates the request into the existing talent filters rather than creating a separate candidate database.

**Always review the resulting filters before acting on the results.**

### AI shortlist

The AI shortlist can rank candidates against a hiring request and provide a reason plus requirements the candidate does not evidence.

Use it as a prioritization aid:

```text
AI recommendation → Recruiter review → Candidate decision
```

Do not treat an AI score as an automatic hiring decision.

---

## 10. Interviews and assessments

### Interviews

Use the Interviews area to review scheduled interviews and open the relevant candidate / request context.

Review:

- Candidate
- Position
- Request
- Interview type
- Date / time
- Interviewer / panel
- Feedback status

### Interview assessment

Where enabled, interview assessments may include:

#### HR / Behavioral

- Openness
- Conscientiousness
- Extraversion
- Agreeableness
- Emotional Stability

#### Technical

- Technical Knowledge
- Relevant Experience
- Problem-Solving
- Tools & Software
- Planning & Organizing

The assessment may also include:

- Scores
- Notes
- Critical flags
- Fit rating
- Recommendation
- Final decision

### Assessment best practice

- Score based on evidence from the interview.
- Keep notes professional and job-related.
- Do not enter sensitive personal information that is not relevant to employment.
- Complete assessments promptly after the interview.
- Do not submit another person's decision under your account.

---

## 11. Offers

Where the offer workflow is enabled:

```text
Candidate ready
   ↓
Generate / prepare offer
   ↓
Approval
   ↓
Send
   ↓
Accepted
   ↓
Joined
```

Offer information may include:

- Candidate
- Position
- Salary / package
- Joining date
- Validity
- Approval state
- Offer status

### Salary confidentiality

Salary and package information may be hidden for users without the required permission.

Do not copy salary information into conversations, screenshots, or external documents unless authorized.

### Offer status

Typical lifecycle values include:

- Draft
- Approved
- Sent
- Accepted
- Joined
- Withdrawn

Use the status that reflects the actual state of the offer.

---

## 12. Dashboard — how to use it effectively

The dashboard is an overview, not a replacement for the detailed workflow.

Use it to identify:

- Items requiring attention
- Active recruitment workload
- Important recruitment metrics
- Recent activity
- Requests and candidates needing follow-up

### Recommended user behavior

Start with the item requiring action, then open the relevant request or candidate workspace.

Avoid using the dashboard as a substitute for updating the underlying request, candidate, interview, or offer status.

---

## 13. Common operating rules

### Keep one source of truth

When recruitment activity belongs to a request, keep important context inside that request instead of scattering it across private messages or disconnected files.

### Review AI output

AI-assisted parsing and shortlist results are recommendations or proposed information. Humans remain responsible for the final record and decision.

### Use permissions correctly

Do not attempt to access, export, or share information that your role is not authorized to view.

### Protect candidate data

CVs and candidate records contain personal information. Download, store, and share them only for legitimate recruitment purposes and through approved company channels.

### Keep statuses accurate

A status is operational data. Incorrect statuses create reporting and coordination problems for the entire recruitment team.

---

## 14. Troubleshooting guide

### “CV parsing failed”

1. Check whether the file is readable and not corrupted.
2. Try the parse again once.
3. If the problem repeats, use manual candidate entry and keep the CV attached.
4. Report the CV filename and approximate time of the issue to the administrator.

### “Scan CV Inbox failed / unavailable”

The inbox may not be configured or connected. Confirm with the administrator that the shared inbox/folder integration is active.

Do not repeatedly retry a known unconfigured inbox.

### “I cannot see a button / menu”

The action may be restricted by your role or permission set. Ask the administrator to confirm the intended permission before assuming the feature is missing.

### “A candidate appears twice”

Stop before creating another record. Search the Talent Pool using name, email, phone, or other available identifiers and confirm whether the candidate already exists.

### “The screen looks broken on phone/tablet”

The responsive UI is an active quality area. Report:

- Device model
- Browser
- Screen orientation
- Page/screen name
- What overlaps or becomes unusable
- Screenshot if company policy permits

Do not attempt to work around a serious UI defect by editing system data.

---

## 15. Security and privacy

Users are responsible for protecting recruitment data.

- Never share passwords.
- Never reuse another user's account.
- Lock or sign out of the application when leaving a shared workstation.
- Do not download candidate CVs to unapproved personal storage.
- Do not share candidate information outside authorized recruitment channels.
- Report suspicious access, unexpected permissions, or unusual behavior to the system administrator.

All sensitive recruitment activity should remain traceable through the system's available audit history.

---

## 16. Quick reference by role

### Recruiter

**Daily flow:**

```text
Requests → Candidates → CV intake / Parsing → Pipeline → Interviews → Follow-up
```

Focus on accurate candidate records, timely status updates, and clear communication inside requests.

### Recruitment Manager

**Daily flow:**

```text
Requests → Recruiter assignment → Team workload → Pipeline health → Escalations
```

Focus on workload balance, stalled requests, SLA risk, and recruiter ownership.

### Hiring Manager

**Daily flow:**

```text
My Requests → Candidate progress → Interviews / Feedback → Decision
```

Focus on business need, candidate fit, and timely decisions.

### Interviewer

**Daily flow:**

```text
Assigned interviews → Candidate context → Assessment → Submit feedback
```

Focus on evidence-based, job-related interview feedback.

### HR Director

**Daily flow:**

```text
Approvals → Recruitment overview → Exceptions → Final decisions
```

Focus on approval accuracy, priorities, and organizational visibility.

### Viewer

Focus on monitoring information available to your read-only role. Do not attempt to modify recruitment data.

---

## 17. What is intentionally handled as configuration / future scope

Some capabilities depend on infrastructure or future integrations and should not be treated as broken product functionality when they are not configured.

Examples include:

- Shared CV inbox / folder automation
- Microsoft 365 / Outlook integration
- Calendar synchronization
- Public career page
- Advanced automated notifications
- Future platform-owner / SaaS administration features

The visible UI may contain a placeholder or future-state action for these capabilities. Follow the company rollout guidance rather than attempting to configure external services yourself.

---

## 18. Support information to provide when reporting an issue

A useful support report includes:

1. Your user role.
2. The page / workflow.
3. The action you took.
4. The exact message shown.
5. Approximate time of the issue.
6. Browser and device.
7. Screenshot or screen recording when company policy permits.
8. Candidate / request identifier, when relevant.

Avoid sending CV files or personal candidate data unless the support process explicitly requires it and the transfer is approved.

---

## 19. Final operating principle

The Recruitment Hub is designed to make recruitment work **visible, structured, and shared**.

Use the system as the working record of recruitment activity:

> **Request → Conversation → Candidate → Assessment → Decision → Offer → Join**

Keep information accurate, use AI as an assistant rather than an authority, protect candidate data, and keep the recruitment team working from the same source of truth.
