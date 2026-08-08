# F-01 / F-02 — Stop Condition: the transaction primitive is unsound on the production engine

**Branch:** `stabilize/core-data-integrity` from `330be32`
**Status:** data-integrity batch **halted at preflight**, per the instruction to stop rather
than improvise partial transaction behaviour.
**Nothing in the batch was implemented.** No route, model, or schema file was modified.

---

## 1. Why the batch cannot proceed as specified

The batch's acceptance criteria require that, for every multi-step write, *"all writes commit
together or none commit"* and that *"rollback is verified against persisted state."*

Two facts make that unachievable today without a prerequisite change.

### Fact 1 — a transaction primitive exists but has zero callers

[`db.js:214-218`](backend/src/lib/db.js:214) exports:

```js
export function tx(fn) {
  exec('BEGIN');
  try { const r = fn(); exec('COMMIT'); return r; }
  catch (e) { try { exec('ROLLBACK'); } catch {} throw e; }
}
```

Call sites across every write-bearing route:

| File | write calls | `tx()` uses |
| --- | --- | --- |
| `src/routes/applications.js` | via models | **0** |
| `src/routes/requests.js` | via models | **0** |
| `src/routes/candidates.js` | 3 direct + models | **0** |
| `src/routes/offers.js` | via models | **0** |

`tx()` is dead code. Every multi-step write autocommits statement by statement.

### Fact 2 — `tx()` is unsound on Postgres, which is the production engine

[`pg-worker.mjs:31,38`](backend/src/lib/pg-worker.mjs:31):

```js
const pool = new pg.Pool({ connectionString: CONN, max: 4, … });
query = async (sql, params) => { const r = await pool.query(sql, …); … };
```

Every `run/get/all/exec` is one `pool.query()`, and `pool.query()` **acquires a client,
runs one statement, and releases it**. So under `tx()`:

- `exec('BEGIN')` opens a transaction on connection A, which is then returned to the pool
- the intervening writes may run on B, C or D, where they **autocommit**
- `exec('COMMIT')` commits whatever happens to be open on whichever client it draws

Consequences, in order of severity:

1. **Rollback does not roll anything back.** Writes that landed on other connections are
   already committed.
2. **Cross-request contamination.** With `max: 4` and concurrent requests, an unrelated
   request's statements can execute inside another request's open transaction, and a
   `ROLLBACK` then discards *its* writes.
3. **Connections are left idle-in-transaction** when a client carrying an open `BEGIN` is
   returned to the pool, exhausting a 4-connection pool under load.

Production is Postgres: [`render.yaml:37-39`](render.yaml:37) binds `DATABASE_URL`
`fromDatabase: arabtec-db`.

### Why this is a stop condition rather than something to work around

The pilot currently runs **SQLite** — boot summary reports `"db":"sqlite"`, and
`DATABASE_URL` in `backend/.env` uses the `file:` scheme. On SQLite, `tx()` **is** sound:
`node:sqlite` `DatabaseSync` is a single connection.

So wrapping the batch's writes in `tx()` would produce a suite that is **green on SQLite and
silently corrupting on Render Postgres**. Acceptance criterion *"rollback is verified against
persisted state"* would be satisfied on the wrong engine. That is exactly the false
confidence the stop instruction exists to prevent.

---

## 2. Smallest viable prerequisite slice

Make the worker protocol session-affine. The worker currently accepts one statement per
message with no way to express *"these N statements share a session"* — that protocol gap is
the whole problem, and it is contained.

**Scope — two files, no route or model changes:**

1. `pg-worker.mjs` — add `begin` / `commit` / `rollback` message types that check out a
   single client with `pool.connect()`, pin it for the duration, and release it on
   settle. Statement messages arriving while a transaction is pinned use that client.
2. `db.js` — route `tx()` through the pinned-session messages instead of bare
   `exec('BEGIN')`.

**Explicitly out of scope:** the async/await conversion. The synchronous surface
(`Atomics.wait`) is preserved, so the 255 existing call sites stay untouched. This is *not*
the full F-02.

**Verification this slice requires:**

- a rollback test against **real Postgres**, not SQLite and not PGlite — PGlite is a single
  in-process connection ([`pg-worker.mjs:20`](backend/src/lib/pg-worker.mjs:20)) and
  therefore **cannot reproduce the pool bug**; it would pass while production still fails
- a concurrency test proving one request's writes cannot enter another's transaction
- a test that a failed transaction leaves no idle-in-transaction connection

Real Postgres was previously exercised in this project via `embedded-postgres` installed
with `--no-save` and removed afterwards; the same approach works here.

---

## 3. Defects confirmed during preflight — evidence recorded, not fixed

These are ready to implement once the prerequisite lands.

| ID | Evidence | Finding |
| --- | --- | --- |
| **BL-03** | [`applications.js:95`](backend/src/routes/applications.js:95) — `APP_STATUSES.includes(appNorm(d.initialStatus)) ? … : APP.SOURCED`, and [`stages.js:86`](backend/src/lib/stages.js:86) defines `APP_STATUSES = [...APP_PIPELINE, ...APP_TERMINALS]` which **contains `joined`, `offer_sent`, `rejected`** | A client can `POST` `initialStatus: "joined"` and create an application directly at a terminal stage, bypassing the pipeline, seat accounting and the offer flow |
| **BL-21** | [`requests.js:206`](backend/src/routes/requests.js:206) calls `Seats.createMany` on create; the PATCH handler at [`requests.js:241`](backend/src/routes/requests.js:241) writes a new `headcount` with **no `Seats` call anywhere in the handler** | Changing headcount does not create or remove seats; seat count and approved headcount silently diverge |
| **BL-27** | zero occurrences of `joined` in `src/routes/applications.js` | No uniqueness guard: one candidate can be joined to two active requisitions |
| **F-01** | `applications.js:96-109` performs **7 sequential writes** — `Applications.create`, `StageHistory.add`, two `Requests.stampLifecycle`, `CandidateActivity.add`, `RequestActivity.add`, `writeAudit` — with no transaction | A failure after the first write leaves an application with no stage history and no audit record |

BL-04 and BL-23 were not traced to line evidence before the stop; they depend on the same
seat-accounting surface as BL-21.

---

## 4. Options

| | Scope | Risk |
| --- | --- | --- |
| **A. Prerequisite first** — session-affine worker slice, verified against real Postgres, then the batch | 2 files + a Postgres test harness, then the batch as specified | Correct on both engines. Adds the harness step before any business fix |
| **B. Pilot-only, SQLite-pinned** — implement the batch wrapped in `tx()`, and formally restrict the pilot to SQLite | Batch only | Sound **only** while the pilot stays on SQLite. Requires an explicit, recorded decision that Render Postgres is not a pilot target, and the work must be re-verified before any Postgres deployment |
| **C. Business fixes without transactions** — BL-03, BL-21, BL-27 as validation-only changes | Smallest | **Fails the batch's own acceptance criteria.** Not recommended: it would ship the guards while leaving partial-write corruption in place |

---

## 5. Recommendation

**Option A**, unless the pilot is formally SQLite-only and that is recorded — in which case
**Option B** is defensible and materially faster, provided the Postgres re-verification is
tracked as a release blocker rather than forgotten.

The decision is the owner's because it turns on a deployment fact, not an engineering one:
**will the internal HR pilot run on SQLite or on Render Postgres?**
