# CV Intake → Talent Pool — deployment handoff

Prepared 17 September 2026. **Nothing in this change has been deployed.** Local
work only; production (`10.20.0.9`) is untouched and still runs `6bf7bc1`.

---

## 1. Branch

`prod/cv-inbox-m365`

The worktree was on `claude/arabtec-ats-excellence-continue-041951` @ `dac02bf`
at the start of the session. That commit is fully contained in
`prod/cv-inbox-m365` (verified with `git merge-base --is-ancestor`), so switching
lost nothing.

## 2. Starting SHA

```
6bf7bc12a5ed15df3abae5675ea3342fc58447ec
```
"Open the CV Inbox to the HR team, and make outgoing mail possible" — the commit
currently deployed on `10.20.0.9`.

## 3. Final SHA

```
7d6f50008d7d6ab5ba61f265c75aa6c2ea598352
```
"A clean CV becomes a Talent Pool candidate without a human"

**This is the SHA to deploy** — the last commit containing code, and the exact
tree every test below was run against. One code commit ahead of production.

Anything after it on `prod/cv-inbox-m365` is documentation only (this file), so
deploying the branch head is equivalent. Pin the SHA anyway: it is the tree that
was tested, and `08-redeploy.sh` takes a ref precisely so a deploy cannot drift
from what was verified.

## 4. The old workflow

```
career mailbox
  → discovery (mailbox_ingestion: WAITING)
  → recruiter selects by job title
  → download + hash + dedup
  → AI parse
  → createIntake()  ──►  candidate_intake, status PENDING
                              │
                              ▼
                     ✋ STOPS HERE, ALWAYS
                              │
            a human opens Candidate Review, accepts each
            proposed field individually, then confirms
                              │
                              ▼
                   reviewIntake() → Candidates.create()
                              │
                              ▼
                        Talent Pool
```

Every successfully parsed CV — clean or not — waited for a person. Measured in
production on 14 Sep 2026: **41 intakes, all PENDING; `candidate` table: 0 rows.**
The parsing worked; nothing ever reached the Talent Pool.

## 5. The new workflow

```
career mailbox
  → discovery (mailbox_ingestion: WAITING)
  → recruiter selects by job title
  → download + hash + dedup
  → AI parse
  → createIntake()  ──►  candidate_intake, status PENDING
  → ingestIntake()       ← NEW: the assessment a recruiter was doing by hand
        │
        ├── clean            → reviewIntake(all fields accepted)
        │                      → Candidates.create()  →  TALENT POOL
        │                      → intake CONVERTED, classification stamped
        │
        ├── exact duplicate  → intake DUPLICATE, linked to the existing person
        │                      (one candidate; both CVs retained as history)
        │
        └── needs judgement  → intake stays PENDING + auto_code + reason
                               →  CANDIDATE REVIEW (exceptions only)
```

**Auto-ingest requires all four:**

| Condition | Rule |
|---|---|
| Name | present, ≥ 3 characters |
| Reachable | at least one of email, phone, linkedinUrl |
| Confidence | mean confidence of identity fields ≥ `0.55` |
| Profile | at least one of currentPosition, currentCompany, yearsExperience, skills, university, major, location |

Missing enrichment never forces review. Name + phone with no email is valid;
name + email with no phone is valid. Nothing is invented to fill a gap.

**Candidate Review now contains only:** unreadable/empty parse (`no-fields`),
no usable name or no contact detail (`identity-unclear`), low-confidence
identity (`low-confidence`), nothing readable about the work (`thin-profile`),
a name-only lookalike already in the pool (`duplicate-ambiguous`), a CV
uploaded against a requisition (`request-linked`), or a candidate-record rule
the reader got past (`invalid`).

**Classification** — five buckets, keyword-matched from the candidate's own
words (position, company, major, skills), offline and free:
`Construction / Engineering Core`, `Construction / Engineering Support`,
`Adjacent / Transferable`, `Other Professional Background`,
`Unclear / Needs Review`. For search and filtering only. It never matches a
hiring request and never rejects anyone.

