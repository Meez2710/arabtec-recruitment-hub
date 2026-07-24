# ATS UI Enhancement Brief

## Scope

This branch is for Phase 1 UI enhancement of the Arabtec ATS / Recruitment Hub.

The goal is to improve the frontend user experience and cover the ATS UI review gaps without introducing risky backend/integration work in this phase.

## Confirmed Repo

Project root:
`/Users/moutazadly/Downloads/arabtec-recruitment-hub`

GitHub remote:
`https://github.com/Meez2710/arabtec-recruitment-hub.git`

Feature branch:
`feature/ats-ui-enhancement-phase-1`

## Primary References

Use these references:

1. The actual codebase as the implementation source of truth.
2. `docs/ui-review/ATS_UI_Full_Review.pdf`
3. `docs/ui-review/claude-fable-enhanced-v2.html`
4. `frontend/public/bgats.png`
5. This brief.

Do not treat static HTML mockups as production code to copy blindly. Use them as visual/reference material only.

## Global Design Rules

- Keep the UI corporate, clean, and enterprise-grade.
- Use Arabtec brand feel without making the UI too heavy.
- Do not overuse red.
- Red should be reserved for:
  - critical warnings
  - overdue states
  - destructive actions
  - rejection/disqualification
- Use neutral, slate, grey, blue, and soft accent colors for normal UI states.
- Keep spacing, alignment, and typography consistent.
- Avoid breaking existing backend-dependent functionality.
- Prefer small, page-by-page changes.
- Do not rewrite the whole app unless explicitly approved.
- Do not introduce new paid services or external integrations in Phase 1.
- If a feature needs backend support, label it clearly as:
  `UI ready — backend endpoint required`
  or:
  `Phase 2 integration`

## Request ID Standard

Replace long request IDs such as:
`REQ-2026-00001`

with short IDs such as:
`R-2601`

Use short request IDs consistently across:

- Dashboard
- Hiring Requests
- Ticket Workspace
- Conversation
- Pipeline
- Talent Pool
- Interviews
- Offer Letters
- Offers List
- Activity logs
- Summary

Example IDs:

- `R-2601`
- `R-2602`
- `R-2603`
- `R-2604`

## Page-by-Page Requirements

### 1. Login Page

Use:
`frontend/public/bgats.png`
as the main left-side visual/background.

Replace generic black/empty left panel styling with the provided Arabtec ATS visual.

Preferred headline:
`Hiring, smarter than ever.`

Avoid repeating the full Arabtec wordmark if it already appears in the background image. Add only a subtle ATS or ATS Platform label if needed.

Login page should include:

- Sign in title
- Work Email
- Password
- Remember me
- Forgot password
- Sign in button
- Security/rate-limit note
- Clean enterprise styling

### 2. Dashboard

Improve dashboard layout and charts.

Requirements:

- KPI cards
- My Tasks widget
- Hiring Funnel
- Recruiter Load
- Recent Updates
- Notification bell
- User menu
- Search if already supported
- Funnel bars must align from the same left x-position
- Funnel labels should use a fixed label column
- Numbers should align cleanly
- Avoid using red as normal chart color
- Use red only for warnings/critical/overdue

### 3. Hiring Requests

Requirements:

- Search
- Quick filters
- Status filter
- View toggle:
  - Table
  - Cards
  - Compact
- Columns:
  - Request
  - Position
  - Department
  - Location
  - Status
  - Priority
  - Candidates
  - Age / SLA
  - Owner / Recruiter
- Rows should look clickable
- Do not add bulk actions here in Phase 1; bulk actions belong in Pipeline

### 4. Ticket Workspace

Requirements:

- Short request ID
- Position title
- Location
- Status
- Priority
- Hiring Manager
- Recruiter
- SLA / Days open
- Actions:
  - Add Candidate
  - Change Status
  - Assign Recruiter
  - Edit
  - Close
- Tabs:
  - Pipeline
  - Conversation
  - Details
  - Activity

