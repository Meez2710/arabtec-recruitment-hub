# BL-27 — one `joined` application per candidate, globally

## The rule

A candidate may hold **one** application at canonical status `joined`, across the
whole system.

| Situation | Blocks a new join? |
| --- | --- |
| Joined application on an **open** requisition | Yes |
| Joined application on a **closed / cancelled / filled** requisition | **Yes** |
| Joined application whose seat was later **cancelled** | **Yes** |
| Joining date in the past | **Yes** — dates prove nothing |
| `rejected`, `offer_declined`, `withdrawn` (alias of `rejected`) | No |
| `sourced`, `matched`, `unmatched`, `shortlisted`, `interviewing`, `waiting_feedback`, `issuing_offer`, `offer_sent`, `on_hold` | No |

Employment ends when someone **records** that it ended. That workflow does not
exist yet, so nothing in the system may infer it from a requisition status, a
seat status or a date. There is **no rehire path and no admin override** — their
absence is the rule, not a gap. `allow_duplicate_application`, `overrideExisting`
and `overrideTerminal` govern other decisions and deliberately do not reach this
one.

## Where it is enforced

Two independent layers, because either alone is insufficient:

1. **Shared transactional boundary** — `backend/src/lib/join.js`. Every path that
   can produce `joined` enters `joinApplication()`: the single move
   (`POST /api/applications/:id/move`), the bulk move
   (`POST /api/applications/bulk`) and the offer result
   (`POST /api/offers/:id/result` with `result: 'joined'`). It rechecks
   eligibility inside the transaction and owns the complete write set.
2. **Database invariant** — a partial unique index, identical DDL on PostgreSQL
   and SQLite:

   ```sql
   CREATE UNIQUE INDEX IF NOT EXISTS ux_application_one_joined_per_candidate
     ON application(candidate_id) WHERE status='joined';
   ```

   This is what holds under genuine multi-process concurrency, and what stops a
   future code path nobody has written yet.

`status='joined'` is an exact test, not an approximation: `joined` is the only
key in `APP_ALIAS` resolving to `APP.JOINED`. `offer_accepted` resolves to
`offer_sent` and `withdrawn` to `rejected`.

## Client contract

A blocked join returns **HTTP 409** with a stable body. No SQL text, table name,
index name or driver message reaches the client.

```json
{
  "error": "This candidate already has a joined application and cannot join another.",
  "code": "CANDIDATE_ALREADY_JOINED",
  "blockingApplicationId": 42,
  "blockingRequestId": 7
}
```

Other stable codes from the same boundary: `APPLICATION_ALREADY_JOINED` (the
same application again) and `NO_OPEN_SEAT`. The bulk route keeps its existing
per-item contract and reports `{ reason: 'candidate_already_joined' }` in
`skipped` rather than failing the batch.

## Checking staging or production BEFORE enabling enforcement

The index cannot be created on a database that already violates it. Boot does
the check itself and **refuses to enforce** rather than failing — but check
deliberately first, with a read-only role, and do it on a restored snapshot
rather than the live primary where practical.

**Step 1 — read-only duplicate query.** Safe to run anywhere. It writes nothing,
takes no locks beyond a normal read, and returns IDs and counts only — no name,
email, phone or salary — so the output can be pasted into a ticket unredacted.

```sql
SELECT candidate_id,
       COUNT(*)                        AS joined_count,
       STRING_AGG(id::text, ',' ORDER BY id)         AS application_ids,
       STRING_AGG(request_id::text, ',' ORDER BY id) AS request_ids
  FROM application
 WHERE status = 'joined'
 GROUP BY candidate_id
HAVING COUNT(*) > 1
 ORDER BY joined_count DESC, candidate_id;
```

The same result is available programmatically from
`backend/src/lib/join-reconciliation.js` → `duplicateJoinedCandidates()`.

**Step 2 — interpret.**

- *No rows*: the environment is clean. Deploy; boot creates the index silently
  and idempotently. Existing clean databases upgrade with no migration step.
- *Any rows*: **stop**. Boot will log the exact conflict and leave enforcement
  off for that environment. Do not deploy expecting the invariant to be active
  there.

**Step 3 — resolve conflicts as a human decision.** Nothing selects a winner
automatically, and nothing repairs the data. Which joined application is real
depends on payroll, the signed contract and which requisition funded the seat —
none of which this database knows. For each reported candidate, decide with HR
which application is the true employment, correct the others deliberately
(recording why), then restart. Boot re-runs the check and installs the index.

**Step 4 — verify enforcement is live.**

```sql
-- PostgreSQL
SELECT indexdef FROM pg_indexes WHERE indexname = 'ux_application_one_joined_per_candidate';
```

```sql
-- SQLite
SELECT sql FROM sqlite_master WHERE type='index' AND name='ux_application_one_joined_per_candidate';
```

`ensureSchema()` also records the outcome; `joinedUniqueness()` returns
`{ enforced, reason, duplicates }`, where `reason` is `ok`,
`historical_duplicates` or `create_failed: …`.

## Tests

| Suite | Engine | Covers |
| --- | --- | --- |
| `backend/bl27_test.mjs` | SQLite | Eligible and ineligible histories, closed requisition, cancelled seat, no-override, bulk and offer paths, direct-write rejection, duplicate reconciliation on deliberately malformed fixtures, failure injection after all eight write boundaries |
| `backend/pg_join_race_test.mjs` | Real PostgreSQL, 3 processes | Overlapping joins for one candidate across requisitions, three-way race, independent candidates in parallel, two candidates racing for the last seat, connection hygiene |

## Deliberately out of scope

Employment-ended workflow, rehire, admin override, BL-22 alias cleanup,
`partially_filled` headcount editing, parser/AI integration, UI changes.