**No Application is ever created automatically.** `reviewIntake` raises one only
when the intake names a requisition, so `ingestIntake` refuses any intake
carrying a `requestId` — enforced inside the orchestrator, not at each call
site, so a future caller cannot wire around it.

## 6. Files changed

| File | Change |
|---|---|
| `backend/src/lib/cv-intake/auto-ingest.js` | **new** — the gate, the classifier, and `ingestIntake()` |
| `backend/cv_auto_ingest_test.mjs` | **new** — 24 assertions over all specified edge cases |
| `backend/src/lib/intake-store.js` | `markIntakeDuplicate`, `markIntakeNeedsReview`, `stampIntakeClassification`; `toIntake` carries `autoCode` + `classification` |
| `backend/src/lib/microsoft/mailbox-sync.js` | both ingest paths call `ingestIntake`; summary counters; richer audit |
| `backend/src/routes/candidates.js` | `/parse-cv` and `/parse-cv-async` call `ingestIntake`; `disciplineClass` filter; `disciplineClass` in `serialize()` |
| `backend/src/lib/models.js` | `Candidates.setDisciplineClass`; `disciplineClass` in the filter builder |
| `backend/src/lib/schema.js` | three additive columns |
| `backend/run_tests.mjs` | new suite registered |
| `frontend/public/intake-review.jsx` | copy corrected; each row shows its reason |
| `frontend/public/arabtec-design-system.css` | `.intake-why` style |
| `frontend/public/index.html`, `component-gallery.html` | cache token → `20260917a` |

## 7. Schema / migration

All additive, all idempotent, all through the existing `addColumnIfMissing()`
helper, which runs inside `ensureSchema()` on boot. **There is no separate
migration to run and no manual SQL.**

```
candidate.discipline_class        TEXT   NULL   -- search bucket
candidate_intake.auto_code        TEXT   NULL   -- why a person is needed
candidate_intake.classification   TEXT   NULL   -- bucket, recorded on the intake
```

`candidate_intake.status` gains the value `DUPLICATE`. The column has always
been free text with **no CHECK constraint**, so this needs no migration; an
older build reading such a row simply sees a status it does not act on.

Every existing row is untouched. Existing candidates have `discipline_class`
NULL, which means "not in a bucket" and never excludes them from an unfiltered
search.

**Backwards compatible:** rolling back to `6bf7bc1` leaves the three columns in
place and unused. No data is lost by a rollback.

## 8. Tests and exact results

```
node --experimental-sqlite run_tests.mjs
→ Ran 65 suites in 197.6s · 65 passed, 0 failed · ALL SUITES PASSED
```

New suite, `cv_auto_ingest_test.mjs` — **0 failures, 24 assertions**:

| # | Case | Result |
|---|---|---|
| 1 | clean construction CV | CONVERTED, Core, in Talent Pool |
| 2 | clean support-function CV | CONVERTED, Support |
| 3 | unrelated professional (accountant) | CONVERTED, Other — not rejected |
| 4 | no hiring requests exist | pipeline completes (0 requisitions in fixture) |
| 5 | missing email, usable phone | CONVERTED, email stays null |
| 6 | missing phone, usable email | CONVERTED, phone stays null |
| 7 | exact duplicate CV | DUPLICATE, one candidate |
| 8 | existing candidate sends updated CV | one candidate, both documents retained |
| 9+10 | same name, different person | NEEDS_REVIEW, never merged |
| 11 | failed/ambiguous parse | NEEDS_REVIEW + reason (4 variants: a–d) |
| 12 | multiple attachments | processed independently |
| 14 | provider/record failure | intake retained, still retryable |
| 15 | repeated sync | idempotent, no second candidate |
| 16 | Arabic CV | CONVERTED, name preserved, bucket honestly Unclear |
| 17 | mixed Arabic/English | CONVERTED, Core from the English half |
| 18 | clean auto-ingest | **0 applications created** |
| 18b | CV uploaded against a requisition | NEEDS_REVIEW (`request-linked`) |

Case 13 (CVs plus signatures/logos) is covered by the existing attachment
classifier and asserted in `audit_regression_test.mjs`: inline images are
excluded, real attachments are accepted.

