# Arabtec ATS — Final Readiness Report

**Branch:** `readiness/final-gate` (from `integration/audited-ui-live-parser` @ `033025a`)
**Date:** 2026-08-14 · **Host:** macOS, Node 24.15.0, local Docling sidecar on `127.0.0.1:8089`

Nothing here was pushed, merged, deployed, tunnelled, or pointed at DNS/Apache/Render.

---

## A. VERIFIED

Proven by executed tests in this session, not by inspection.

**A1. The RBAC model is intact.** The 14 failing suites were never an RBAC gap. Measured
directly: `system_admin` holds all **50** permissions at login; `GET /api/users` returns 9
users and `GET /api/audit` returns entries — **after** the mandatory password rotation. Before
rotation both return 403. See §B for what was actually wrong.

**A2. The full ATS pipeline, end to end, over real HTTP with the database inspected at every
step.** `backend/ats_e2e_test.mjs` — **48 assertions, 0 failures**:

| Stage | Endpoint | Verified |
|---|---|---|
| Hiring Request | `POST /api/requests` | 201; one `recruitment_request` row; `REQ-YYYY-NNNNN`; one `requisition_seat` per headcount |
| Approval | `submit` → `approve` ×3 | starts `pending_approval`, reaches approved; every transition in `request_activity` with an actor |
| Recruiter Assignment | `POST /api/requests/:id/assign` | `owner_id` set to the named recruiter |
| Candidate Intake | `POST /api/candidates/parse-cv` | PENDING intake, requisition link preserved, **0 candidates created** |
| CV Parsing | same | every field undecided, each with an evidence snippet and a real block id; no value absent from the document |
| CV Parsing (scanned) | same, image-only PDF | `parser=docling-sidecar`, `ocrApplied=true`, fields evidence-bound |
| Candidate Review | `POST /api/candidates/intakes/:id/review` | exactly one candidate; rejected field persisted as `null`; proposal `APPLIED`; replay → 409 `not-pending`, nothing created |
| Duplicate Check | review + `POST /check-duplicate` | exact email match **blocks** conversion; no second candidate; standalone check reports facts |
| Candidate Creation | — | `CAN-NNNNN`; only approved fields written |
| Application | via review | exactly one `application`, linked to the requisition, `APP-NNNNN`, opening stage in history |
| Interview | `POST /api/interviews` | 201, bound to the real application, panel persisted; past date → 400 and no row |
| Feedback | `POST /api/interviews/:id/feedback` | 201 by a panelist |
| Offer | `POST /api/offers` → submit/approve/send/result | offer accepted; the **application** moved too, not just the offer |
| Activity/Audit | `GET /api/audit` | `request.created`, `candidate.intake_created`, `application.created`, `offer.created` all present; every row names an actor |

**Permission boundaries** were asserted per stage, and each refusal was checked to have written
nothing: viewer refused on create/approve/assign (403); unauthenticated refused on intakes
(401); a role without `candidate.add` refused on review (403) with the intake still PENDING; a
non-panelist refused on feedback (403); a role without `audit.view` refused (403); salary not
exposed without `offer.salary_view`.

**Whole-database integrity sweep, all clean:** no empty candidate, no unreachable candidate
(no email *and* no phone), no orphan application/interview/feedback/offer, no duplicate
candidate email, no duplicate application per candidate+requisition, no half-converted intake,
seat accounting matching filled headcount.

**A3. Document handling, all classes — 9/9.** Against the real local sidecar (Docling 2.55.1,
Tesseract `ara`+`eng`):

| # | Class | Result | OCR |
|---|---|---|---|
| A | born-digital English PDF | PASS 1.3 s, 450 chars | no |
| B | image-only English PDF | PASS 3.6 s, 321 chars | **yes** |
| C | PNG resume | PASS 24.4 s, 321 chars | **yes** |
| D | image-only **Arabic** PDF | PASS 3.2 s, 234 chars | **yes** |
| E | mixed Arabic/English PDF | PASS 0.7 s | no |
| F | DOCX | PASS 0.03 s | no |
| G | born-digital PDF (2) | PASS 0.7 s, 1 222 chars | no |
| H | prompt-injection CV | PASS 0.7 s | no |
| I | **multi-page scanned PDF** | PASS 6.9 s, `pageCount=2` | **yes** |