### 5. Conversation Thread

Requirements:

- Messages
- File attachment chips
- System event message style
- Mention styling such as `@Nadia Fouad`
- Composer with:
  - Text area
  - Attachment icon
  - Mention affordance
  - Send button

If notifications for mentions are not implemented, mark as:
`UI ready — notification backend required`

### 6. Candidate Pipeline / Kanban

Requirements:

- Columns:
  - Sourced
  - Screening
  - HR Interview
  - Technical Interview
  - Offer
  - Hired
- Candidate cards
- Move forward action
- Disqualify action
- Bulk selection UI
- Active/disqualified summary
- Stage-aging indicator
- List/Compact view toggle
- No drag-and-drop requirement in Phase 1
- Movement can be via button/dropdown

### 7. Talent Pool

Requirements:

- Search by name/company
- Advanced filters:
  - Source
  - Location
  - Experience
  - Skills / Trade
  - Availability
- Buttons:
  - Upload CV
  - Scan CV Inbox
  - Parse CV
  - Add Candidate
  - Connect Outlook
- Duplicate detection badge/callout
- Parser status examples:
  - Parsed
  - Needs Review
  - Duplicate Detected
  - Failed
- Candidate drawer/modal tabs:
  - Overview
  - CV
  - Applications
  - Interviews
  - Offers
  - Notes

Do not implement expensive AI parsing in Phase 1. Use UI placeholders only where backend is missing.

### 8. Interviews

Requirements:

- Scheduled interviews table
- Columns:
  - Candidate
  - Position
  - Request ID
  - Type
  - Date/Time
  - Panel
  - Lead Interviewer
  - Status
  - Feedback action
  - Assessment action

Phase 2 labels:

- Outlook Calendar sync
- Candidate self-scheduling

### 9. Interview Assessment Form

This is a key missing feature.

Build a frontend assessment form UI if not already present.

Requirements:

- Candidate info header
- Step indicator:
  - Candidate Info
  - HR Behavioral
  - Technical
  - Critical Flags
  - Recommendation
- HR Big Five:
  - Openness
  - Conscientiousness
  - Extraversion
  - Agreeableness
  - Emotional Stability
- Technical criteria:
  - Technical Knowledge
  - Relevant Experience
  - Problem-Solving
  - Tools & Software
  - Planning & Organizing
- Each criterion:
  - Score selector 1–5
  - Notes input
- Auto-calculated:
  - HR average
  - Technical average
  - Overall score
  - Fit label:
    - Strong
    - Acceptable
    - Borderline
    - Weak
- Critical Flags checkboxes
- Final Recommendation:
  - Proceed
  - Proceed with Conditions
  - Hold
  - CV Pool
  - Reject
- Actions:
  - Save Draft
  - Submit Assessment
  - Print Preview

If save/submit endpoints are not available, mark as:
`UI ready — backend endpoint required`

### 10. Offer Letter Preview

Requirements:

- Corporate offer letter preview
- Candidate name
- Position
- Basic salary
- Allowances
- Total package
- Joining date / expected start date
- Validity period
- Signature area
- Preview / Print
- Send Offer
- Salary permission note

If allowances are not supported by backend, mark as:
`Backend DB column needed`

Phase 2:

- E-signature

### 11. Offers List

Required lifecycle statuses:

- Draft
- Approved
- Sent
- Accepted
- Joined
- Withdrawn

Columns:

- Offer ID
- Candidate
- Position
- Request ID
- Salary / Package
- Status
- Valid Until
- Actions

Actions:

- Preview Letter
- Send
- Mark Accepted
- Mark Joined
- Withdraw

Salary visibility should be permission-gated if supported.

## Assessment and Offer Review Rules

### Assessment Form Review Rule

The Assessment UI is important and must be reviewed by the user before it is considered final.

The assessment should support evaluation/review by the appropriate role, especially:

- HR evaluator
- Hiring Manager
- Technical interviewer if applicable