**Mutation testing** — each load-bearing guard was broken on purpose to prove
the test can fail:

| Mutation | Test that failed |
|---|---|
| gate always returns ok | 11, 11b, 11c, 11d |
| lookalike check removed | 9+10 |
| requisition refusal removed | 18b |
| exact-duplicate check removed | 7, 8 |

**Browser verification** (local SQLite, seeded, ten CVs through the real path):
Talent Pool 7 candidates, all `source: cv_auto_ingest`, each classified and
filterable by classification / position / minimum experience; Candidate Review
exactly 3, each showing its reason; `/api/applications` total **0**.

## 9. Known limitations

- **Classification is keyword-based and English-only.** Arabic job titles fall
  to `Unclear / Needs Review` — deliberately, rather than guessing. Those
  candidates are still in the Talent Pool and fully searchable; only the bucket
  is absent. On the production backlog measured on 14 Sep, roughly a third of
  subjects classified; expect a similar order for positions.
- **`MIN_IDENTITY_CONFIDENCE` (0.55) is a first setting, not a tuned one.** It
  admits a deterministic read and a solid model read. Watch the ratio of
  `low-confidence` rows in Candidate Review after go-live and adjust — it is one
  constant in `auto-ingest.js`.
- **A parser that reports no confidence scores 1.0** by design, so a provider
  that does not grade itself is not silently treated as untrustworthy.
- **Existing production intakes stay PENDING.** The 41 already in the queue were
  created before this change and are not retro-processed. They can be reviewed
  by hand, or re-parsed, but nothing in this deploy touches them.
- **`discipline_class` is only set at ingest.** Candidates created before this
  change, and any created manually, have NULL.
- **Auto-ingest accepts every proposed field.** Rejecting a field remains a
  human judgement; the unattended path never drops a value the reader supported.
- The `potential` (name-only) duplicate check runs before the write, which is a
  second `classifyDuplicates` call per clean CV. Negligible at this volume;
  worth noting if the backlog is ever processed in one very large batch.

## 10. Tomorrow's deployment procedure

> Commands are listed to be run in order. **None of these were run today.**

```bash
# 1. Inspect production and record what is deployed NOW
ssh ats@10.20.0.9 '
  echo "deployed:  $(git -C /opt/arabtec-ats rev-parse HEAD)"
  echo "unit:      $(systemctl is-active arabtec-ats)"
  echo "health:    $(curl -s -o /dev/null -w %{http_code} http://127.0.0.1:4001/api/health)"
  echo "ready:     $(curl -s -o /dev/null -w %{http_code} http://127.0.0.1:4001/api/health/ready)"
  echo "tree:      $(git -C /opt/arabtec-ats status --porcelain --untracked-files=no | wc -l) local change(s)"
'
# Expect: deployed 6bf7bc1…, active, 200, 200, 0 local changes.
# If the tree is NOT clean, STOP — the redeploy script will refuse anyway.
```

```bash
# 2. Protected row counts BEFORE (keep this output)
ssh ats@10.20.0.9 'PID=$(systemctl show -p MainPID --value arabtec-ats)
  DSN=$(tr "\0" "\n" < /proc/$PID/environ | sed -n "s/^DATABASE_URL=//p")
  psql "$DSN" -At -F"|" -c "select
    (select count(*) from users), (select count(*) from candidate),
    (select count(*) from candidate_intake), (select count(*) from mailbox_ingestion),
    (select count(*) from application), (select count(*) from recruitment_request),
    (select count(*) from interview), (select count(*) from offer),
    (select count(*) from file_blob), (select count(*) from role_permission);"'
```

```bash
# 3. Fresh backup, independent of the one the deploy script takes
ssh ats@10.20.0.9 'PID=$(systemctl show -p MainPID --value arabtec-ats)
  DSN=$(tr "\0" "\n" < /proc/$PID/environ | sed -n "s/^DATABASE_URL=//p")
  pg_dump --format=custom --no-owner --dbname="$DSN" \
    --file="$HOME/backups/pre-autoingest-$(date +%Y%m%d-%H%M%S).dump"
  ls -lh ~/backups | tail -3'
```