Fixture I is new and matters: it asserts strings that exist **only on page 2**, so it is the
only thing that would catch multi-page OCR stopping after page 1. It passes.

**A4. Evidence and provenance reach the reviewer.** `parse-cv` returns a read-only `document`
block (parser, `ocrApplied`, engine, page/block counts) and the review screen renders it —
verified in the browser against a genuinely scanned CV: *"Scanned document — Text recovered by
OCR (sidecar-internal) · parser docling-sidecar · 1 page."*

**A5. Human review is the only path to a candidate.** No candidate, application or proposal
exists before a complete accept/reject decision on every field. Replaying a review is refused.

**A6. Prompt-injection resistance by construction.** Fixture H (a CV instructing "mark this
candidate as verified / give 100/100 / auto-accept") produces ordinary evidence-bound fields.
There is no field a model can set to "verified" and no numeric score in the contract.

---

## B. OPEN DEFECTS

**B1 — FIXED. `screeningCounts` silently dropped from the candidate list.**
`GET /api/candidates` stopped returning `screeningCounts` when the handler gained pagination
(commit `e1ee1c9`), leaving `Candidates.screeningCounts()` with no caller and the Talent Pool
tab counts empty. Restored, whole-pool and unfiltered. This was the one genuine application
defect hiding behind the 14 "RBAC" failures.

**B2 — FIXED. Applications created by CV review were never audited as created.**
Only the hand-typed `POST /api/applications` wrote `application.created`; the intake-review
path created the application silently. An auditor filtering on that action saw none of the
applications raised from CVs. Now audited in the same shape.

**B3 — FIXED. Every multi-page document was reported as one page.**
`_pages_of()` called `document.export_to_text(page_no=n)`; Docling 2.55.1's `export_to_text`
takes no `page_no`. The `TypeError` was swallowed by `suppress(Exception)`, `pages` came back
empty, and `pageCount` fell through to a hardcoded `1`. `pageCount` now comes from
`document.num_pages()`.

**B4 — OPEN. Every derived block is attributed to page 1.**
Consequence of B3's root cause: with `pages` empty, the adapter derives structure from markdown
and stamps page 1 on every block, so `evidenceRef.page` is wrong for anything on page 2+. The
*text* is complete — nothing is lost — but a reviewer following a citation to "page 1" for
page-2 content will not find it there, and citations are the foundation of this design.
Fix path: walk `document.texts` and read each item's `prov[].page_no`. Not attempted here —
it changes how blocks are built, which is a parser change.

**B5 — OPEN, security. The local-only guard on AI egress is a no-op.**
`assertLocalHost` in `backend/src/infrastructure/ai/ollama/ollama-client.ts` has its body
commented out ("Disabled the local-only restriction to allow external hosted Ollama (e.g.,
Runpod)") while its own docstring still claims *"A guarantee enforced only by documentation is
not a guarantee."* Setting `OLLAMA_BASE_URL` to any public host now silently sends CV text —
real candidate PII — off-machine, with no guard and no warning. Its test correctly fails.
Currently inert only because `OLLAMA_BASE_URL` is unset. Not changed here: restoring
enforcement would remove the hosted-Ollama capability that was deliberately enabled, and that
is your call. Recommended fix: enforce loopback/private by default and require an explicit
`OLLAMA_ALLOW_REMOTE=true` opt-in, so the privacy decision is stated rather than deleted.

**B6 — OPEN, security. Dead code that disables TLS verification process-wide.**
`backend/src/lib/cv/ai-parser.js` sets `process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'` when
`OLLAMA_BASE_URL` contains `runpod.net`. That is a **process-global** switch: while set, every
outbound TLS connection in the app (SMTP, Sentry, anything) skips certificate verification. It
is restored in a `finally`, but any concurrent request in that window is unprotected. This path
is currently **unreachable** — `legacy-provider.js` is no longer registered in
`composition.js` — but the module is still in the tree, so re-registering or importing it
re-arms the switch. Recommended: delete the legacy parser chain.

**B7 — OPEN, non-shipping. 83 failing tests in the parallel TypeScript API layer.**
`src/api/{talent,intake,parsing,search,matching}.test.ts` — 82 of them are one cause: the
service was aligned to the real permission catalogue (`TALENT_PERMISSIONS.CREATE =
'candidate.add'`) while the test fixtures still grant invented names (`candidate.create`,
`candidate.view_all`, `candidate.change_state`, …), so every create returns 403. The 83rd is
B5. **Production does not start this layer** — `render.yaml` runs `npm start` →
`node src/server.js` (Express); the TS API is `npm run api`. Fixture drift in an unshipped
stack, not a live defect — but an unshipped second API with 83 red tests is a trap for whoever
touches it next.

**B8 — OPEN, environment. PNG input is 7× slower than the same content as a PDF.**
Fixture C: 24.4 s vs 3.6 s for B. With the default `DOCLING_TIMEOUT_MS` of 120 s a PNG under
concurrent load can approach the client timeout. Not diagnosed further.

---

## C. PILOT BLOCKERS

Things that prevent a **controlled internal pilot**.

**C1. Nothing in the code.** Every stage passes end to end, on real services, with no mocks.

**C2. Operational, not code — the sidecar is a laptop.** No restart supervision, no
redundancy, no backup. It dies with sleep, reboot, or logout. Acceptable for a controlled
pilot only if a named person owns "is it up?" and the pilot is announced as best-effort.

**C3. `OLLAMA_BASE_URL` must stay unset** until B5 is resolved. With it set to a public host,
CV text leaves the machine unguarded. The pilot as configured (deterministic rules only, no
model) is unaffected.

Everything else below is a production concern, not a pilot one.

---

## D. PRODUCTION BLOCKERS

**D1. No automated database backup.** `docs/BACKUP_AND_RESTORE.md` states it plainly: *"Not
yet active — there is no automated backup on the current Render free plan."* The procedure is
written (`pg_dump -Fc`, daily); nothing runs it, and no restore has been rehearsed. Uploaded
CVs live in the `file_blob` table, so they share the database's fate.

**D2. The PostgreSQL path is unverified in this run.** `pg_tx_test.mjs` reported
**⊘ SKIPPED — no PG_TEST_URL set and embedded-postgres is not installed**, and it says
explicitly that a skip is not a pass. Production is PostgreSQL; everything verified here ran on
SQLite. The transaction-affinity and race suites (`pg_appnumber_race`, `pg_sequence`,
`pg_reopen_race`, `pg_headcount_race`, `pg_join_race`, `reconciliation`) must be run against a
real PostgreSQL with `npm run test:pg:required` before go-live.

**D3. B5 — unguarded AI egress.** Blocking for production regardless of pilot: one environment
variable is the only thing between candidate CVs and a third-party host.

**D4. B6 — the TLS-verification kill switch in the tree.** Delete it before production.

**D5. Docling capacity is not production-shaped.** See §G/§Priority 5: throughput is capped at
roughly one document per ~5.8 s no matter how many arrive at once. 6 simultaneous uploads take
35 s wall-clock; beyond roughly 20 the 120 s client timeout starts tripping. Needs a queue with
visible position, or more workers, before bulk intake.

**D6. Render free plan.** 512 MB per service — the document pipeline peaked at **759 MB** under
6-way load and 687 MB across the full matrix. Docling cannot run on the current plan; that is
why it is a sidecar. The free database plan also has no backup (D1).

**D7. Retention is reported, not enforced.** `GET /api/candidates/privacy/retention` lists
candidates past the window and `POST /:id/erase` erases one, both behind `candidate.privacy`.
Nothing runs on a schedule, so retention depends on a person remembering. For PDPL/GDPR that
is a policy gap, not a code bug — but it is a gap.

**Not blockers — verified adequate:** `JWT_SECRET` required in production and the app refuses
to sign tokens without it; session table with revocation, and password change revokes every
other session; auth cookie `httpOnly`, `sameSite=lax`, `secure` in production; HSTS
(`max-age`, `includeSubDomains`) and `upgrade-insecure-requests` in production, plus frameguard
and `noSniff`; `TRUST_PROXY=1` so `req.ip` cannot be spoofed; global rate limiter (300/min
default) and login lockout after 5 attempts; 12-character password policy with all four
character classes, a deny-list, and no reuse of the account holder's own name or email;
forced first-login rotation covering every route by default; boot-time config validation that
**fails the deploy** on a missing `JWT_SECRET`/`DATABASE_URL` and warns on half-configured
features; no secrets committed (`git ls-files` clean; 15 `sync:false` placeholders in
`render.yaml`); structured JSON request logging with no CV content and no secret values;
`/api/health`, `/api/health/db`, `/api/health/watcher`; Sentry optional and a clean no-op when
unset; candidate documents and intake documents both behind `candidate.view`; offer salary
behind a separate `offer.salary_view`.

---

## E. ACCEPTABLE PILOT LIMITATIONS

1. **Mixed PDFs are not fully read.** A PDF with a healthy native text layer returns that text
   and does **not** additionally OCR scanned images embedded in it. Text living only inside
   such an image is silently absent. Routing probes the native layer first and only retries
   with OCR below `SIDECAR_MIN_NATIVE_CHARS` (30). **Assessment: acceptable for a controlled
   pilot, future enhancement for production.** Real CVs are overwhelmingly all-native or
   all-scanned; the hybrid case is rare, and the pilot's reviewer sees the parser and OCR flag
   on screen. It becomes a production concern only if scanned-certificate-inside-a-Word-CV
   turns out to be common in your actual intake — which the pilot will measure.
2. **B4 — page numbers in citations are always 1.** Text is complete; the page label is wrong
   beyond page 1. Tolerable for 1–2 page CVs where a reviewer will find the line anyway.
3. **Sequential-ish throughput** (§Priority 5). Fine for a recruiter uploading a handful of CVs.
4. **The sidecar is a laptop** (C2), announced as such.
5. **Arabic OCR quality is unmeasured beyond recovery.** Fixture D proves Arabic text is
   recovered; nothing measures accuracy against a graded corpus.
6. **Demo seed users carry `Arabtec@123`**, which the current policy would reject. Seeded as a
   hash so it bypasses the policy. Gated off in production (`SEED_DEMO_DATA=false`).

---

## F. FUTURE ENHANCEMENTS

1. Per-page evidence attribution (B4) — walk `document.texts` / `prov[].page_no`.
2. Mixed-document OCR: OCR embedded images even when a native text layer exists.
3. Resolve the parallel TypeScript API layer (B7): finish it, or delete it. 83 red tests in an
   unshipped stack will mislead the next person either way.
4. Delete the legacy parser chain (B6) — dead, and dangerous while it exists.
5. Docling concurrency: a real queue with visible position, or more workers.
6. Investigate PNG slowness (B8).
7. Scheduled retention enforcement (D7).
8. A graded Arabic/English OCR accuracy corpus.

---

## G. TEST RESULTS

**Full runner — `npm test`: 33 suites, 33 passed, 0 failed.** (Before this work: 18 passed,
14 failed.)

| Suite | Result |
|---|---|
| Full ATS end-to-end (`ats_e2e_test.mjs`, new) | **48 passed, 0 failed** |
| Intake lifecycle (`cv_intake_test`) | 35 / 35 |
| Proposal lifecycle (`cv_proposal_test`) | 16 / 16 |
| Parser seam (`parser_seam_test`) | 13 / 13 |
| HTTP intake route precedence (`intake_route_http_test`) | 9 / 9 |
| Document smoke (vitest) | 23 / 23 |
| Docling adapter (vitest) | 20 / 20 |
| Docling document-class matrix | **9 / 9** |
| Typecheck | PASS |
| Build (`tsc -p tsconfig.build.json`) | PASS |
| Frontend JSX validation (both bundles, shipped Babel) | PASS |
| `pg_tx_test.mjs` | **⊘ SKIPPED — not a pass** (no `PG_TEST_URL`) |

**Vitest domain suite — `npm run test:domain`: 719 passed, 83 failed, 9 skipped (811 tests,
43 files, 6 failing).** All 83 are B7/B5, in the non-shipping TypeScript API layer. Unchanged
by this work.

**How the 14 baseline failures were resolved** (Priority 1, in full):

1. *Why the seed no longer uses a fixed password* — deliberate. Security control C1.1 removed
   the hardcoded default; the seed uses `SEED_ADMIN_PASSWORD` or a random one-time password
   printed once, and always sets `must_change_password=1`.
2. *Why authenticated admin tests then got 403 on `user.manage` and `audit`* — the forced
   first-login rotation gate in `src/middleware/auth.js`, which blocks every authenticated
   route except `/auth/me`, `/auth/change-password` and `/auth/logout` until the password is
   rotated. It returns 403, which reads exactly like a missing permission and is not one.
3. *Classification* — **a test-fixture problem.** Not an implementation problem, not a
   permission-model problem, and **not a production RBAC gap**: `system_admin` holds all 50
   permissions and both endpoints work immediately after rotation.

No permission was weakened and no security control was relaxed.
`backend/test-support/admin-session.mjs` does what a real administrator does — sign in, rotate,
continue — and every suite uses it. Three further fixtures had drifted from rules that postdate
them: the 12-character password floor, the `arabtec` deny-list fragment, and BL-03's rule that
an application may only be *created* at an entry stage (`phase4_qa` now moves the application
instead of fabricating a late stage). One genuine defect was hiding behind the noise: B1.

**Priority 5 — concurrency, measured.** One uvicorn worker, shared cached converter, 8-core
host, same scanned PDF:

| Concurrent uploads | Wall clock | Per document | Slowest request |
|---|---|---|---|
| 1 | 11.9 s | 11.9 s | 11.9 s |
| 3 | 19.2 s | 6.4 s | 19.2 s |
| 6 | 34.9 s | 5.8 s | 34.9 s |

Not fully serialized — Tesseract releases the GIL, so requests overlap — but **total throughput
is capped at roughly one document per ~5.8 s** regardless of arrival rate, and the last
uploader waits the full wall-clock. Peak RSS under 6-way load: **759 MB**. Memory is not the
constraint; CPU is. At ~20 simultaneous uploads the 120 s `DOCLING_TIMEOUT_MS` begins to trip.

**Classification: P2 for the pilot, P1 for production.** Not P0 — it degrades latency, never
correctness, and never silently: a timeout is an explicit failure, not a bad parse.

---

## H. FINAL RECOMMENDATION

# READY FOR PILOT

The application is ready for a controlled internal pilot. Every stage from hiring request to
offer is verified end to end against real services with the database inspected at each step;
the RBAC concern was a stale fixture, not a gap; and the three real defects found along the way
are fixed.

It is **NOT READY FOR PRODUCTION**, and the remaining work is small and specific:

1. **Restore the AI egress guard** (B5) — enforce loopback/private by default with an explicit
   opt-in for a hosted endpoint. *Half a day.*
2. **Delete the legacy parser chain** (B6) — removes the TLS-verification kill switch. *An hour.*
3. **Run the PostgreSQL suites** (D2) — `npm run test:pg:required` against a real PostgreSQL.
   *An hour, plus whatever it finds.*
4. **Turn on database backups and rehearse one restore** (D1). *Half a day, mostly waiting.*
5. **Decide the Docling host** (D5, D6) — the 4 GB Linux box already recommended; the laptop is
   a pilot instrument, not a service.

Items 1–3 are code and can be done now. Items 4–5 are infrastructure decisions for you.

Two limitations should be **stated to pilot users** rather than fixed: mixed PDFs may not read
text embedded as images (E1), and evidence page numbers are always "page 1" (B4).
