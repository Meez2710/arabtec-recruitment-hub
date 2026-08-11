# Legacy suite baseline classification — stabilization merge gate

Purpose: record, once, that the suites failing at the end of the stabilization
batch were **already failing before it**, so the "no regression" claim rests on
a measurement rather than on assertion. Nothing here is repaired or modernized;
that is separate work.

| | |
| --- | --- |
| Pristine reference | `97be1b2` (BL-21/BL-23 concurrency closure) |
| Current stabilization HEAD | `2266b02` (BL-27 accepted) |
| Base for staging | `330be32` |
| Node · OS | v24.15.0 · macOS 26.5.2, arm64 |
| Engine under test | SQLite (`node --experimental-sqlite`) |
| Environment | `SEED_DEMO_DATA=true NODE_ENV=test SEED_ADMIN_PASSWORD=Admin@12345` |

The pristine column was measured by extracting `97be1b2` with `git archive` into
a throwaway directory and running the same runner there — no stash, no reset, no
change to any worktree.

## The 14 suites

| Suite | At `97be1b2` | At `2266b02` | Classification | Crashes during setup | Blocks staging | Production-release condition |
| --- | --- | --- | --- | --- | --- | --- |
| `inproc_test.mjs` | 14 passed, 13 failed | 14 passed, 13 failed | pre-existing, unchanged | No | No | Yes |
| `phase2_test.mjs` | 19 passed, 7 failed | 19 passed, 7 failed | pre-existing, unchanged | No | No | Yes |
| `phase3_test.mjs` | 27 passed, 6 failed | 27 passed, 6 failed | pre-existing, unchanged | No | No | Yes |
| `phase3_qa_test.mjs` | 39 passed, 10 failed | 39 passed, 10 failed | pre-existing, unchanged | No | No | Yes |
| `phase4_test.mjs` | 29 passed, 3 failed | 29 passed, 3 failed | pre-existing, unchanged | No | No | Yes |
| `phase4_qa_test.mjs` | crash before first assertion | crash before first assertion | pre-existing, unchanged | **Yes** | No | Yes |
| `phase5_test.mjs` | 39 passed, 10 failed | 39 passed, 10 failed | pre-existing, unchanged | No | No | Yes |
| `thread_test.mjs` | 20 passed, 5 failed | 20 passed, 5 failed | pre-existing, unchanged | No | No | Yes |
| `admin_ui_test.mjs` | crash before first assertion | crash before first assertion | pre-existing, unchanged | **Yes** | No | Yes |
| `connections_audit_test.mjs` | 22 passed, 16 failed | 22 passed, 16 failed | pre-existing, unchanged | No | No | Yes |
| `hardening_test.mjs` | 20 passed, 5 failed | 20 passed, 5 failed | pre-existing, unchanged | No | No | Yes |
| `auth_security_test.mjs` | 5 passed, 9 failed | 5 passed, 9 failed | pre-existing, unchanged | No | No | Yes |
| `email_test.mjs` | 1 passed, 5 failed | 1 passed, 5 failed | pre-existing, unchanged | No | No | Yes |
| `screening_test.mjs` | 8 passed, 2 failed | 8 passed, 2 failed | pre-existing, unchanged | No | No | Yes |

Delta across all fourteen: **zero**. Counts match suite for suite; the two
crashing suites fail at the identical line with the identical `TypeError`
(`phase4_qa_test.mjs:33` in `linkApp`, `admin_ui_test.mjs:21`).

## Why "does not block staging"

None of the fourteen changed, so none of them carries information about the
stabilization work. They gate nothing that the staging merge introduces. The
suites that *do* cover the stabilized behaviour are all green: BL-27, BL-21 and
BL-23, BL-03, BL-04, F-01, route manifest, parser seam, reconciliation, fixture
probe, and the required real-PostgreSQL gate.

## Why "production-release condition"

The failures are not fourteen independent defects. The observable pattern is one
cause with a wide blast radius: the admin session used by these suites is
answered with `{"code":"PASSWORD_CHANGE_REQUIRED"}` from the C1.1 forced-rotation
hardening, so every admin-only route returns 403 and every `audit has …`
assertion — which reads `/api/audit` with that token — fails for lack of a
readable audit trail rather than for a missing audit record. The two crashing
suites fail on the same shape earlier, dereferencing a response that was a 403.

That means the **suites** are stale with respect to a deliberate security
change, not that the audit trail is broken. It is nevertheless a production
condition: until they are modernized, these suites provide no regression cover
for users, audit, tickets, email or screening, and that gap must be closed
before a production release even though it does not block a staging merge.

Deliberately **not** done in this batch: repairing, rewriting or re-scoping any
of the fourteen.

## Open production findings (tracked separately)

These are product findings, not test findings. None blocks the staging merge.

| Finding | Summary | Production-release condition |
| --- | --- | --- |
| BL-01 / BL-13 | Seats are created `open` at requisition creation, so draft/pending/approved requisitions expose active capacity via `hasOpenSeat()` before approval or assignment. Reported by the reconciliation helper as `LIFECYCLE_PREMATURE_CAPACITY`. | **Yes** |
| BL-22 | Legacy status aliases still resolve on read (`APP_ALIAS`, `REQ_ALIAS`) rather than being cleaned out of stored data. Correct today and relied upon; the cleanup is unfinished. | **Yes** |
| BL-34 | `writeAudit` swallows failures unless the call site opts into `strict`. Transactional call sites opt in; the rest do not, so an audit write can still fail silently outside a transaction. | **Yes** |
| `partially_filled` headcount edit lock | Headcount editing on a `partially_filled` requisition is not covered by the BL-21/BL-23 reconciliation rules and remains locked. | **Yes** |
| Employment-ended / rehire | Absent **by design**. A joined application blocks globally and forever; nothing infers employment end from a closed requisition, a cancelled seat or a date. See `docs/BL27_JOINED_UNIQUENESS.md`. | Product decision — required before any rehire is supported, not before release |