```bash
# 4. Deploy the exact tested SHA — nothing else
ssh ats@10.20.0.9 'ATS_REF=7d6f50008d7d6ab5ba61f265c75aa6c2ea598352 \
  bash /opt/arabtec-ats/deploy/on-prem/08-redeploy.sh'
```

The script already does, in order: pre-deploy `pg_dump` → assert the git
refspec → refuse a dirty tree → `git reset --hard` to the SHA → `npm ci` keeping
the old `node_modules` until the build succeeds → `npm run build` →
restart → wait for `/api/health/ready` → print the rollback command.

**Migrations:** none to run. `ensureSchema()` adds the three columns on boot.
**Restart scope:** `arabtec-ats` only — the script restarts nothing else.

**Do not run:** any seed, reset, demo loader, sample SQL, `migrate-arabtec-data`,
`reset-transactional-data`, or import. None is required by this change.

## 11. Rollback procedure

```bash
ssh ats@10.20.0.9 'ATS_REF=6bf7bc12a5ed15df3abae5675ea3342fc58447ec \
  bash /opt/arabtec-ats/deploy/on-prem/08-redeploy.sh'
```

The redeploy script prints this line itself on success. Rolling back is safe
without touching the database: the three added columns are nullable and simply
go unused, and a `DUPLICATE` intake row is a status the older build does not act
on. **Candidates created by auto-ingest before a rollback remain in the Talent
Pool** — they are ordinary candidate records created through the ordinary path.

Restore the database only if something unrelated corrupts it:

```bash
ssh ats@10.20.0.9 '
  sudo systemctl stop arabtec-ats
  pg_restore --clean --if-exists --no-owner --dbname="$DSN" ~/backups/pre-autoingest-<stamp>.dump
  sudo systemctl start arabtec-ats'
```

## 12. Production verification checklist

Run in order after the deploy. Stop and roll back on any ✗.

- [ ] `git -C /opt/arabtec-ats rev-parse HEAD` == `7d6f5000…`
- [ ] `DEPLOYED_SHA` file matches the same SHA
- [ ] `/api/health` → 200 and `/api/health/ready` → 200
- [ ] `systemctl is-active arabtec-ats` → active
- [ ] Row counts match step 2 exactly — **`candidate`, `application`,
      `interview`, `offer` and `recruitment_request` must be UNCHANGED by the
      deploy itself**
- [ ] The three columns exist:
      `\d candidate` shows `discipline_class`;
      `\d candidate_intake` shows `auto_code` and `classification`
- [ ] `journalctl -u arabtec-ats --since "10 min ago" | grep '"level":"error"'` → empty
- [ ] Log in as a recruiter (not the admin) and confirm **CV Inbox** opens
- [ ] **Send one controlled CV** to `career@arabtecegy.com` — a clean PDF with a
      name, a phone or email, and a job title
- [ ] CV Inbox → **Refresh from mailbox** → the new CV appears as waiting
- [ ] Select it → **Parse selected CVs**
- [ ] **It appears in the Talent Pool directly**, with a classification
- [ ] **It is NOT in Candidate Review** (a clean CV must bypass the queue)
- [ ] **No Application was created** — `select count(*) from application` is
      still the number recorded in step 2
- [ ] Parse the same CV again → **no second candidate**; the intake resolves as
      `DUPLICATE` against the first
- [ ] Filter the Talent Pool by that classification and confirm the candidate is
      returned
- [ ] `select status, count(*) from candidate_intake group by 1` — expect
      CONVERTED and possibly DUPLICATE to appear alongside the pre-existing
      PENDING rows
- [ ] `journalctl -u arabtec-ats --since "15 min ago" | grep cv_parse.timing`
      shows the parse actually ran

**Expected end state:** the 41 pre-existing PENDING intakes are still PENDING
(they are not retro-processed); every CV parsed *after* the deploy either
reaches the Talent Pool or sits in Candidate Review with a stated reason; the
`application` count is unchanged throughout.