The UI should make clear:

- who is evaluating
- what section they are evaluating
- candidate information
- position and request ID
- scores
- notes
- recommendation
- draft/submitted status

Do not invent a new assessment workflow if backend already supports one. Enhance the existing UI and preserve backend compatibility.

If extra workflow is needed, label it as:
`Requires backend support`

Before any Assessment implementation is committed or pushed, stop and request user review.

### Offer Letter Template Rule

The Offer Letter UI must use the existing company offer template as the source of truth.

Do not invent legal, HR, salary, or employment wording.

The offer preview may improve layout and readability, but it must preserve the company-approved template structure and wording unless the user explicitly approves changes.

If the existing company offer template is stored in the repo, inspect and use it.

If it is not found, report that it is missing and ask the user to provide it before finalizing the Offer Letter UI.

Any changes to offer wording, salary display, allowances, joining date, validity, signatures, or approval flow must be reviewed by the user before commit/push.

Before any Offers or Offer Letter implementation is committed or pushed, stop and request user review.

### Publishing / Commit Rule for Sensitive HR Pages

The following areas require explicit user review before finalizing:

- Assessment Form
- Final Recommendation
- Offer Letter Preview
- Offers List
- Salary / Package display
- Hiring Manager assessment/review flow

Claude must not publish, push, or treat these pages as final without explicit user approval.

### 12. Summary Page

Create or update executive summary UI with:

Columns:

- Feature Area
- Phase 1 UI Status
- Backend Status
- Decision
- Notes

Use statuses such as:

- Complete
- UI Added
- API Only
- Ready / Needs Config
- Deferred Phase 2
- Not Built

## Future Integrations / Deferred Scope

The following are required for the product roadmap but should NOT be fully implemented during Phase 1 UI enhancement unless explicitly approved.

### Phase 2: Outlook / Microsoft 365 Integration

Required later:

- Microsoft Graph OAuth connection
- Recruitment mailbox or shared mailbox support
- Read inbound recruitment emails
- Extract CV attachments
- Link email threads to candidates and hiring requests
- Optional calendar integration for interviews
- Clear connection state in UI

During Phase 1:

- UI may show `Connect Outlook` or `Email sync` actions only as placeholders.
- Mark them clearly as `Phase 2` or `Requires Microsoft 365 setup`.
- Do not imply active sync if backend is not implemented.

### Phase 2: CV Inbox / File Storage

Required later:

- Central CV intake folder/storage
- Manual CV upload
- Email attachment intake
- Career page submission intake
- Processed/failed CV queues
- File validation and review status

During Phase 1:

- Talent Pool may include `Upload CV`, `Scan CV Inbox`, and `Parse CV` controls.
- Use labels such as `Requires integration` if backend is not ready.

### Phase 2: Public Career Page

Required later:

- Public careers listing
- Job detail page
- Apply form with CV upload
- Candidate consent checkbox
- Source tracking
- File validation and rate limiting

During Phase 1:

- Do not build full public careers workflow unless explicitly approved.
- Mention it in Summary as Deferred Phase 2.

### Phase 3: High-Quality CV Parsing

Required later:

- Robust text extraction from PDF/DOC/DOCX
- OCR support for scanned PDFs
- AI structured parsing
- Confidence score
- Duplicate detection
- Human review queue
- Job-fit matching
- Failed parsing workflow

During Phase 1:

- Do not build expensive AI parsing.
- UI may show parser status fields:
  - Parsed
  - Needs Review
  - Duplicate Detected
  - Failed
- Use `Parser confidence` visually if sample data is needed.
- Do not claim production-grade parsing is complete.

## Calendar Integration Rule

Calendar integration is not required in Phase 1.

It is also not mandatory for Phase 2 or Phase 3 unless explicitly requested later.

For now:

- Keep scheduling manual or existing-backend based.
- UI may mention `Calendar sync — optional future integration`.
- Do not implement Outlook Calendar, Google Calendar, or Microsoft Graph calendar integration in this phase.
- Do not add OAuth/calendar permissions unless explicitly approved later.

