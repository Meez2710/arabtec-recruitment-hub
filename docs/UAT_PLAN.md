# Arabtec ATS — UAT plan

**For:** the recruitment team, on the production **sidecar** architecture.
**Data:** synthetic only until sign-off. No real candidate CVs in the UAT environment.

Automated coverage already proves the mechanics — 34 suites, a 48-assertion end-to-end walk of
the whole pipeline, and 218 PostgreSQL assertions. **UAT exists to answer what tests cannot: is
this usable, and does it match how Arabtec actually recruits?** Do not re-test what CI asserts.

## Setup

- Separate database and `UPLOAD_DIR`. `SEED_DEMO_DATA=false` — create real named accounts.
- One account per role: recruiter, recruitment manager, HR manager, HR director, hiring manager,
  interviewer, viewer, system administrator.
- Rotate the bootstrap administrator password at first login. The application forces this: until
  it is done, every route except `/auth/me`, `/auth/change-password` and `/auth/logout` returns
  403. That is expected behaviour, not a fault.
- Confirm `/api/health/parsing` reports `docling-sidecar` before starting. If it reports
  `local-pdfjs-mammoth`, scanned CVs will be refused and scenarios 6–8 cannot be judged.

## The 14 scenarios

| # | Scenario | Who | Pass looks like |
|---|---|---|---|
| 1 | **Login and session** — sign in, refresh the page, sign out; try a wrong password five times | every role | session survives refresh; sign-out ends it; the fifth failure locks the account for 15 minutes |
| 2 | **Permissions** — each role opens the app and attempts what they should not | every role | no salary for roles without `offer.salary_view`; no user management for non-admins; no audit for roles without `audit.view`; buttons a role cannot use are not shown |
| 3 | **Raise a hiring request** for a genuinely open role | hiring manager | ticket `REQ-YYYY-NNNNN`; seats created to match headcount; the form asks for what Arabtec actually needs |
| 4 | **Approval chain** | HR manager → HR director | status advances; each approval attributed to the right person; a rejection is possible and recorded |
| 5 | **Recruiter assignment** | recruitment manager | owner set; the recruiter sees it in their queue |
| 6 | **Candidate intake — born-digital CV** | recruiter | fields proposed with evidence you can click back to; intake **PENDING**; no candidate created yet |
| 7 | **Scanned English CV** | recruiter | banner states the text was recovered by OCR; fields carry evidence; values match the document |
| 8 | **Scanned Arabic CV** | recruiter | Arabic text recovered. **Judge the quality — this is the scenario to watch** |
| 9 | **Unreadable / junk file** | recruiter | explicit refusal with a reason; **no candidate created**; nothing left half-done |
| 10 | **Review** — accept some fields, reject others, then submit | recruiter | only accepted fields reach the candidate; rejected ones stay empty; a repeated submit is refused |
| 11 | **Duplicate** — upload the same person again | recruiter | blocked, and the message names the matching identifier (email/phone/LinkedIn/document) |
| 12 | **Application → interview → feedback** | recruiter, interviewer | application linked to the requisition; panel correct; a non-panelist cannot submit feedback |
| 13 | **Offer** — raise, approve, send, record acceptance | recruiter → HR | salary hidden from roles without permission; the application advances when the offer is accepted; the seat is consumed |
| 14 | **Audit and reporting** | system administrator | every action above appears with the right actor and timestamp; dashboards and the retention report show sane numbers |

## Judgement calls for the business, not for engineering

These are the decisions UAT exists to make. Engineering has no view on them.

- **Arabic OCR quality (8).** Recovery is proven; accuracy on real-world scans is not measured.
  Recruiters must say whether it is good enough to review against.
- **Field coverage (6, 7).** Are the proposed fields the ones recruiters actually want, and is
  anything important missing?
- **Duplicate strictness (11).** Exact email / phone / LinkedIn / document-hash blocks; a
  name-only match only warns. Is that the right line for Arabtec?
- **Approval chain shape (4).** Does it match the real delegation of authority?
- **Retention window (14).** Default 24 months. **Legal must confirm before enforcement is
  enabled** — erasure is irreversible.

## Known limitations — state these before UAT starts

1. **Mixed PDFs** — a PDF with a healthy text layer will not additionally OCR images embedded in
   it. Text living only inside such an image will be missing.
2. **Evidence page numbers** read "page 1" for every citation on this backend. The text is
   complete; only the page label is wrong beyond page 1.
3. **Throughput** — roughly one document per 6 seconds. Bulk uploads queue; the last uploader
   waits for all of them.
4. **RunPod / Docling Serve is not in use.** Arabic works because the sidecar is the backend.

## Recording results

For each scenario: pass / fail / pass-with-comment, the tester, the date, and for a failure the
exact steps and what was expected. Attach nothing containing real personal data.

## Exit criteria

- Scenarios 1–14 pass, or every failure has a named owner and an agreed decision.
- Recruiters accept the Arabic OCR quality (8), or a mitigation is agreed.
- **No candidate is ever created without a complete human review** (6, 9, 10).
- **No salary is visible to a role without the permission** (2, 13).
- The retention window is confirmed by legal (14).
- The approval chain matches the real delegation of authority (4).
