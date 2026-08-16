# Arabtec ATS — UAT plan

For the recruitment team, on the **sidecar** architecture. Synthetic data only until sign-off;
no real candidate CVs in the UAT environment.

Automated coverage already proves the mechanics (34 suites, 48-assertion end-to-end, 218
PostgreSQL assertions). **UAT exists to answer what tests cannot: is this usable, and does it
match how Arabtec actually recruits?** Do not re-test what CI already asserts.

## Setup

- Separate database and `UPLOAD_DIR`. `SEED_DEMO_DATA=false`; create real named accounts.
- One account per role: recruiter, recruitment manager, HR manager, HR director, hiring manager,
  interviewer, viewer, system admin.
- Rotate the bootstrap admin password at first login — the app forces this.
- Confirm `/api/health/parsing` reports `docling-sidecar` before starting.

## Scenarios

| # | Scenario | Who | Pass looks like |
|---|---|---|---|
| 1 | Raise a requisition for a real open role | hiring manager | ticket `REQ-YYYY-NNNNN`, seats match headcount |
| 2 | Approval chain | HR mgr → HR dir | status moves; each approval attributed |
| 3 | Assign a recruiter | recruitment mgr | owner set; recruiter sees it in their queue |
| 4 | Upload a **born-digital** CV | recruiter | fields proposed with evidence, intake PENDING, no candidate yet |
| 5 | Upload a **scanned English** CV | recruiter | banner says text was recovered by OCR; fields carry evidence |
| 6 | Upload a **scanned Arabic** CV | recruiter | Arabic recovered; judge the quality — this is the one to watch |
| 7 | Upload a **junk / unreadable** file | recruiter | explicit refusal; **no candidate created** |
| 8 | Review: accept some fields, reject others | recruiter | only accepted fields on the candidate; rejected stay empty |
| 9 | Re-upload the same person | recruiter | duplicate is blocked and names the matching identifier |
| 10 | Schedule an interview + submit feedback | recruiter, interviewer | panel correct; non-panelist cannot submit |
| 11 | Raise an offer through to acceptance | recruiter → HR | salary hidden from roles without `offer.salary_view` |
| 12 | Salary visibility spot-check | viewer, interviewer | no salary anywhere |
| 13 | Audit trail review | system admin | every action above appears with the right actor |
| 14 | Retention report | HR (with `candidate.privacy`) | overdue list is correct **before** enabling enforcement |

## Judgement calls for the business, not for engineering

- **Arabic OCR quality (6).** Recovery is proven; accuracy on real-world scans is not measured.
  Recruiters must say whether it is good enough to review against.
- **Field coverage (4, 5).** Are the proposed fields the ones recruiters actually want?
- **Duplicate strictness (9).** Exact email/phone/LinkedIn/document-hash blocks; name-only only
  warns. Is that the right line for Arabtec?
- **Retention window (14).** Default 24 months. Legal must confirm before enforcement is enabled.

## Known limitations to state up front

1. **Mixed PDFs** — a PDF with a good text layer will not additionally OCR images embedded in it.
2. **Evidence page numbers** on the sidecar path always read "page 1"; the text is complete.
3. **Throughput** — roughly one document per 6 seconds; bulk uploads queue.
4. **RunPod/Docling Serve is not in use.** Arabic works because the sidecar is the backend.

## Exit criteria

- Scenarios 1–14 pass, or every failure has an owner and a decision.
- Recruiters accept the Arabic OCR quality, or the mitigation is agreed.
- No candidate is ever created without a complete human review.
- No salary leak to a role without the permission.
- Retention window confirmed by legal.
