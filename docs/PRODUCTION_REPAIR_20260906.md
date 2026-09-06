# Production repair implementation — 6 September 2026

Base: `38ae03eafc214af49d5efa258c00d266c65f86aa`.
Branch: `fix/production-readiness-20260904`.
This implements the supplied audit. It is not a second general audit.

## Changes

| Audit item | Implementation |
| --- | --- |
| SEC-01 | Failed schema, flags or boot seed keep APIs closed; `/api/health/ready` returns 503 until initialization succeeds. Render and on-prem verification use strict readiness. |
| SEC-02 | Multipart upload retains at most 20 MB including framing, bounds headers/parts, drains oversized requests, and reports durable database storage failures. |
| SEC-03 | Parse jobs require an owner, enforce ownership on polling, expire after 15 minutes from creation, cap retention at 1,000, and cannot be resurrected by late completion. |
| SEC-04 | Decoded/canonical static paths checked for GET and HEAD; non-shell HTML and malformed paths rejected. |
| SEC-05 | Watcher/parser diagnostics require `system.manage`; public database errors are generic. |
| ING-01/02/03 | Zero disables the watcher. Manual and automatic scans share one process queue, snapshot/hash deduplication, transactional candidate/document/blob writes, and durable download keys. Automatic imports and optional request linking remain. |
| AI-01 | `anyhelp` is connected to `/api/ai/chat` using the installed Anthropic SDK. Read-only tools retrieve bounded request/candidate projections under existing permissions. Drafting, English/Arabic questions, cancellation, reset, bounded history, per-user concurrency/rate limits and safe errors are wired. |
| UI-01 | Labelled view-switch buttons size to content instead of fixed icon squares; mobile touch targets retained. Chat supports stop/reset/retry via restored draft. No global text-selection suppression or brand change. |
| OPS-01 | Deploy accepts branch/tag/full or short SHA, rejects ambiguous refs and dirty trees before checkout, and supports a code-only rollback. Verification follows restart. |
| QA-01 | Derived experience now passes deterministic and graduation cross-validation. Obsolete permission/model-only test expectations updated to the established production contracts with negative coverage retained. Unused Ollama files are unchanged. |
| DEP-01 | Compatible patch updates only: xmldom 0.8.15, body-parser 1.20.6, qs 6.15.3. No forced major upgrades. Remaining advisory status recorded below. |

## Behavior and configuration

- Production entry stays `backend/src/server.js` serving `frontend/public`; TypeScript parser adapters must be rebuilt with `npm run build` on Node 22.
- The user confirmed the deployment is the company server with Anthropic, not Ollama or Runpod. `ANTHROPIC_API_KEY` and optional `ANTHROPIC_MODEL` are read only on the backend. Existing provider choice is preserved. Missing key produces an explicit unavailable response; no fake assistant answer. No company server environment was read or changed in this session.
- AI tools are read-only. No sending, approval, record updates, salary access, arbitrary SQL/URLs or file execution. Existing candidate.view grants whole-pool access; this change does not introduce department isolation. Request tools enforce owner/requester/creator scope unless view_all is granted.
- Conversation stays in browser component memory, is bounded, and clears on user change. The server rechecks live session/permissions on each request. Responses render as text.
- Limits and import locks are single-process. Run one application worker until shared concurrency/idempotency infrastructure is verified.
- No schema migration, production operation, live message/calendar action or data reset was performed.

## Verification

Node 22.23.2, after installing the final lockfile:

- `npm run typecheck`: exit 0.
- `npm run build`: exit 0.
- `node --experimental-sqlite run_tests.mjs`: 43 suites reported passed, zero failed (105.5 seconds). Some existing tests skip unavailable PostgreSQL/live readers; this is not proof of PostgreSQL compatibility.
- `vitest run --maxWorkers=2 --minWorkers=1`: 796 passed, 1 failed, 9 skipped. The remaining failure is the existing unused Ollama local-only assertion; Ollama files were left unchanged following the user's explicit Anthropic-only clarification. This failure has not been suppressed.
- Production JSX compile: both app.jsx and intake-review.jsx passed.
- `git diff --check`: clean.
- Dependency report after compatible fixes: 23 package findings (22 moderate, 1 high). Remaining major upgrades are not forced into this release.

New regression suites are part of `npm test`. A final independent agent review
could not complete because that agent reached its usage limit; the coordinator
inspected the implemented changes and ran the verification above. Browser and
live-infrastructure checks remain incomplete as listed below.

## Release gates and limits

This branch is a code repair candidate, not an unconditional production-readiness certification.

1. Verify the release against a disposable PostgreSQL copy, restart/systemd, backup restoration and concurrency before company cutover. SQLite cannot certify those behaviors.
2. Test the configured model with a sanitized Arabic/English/mixed PDF/DOCX corpus. Mock tests establish routing, evidence validation and safety boundaries; they do not measure real model accuracy or parsing latency percentiles.
3. Live Microsoft mailbox scope, delivery and calendar sync require their actual infrastructure. This change does not claim to complete those integrations.
4. Authenticated desktop/mobile browser review remains required. JSX compilation is not screenshot or visual-interaction evidence.
5. Major dependency advisories remain pending separately reviewed upgrades; do not run `npm audit fix --force` as part of deployment.

## Company server update

Keep the current deployment running until backup and release checks pass. Record
the existing SHA and use the repaired `deploy/on-prem/04-app.sh` with `ATS_REF`
set to the reviewed release SHA. Rebuild with Node 22, restart `arabtec-ats`, wait
for `/api/health/ready` to return 200, then run `06-verify.sh` from this release.
Recheck login, candidate download, one sanitized parse, repeated scan deduplication
and role-scoped AI. If necessary, rebuild the recorded previous SHA and restart;
do not roll back the database as a routine code rollback.

## Code ownership and access

Repository visibility remains public at the user's request. A public repository
can be copied without server access. File permissions and keeping secrets out of
git protect ordinary access, but cannot prevent a company administrator/root
from copying code on a server they control. Any future private-repository or
externally hosted service arrangement needs agreed access and ownership terms;
this release does not change company administrator access.