Calendar integration may be considered in a future optional phase only if it becomes necessary.

## Platform Control Room / Owner Console

Original product intent:

This ATS was originally designed as a standalone platform/service that could support multiple companies. Arabtec is the first real pilot tenant/use case. Therefore, the product should preserve a platform-owner layer separate from the company ATS workspace.

### Purpose

The Platform Control Room is intended for the platform owner/super admin only. It should not be visible to normal company users unless they have explicit platform-level permissions.

It should support future SaaS/product operations such as tenant management, integrations, usage monitoring, CV parsing monitoring, support tools, feature flags, billing readiness, and system health.

### Phase 1 Rule

Do not build or expand the full Control Room during the Phase 1 ATS UI enhancement unless explicitly approved.

During Phase 1:

- Inspect whether any Control Room / admin / owner console already exists.
- Report where it is implemented and how it is protected.
- Ensure it is not exposed to normal users by accident.
- If visible in navigation, label it clearly as platform-owner only.
- Mention it in Summary as:
  `Platform Control Room — Partial / Needs hardening`
- Do not add risky backend permissions or tenant access behavior in Phase 1.

### Recommended Future Sections

The future Platform Control Room may include:

- Overview
- Tenants / Companies
- Users & Roles
- Usage & Limits
- Integrations
- CV Parsing Monitor
- Career Pages
- Feature Flags
- Audit Logs
- Support Tools
- Billing / Plans
- System Health

### Future Roles

Recommended roles:

- Platform Owner
- Platform Admin
- Company Admin
- HR Manager
- Recruiter
- Hiring Manager
- Interviewer
- Viewer

Platform roles must be separated from company roles.

### Security Requirements

Future implementation must include:

- Strict role-based access control
- Tenant isolation
- Audit logs for all sensitive actions
- Salary/CV access restrictions
- No hidden backdoor behavior
- Confirmation for destructive actions
- No impersonation unless explicitly designed with audit trails
- No exposure of platform tools to company users

### SaaS/Billing Visibility Rule

Arabtec users must experience the product as the Arabtec Recruitment Hub / Arabtec ATS workspace, not as a generic SaaS product.

Do not expose SaaS/platform commercial concepts to normal Arabtec company users.

The following must be hidden from normal company users unless they have explicit platform-level permissions:

- Subscriptions
- Plans
- Billing
- Invoices
- Payment methods
- Pricing
- Trial status
- Upgrade prompts
- Tenant billing
- SaaS package limits
- Platform-wide company management
- Owner Console
- Platform Admin tools
- Cross-tenant usage metrics
- Commercial feature limits

Company Admin is not the same as Platform Admin.

A Company Admin may manage Arabtec-side settings and users if supported, but must not see platform-owner or SaaS commercial screens.

Any billing/subscription/plan UI belongs only inside the future Platform Control Room and must be protected by platform-level roles.

During Phase 1:

- Do not add billing/subscription UI to the Arabtec workspace.
- Do not add upgrade prompts.
- Do not expose plan limits.
- Do not show SaaS wording to normal users.
- If any existing SaaS/billing UI is found in navigation, report it and recommend hiding it from company users.

### Relationship to Other Deferred Features

The Control Room should eventually manage:

- Microsoft 365 / Outlook integration setup per tenant
- CV inbox/storage setup per tenant
- Career page configuration per tenant
- AI CV parsing credits and monitoring
- Feature flags per tenant
- Billing/subscription readiness

## Implementation Rules

- Inspect the real app structure before editing.
- Implement one page/area at a time.
- After each implementation pass, report:
  - Files changed
  - What changed
  - Which audit notes were covered
  - Any backend gaps
  - Current git status
- Do not commit unless explicitly instructed.
- Do not push unless explicitly instructed.
- Avoid broad rewrites.
- Avoid unrelated changes.
- Keep the app buildable.
