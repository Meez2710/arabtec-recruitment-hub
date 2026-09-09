# Approved ATS UI and on-prem release implementation plan

> For agentic workers: use superpowers:subagent-driven-development for delegated work, with focused review before release.

**Goal:** Complete the user's approved design handoff in the existing ATS and prepare a verifiable on-prem release.
**Architecture:** Retain runtime React/Babel frontend and Express API. Extend existing mail provider/settings rather than adding a second ingestion pipeline. Production remains the existing systemd/PostgreSQL installation.
**Tech Stack:** React, plain CSS, Express, Node, PostgreSQL/SQLite, nodemailer, delegated Graph.
**Spec:** User-attached design handoff README and HTML references, located outside this repository at ../reference/design_handoff_ats_ui_review/.

## Global Constraints
- Preserve recruitment data, API permissions, workflow rules, branding controls, and login appearance.
- No bundler, component library, CSS framework, or new styling approach.
- Reuse existing Icon, Empty, PageHead, Modal, Table, Skeleton components.
- No new !important; shared fixes before page-specific changes.
- Default controls 40px, compact 32px, mobile minimum 44px; controls radius 8px, surfaces 12px.
- Do not publish design prototypes in frontend/public.
- Do not run migration/reset scripts against production data.
- Never expose mail credentials in response or audit data.

### Task 1: Approved frontend completion
**Files:** frontend/public/app.jsx, intake-review.jsx, claude-system.css, arabtec-design-system.css, arabtec-approved-ui.css, styles.css, index.html; focused UI test(s) in backend.
- [ ] Verify handoff findings against current files, including the already-merged P0 fixes.
- [ ] Complete P1 shared controls/icons/empty states/toolbars/table density/retry/mobile navigation and both pipeline contexts using the supplied prototypes.
- [ ] Complete applicable P2 polish and P3 only where computed before/after checks prove safety.
- [ ] Preserve stage aliases by displaying a residual label when an underlying status is more specific than its board column; never lose status information.
- [ ] Keep Projects/Sites/Departments permission semantics as currently implemented.
- [ ] Guard unsaved Roles edits on internal navigation as well as full page exit.
- [ ] Use existing UI compilation/readiness gates and add behavioral checks for changed navigation/pipeline rules; verify desktop/tablet/mobile layout.
- [ ] Commit frontend changes with a concise implementation/verification report. Do not modify mail backend or deployment scripts.

### Task 2: Email settings backed by real transport
**Files:** backend/src/lib/mail-settings.js (new), backend/src/routes/settings.js, backend/src/lib/mailer.js, frontend/public/email-settings.jsx (new), frontend/public/index.html, frontend/public/app.jsx integration after Task 1.
- [ ] Add GET/PUT /api/settings/email and POST /api/settings/email/test protected by system.manage; retain existing status/verify/test compatibility.
- [ ] Store SMTP credentials encrypted; omit them from GET and generic settings/audit payloads. Omitted password retains existing credential; failed tests save nothing.
- [ ] Preserve dry-run priority and delegated Microsoft mailbox integration, including reviewed CV intake and token lifecycle.
- [ ] Implement approved Email & Mailbox form with actual connection state, explicit Replace, draft test, Save, Microsoft connection link, and actionable errors.
- [ ] Test RBAC, secret redaction, preservation, dry-run and transport selection using isolated databases/fake transport; no live emails.

### Task 3: Release and on-prem verification
**Files:** deploy/on-prem release script/docs, focused deployment tests, docs release record.
- [ ] Prepare a pinned-ref redeploy procedure that backs up existing data, builds, restarts before verifying, checks deployed commit/assets, and preserves environment settings.
- [ ] Run relevant regression suites, build, typecheck, UI compile, and browser checks where available.
- [ ] Review complete diff, publish a reviewable branch/PR. Do not claim on-prem deployment without a reachable server and runtime verification.
- [ ] Server access probe already failed: ssh ats@10.20.0.9 reports Network is unreachable. Supply exact final release command for execution from the company network if access stays unavailable.
