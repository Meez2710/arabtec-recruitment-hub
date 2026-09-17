# CV Intake → Talent Pool — deployment handoff

Prepared 17 September 2026, revised twice the same day (CV Intake direction
change).

> **DEPLOYED 17 September 2026, 08:41 UTC.** `10.20.0.9` now runs
> `765c918`. Rollback ref: `6bf7bc1`. See the deployment record at the end of
> this document for what was verified and what the backlog run produced.

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
765c91859c4b2cdc6ff6ec6fcac20cf090bd3fd8
```
"Label what is uncertain; stop withholding the candidate"

**This is the SHA to deploy** — the last commit containing code, and the exact
tree every test below was run against. Three code commits ahead of production:

| SHA | |
|---|---|
| `7d6f500` | auto-ingest — superseded |
| `f0aa455` | classification/review split + profile refresh — superseded |
| `765c918` | **deploy this** — uncertainty is labelled, not blocked |

Deploy `765c918` only; it contains both earlier commits in full. Anything after
it on `prod/cv-inbox-m365` is documentation, so the branch head is equivalent —
pin the SHA anyway, because it is the tree that was tested and `08-redeploy.sh`
takes a ref precisely so a deploy cannot drift from what was verified.

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
career mailbox → discovery → recruiter selects → download + dedup → AI parse
  → createIntake()
  → ingestIntake()
        │
        ├── clean or merely incomplete  →  TALENT POOL
        │        with data-quality labels for whatever was uncertain
        │
        ├── exact duplicate, same person →  one candidate, career data
        │        refreshed from the newer CV, both documents kept
        │
        └── one of FOUR hard exceptions  →  no candidate; intake stays PENDING
                 and a person looks at the document itself
```

**Almost every successfully parsed CV goes straight into the Talent Pool.**
Candidate Review is not a gate for ordinary data-quality problems.

### The only four hard blocks

1. Nothing could be read from the document (`unreadable`)
2. No usable candidate name could be extracted (`no-identity`)
3. The candidate record itself rejects a value the reader got past
4. The write would corrupt another person's identity — handled by creating a
   separate flagged candidate rather than touching the record on file

### Data-quality labels

Everything else that used to block is now a label on a real candidate.

| Label | Raised when | Sentence shown |
|---|---|---|
| `Contact Missing` | no email, phone or LinkedIn | "No email or phone could be extracted." |
| `Incomplete Profile` | nothing readable about the work | "Current position and experience could not be extracted reliably." |
| `Low Confidence` | mean identity confidence < 0.55 | "Some parsed fields have low extraction confidence." |
| `Unclassified` | the classifier could not bucket the profession | "Professional classification could not be determined confidently." |
| `Possible Duplicate` | a namesake with no shared contact detail | names the candidate they resemble |
| `Needs Review` | shared contact detail, materially different name | names the record it conflicts with |

Labels are **replaced, not accumulated**: a newer CV supplying the missing phone
number clears `Contact Missing` rather than leaving it on the record for ever.

Stored as `candidate.quality_flags` (JSON codes) and `candidate.quality_note`
(the sentences). Filtering is **opt-in** — the default Talent Pool shows
everyone, flagged or not.

**Classification** — `Construction / Engineering Core`,
`Construction / Engineering Support`, `Adjacent / Transferable`,
`Other Professional Background`, `Unclassified`. Search and filtering only;
never read by the ingest gate, never a reason to reject anyone.

**No Application is ever created automatically**, and nothing depends on a
hiring request existing. Shortlisting, interviews, offers and stage progression
remain human decisions.

## 5a. Exact-duplicate / update policy

When a new CV matches someone already in the pool on email, phone, LinkedIn or
file hash, one of two things happens.

**Namesake, no shared contact → a separate flagged candidate.** Two people with
one name is ordinary. The second is created as their own candidate labelled
`Possible Duplicate`, naming who they resemble. Never auto-merged; a recruiter
merges later if they turn out to be one person.

**Identity conflict → separate candidate, other record untouched.** If the
incoming name is materially different from the name on file — normalised, and
allowing an added middle name or a dropped initial — the record on file is left
**entirely alone** and this CV becomes its own candidate labelled `Needs Review`.
A shared family address or a forwarded CV must never write one person's career
onto another's record. `reviewIntake`'s duplicate refusal is overridden only on
this path, deliberately and with a reason written to the record.

**Otherwise, the same person sent a newer CV.** Career data moves; identity
never does.

| Field group | Fields | Behaviour |
|---|---|---|
| Career | currentPosition, currentCompany, yearsExperience, skills, location, university, major, graduationYear, languages, certifications, nationality, noticePeriod | **Refreshed automatically**, only where the new CV differs from what is stored |
| Identity / contact | fullName, email, phone, linkedinUrl | **Never changed automatically.** Proposed and recorded as deliberately held, so the history shows they were read |
| Classification | discipline_class | Re-derived from the newer CV, but only when something else actually changed |

Mechanism: `raiseProposal` → `reviewProposal`, the same path a recruiter's
review uses, with a fixed decision map instead of a person's clicks. Nothing new
was built.

**Nothing is destroyed silently.** Every applied change is written to the
`candidate_proposal` record with the value it replaced and lands in the audit
log, so a curated value that a newer CV overwrites is always recoverable and
always attributable. An unchanged re-send writes nothing at all and leaves no
noise in the history.

**Both CVs are kept.** The document is attached to the candidate on first ingest
and on every subsequent one, which also makes `classifyDuplicates`' own
file-hash rule work — before this, the CV history was empty and an identical
file was only caught when it shared a contact detail.

**No Application, ever.** Unchanged from the baseline and re-asserted by test.

## 6. Files changed

| File | Change |
|---|---|
| `backend/src/lib/cv-intake/auto-ingest.js` | **new** — the gate, the classifier, `ingestIntake()`; then (`f0aa455`) the `Unclassified` rename, `identityConflict()`, `refreshExisting()` and `attachDocument()` |
| `backend/cv_auto_ingest_test.mjs` | **new** — 36 assertions: all specified edge cases, plus C1–C4 (separation) and U1–U6 (update policy) |
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
candidate.quality_flags           TEXT   NULL   -- JSON array of label codes
candidate.quality_note            TEXT   NULL   -- the sentences a recruiter reads
candidate_intake.auto_code        TEXT   NULL   -- why a document was blocked
candidate_intake.classification   TEXT   NULL   -- bucket, recorded on the intake
```

`quality_flags` is filtered with the same JSON `LIKE` pattern the existing
`tags` column already uses, so it needs **no new index** and no new query
machinery.

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
→ Ran 65 suites in 135.2s · 65 passed, 0 failed · ALL SUITES PASSED
```

New suite, `cv_auto_ingest_test.mjs` — **0 failures, 39 assertions**, covering
the full matrix:

| # | Case | Result |
|---|---|---|
| 1 | normal clean CV | Talent Pool, no flags |
| 2 | missing email, usable phone | Talent Pool, no `Contact Missing` |
| 2c | no contact at all | Talent Pool **with** `Contact Missing` |
| 3 | missing phone, usable email | Talent Pool |
| 4 | sparse professional data | Talent Pool **with** `Incomplete Profile` |
| 5 | low confidence on identity | Talent Pool **with** `Low Confidence` |
| 6 | valid Arabic CV | Talent Pool, `Unclassified` |
| 7 | same name, different contacts | **separate** candidate, `Possible Duplicate`, no merge |
| 8 | exact duplicate | one candidate, both documents retained |
| 9 | completely unreadable file | hard exception, no candidate |
| 10 | no usable name | hard exception, no candidate |
| 11 | flagged candidate | searchable by name, role, experience, location, classification, source |
| 12 | every label is a filter | each finds the right people; `flagged` yes/no views are disjoint |
| 13 | no Application auto-created | 0 across the entire suite |
| 14 | no Hiring Request dependency | 0 requisitions existed throughout |
| U1–U6 | updated-CV policy | career refreshed, identity never, both documents kept |
| C1–C4 | classification is a search fact | never blocks, never named "review" |

**Mutation testing** — the new behaviour is enforced, not merely intended:

| Mutation | Test that failed |
|---|---|
| missing contact blocks again | 2c, 11, 12 |
| namesakes blocked instead of flagged | 7 |
| labels never persisted | 7, 2c, 4, 5, U4 |
| identity conflict overwrites the other person | U4 |
| a nameless CV creates a candidate | 10 |

Five assertions in `microsoft_integration_test.mjs` were **inverted, not
weakened**. They encoded the pre-change rule ("parsing NEVER creates a
candidate", "the reviewed intake flow is still the only way in") and now assert
what genuinely still holds: a scan fills the Talent Pool and creates **no
application**. One was measuring against a count captured at the top of the
file and is re-anchored to just before the disconnect it describes.

**Browser verification** (local SQLite, seeded, ten CVs through the real path):
**nine** reached the Talent Pool — including every incomplete one — carrying the
correct badges; **one** hard exception (no extractable name) stayed in Candidate
Review; each label filter returned exactly the right people; the default pool
hid nobody; both namesakes existed separately with the second flagged; and
`/api/applications` returned **0**.

## 9. Known limitations

- **Classification is keyword-based and English-only.** Arabic and mixed-language
  job titles fall to `Unclassified` — deliberately, rather than guessing. Those
  candidates enter the Talent Pool normally and are fully searchable by name,
  contact, position text, experience and location; only the bucket is absent,
  and they are never routed to Candidate Review for it. On the production
  backlog measured on 14 Sep, roughly a third of subjects classified; expect a
  similar order for positions. A later release may classify Arabic
  asynchronously through Anthropic — **ingestion must never depend on that
  provider call**, which is why the classifier is offline and free today.
- **`LOW_CONFIDENCE_BELOW` (0.55) is a first setting, not a tuned one.** It no
  longer blocks anything — it decides whether a candidate carries the
  `Low Confidence` badge. Watch how many candidates wear it after go-live and
  adjust; it is one constant in `auto-ingest.js`.
- **Labels are derived only at ingest.** Editing a candidate by hand does not
  recompute them, so a recruiter who fills in a missing phone number still sees
  `Contact Missing` until a newer CV arrives for that person. Clearing a label
  manually is not yet possible from the UI.
- **A parser that reports no confidence scores 1.0** by design, so a provider
  that does not grade itself is not silently treated as untrustworthy.
- **Existing production intakes stay PENDING.** The 41 already in the queue were
  created before this change and are not retro-processed, so Candidate Review
  will not be empty on day one. They can be reviewed by hand or re-parsed;
  nothing in this deploy touches them.
- **Existing candidates carry no labels.** `quality_flags` is NULL for everyone
  created before this change, which the filters read as "unflagged". They can be reviewed
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
      `DUPLICATE` against the first, and the reason says it added nothing
- [ ] **Send a second, UPDATED CV for the same person** (same email, a changed
      job title and years of experience) → still one candidate; the Talent Pool
      shows the NEW position and years; `select origin,status from
      candidate_proposal where candidate_id=<id>` shows a reviewed
      `cv_auto_refresh` row; `select count(*) from candidate_document where
      candidate_id=<id>` is 2; **still zero applications**
- [ ] Confirm the candidate's **email and phone are unchanged** by that refresh
- [ ] If any CV in the batch could not be bucketed, confirm it is in the Talent
      Pool with classification `Unclassified` and **NOT** in Candidate Review
- [ ] **Send a deliberately incomplete CV** (a name and a job title, no email or
      phone) → it appears in the Talent Pool carrying a `Contact Missing` badge,
      and is **NOT** in Candidate Review
- [ ] The default Talent Pool (no filter selected) shows flagged and unflagged
      candidates together
- [ ] Each data-quality filter returns only candidates carrying that label
- [ ] `select count(*) from candidate_intake where status='PENDING'` has not
      grown beyond the pre-existing 41 plus any genuine hard exceptions
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


---

# Deployment record — 17 September 2026

| | |
|---|---|
| Previous SHA | `6bf7bc12a5ed15df3abae5675ea3342fc58447ec` |
| Deployed SHA | `765c91859c4b2cdc6ff6ec6fcac20cf090bd3fd8` |
| Deployed at | 2026-09-17 08:41 UTC |
| Backup | `/home/ats/backups/pre-labelling-20260917-084019.dump` (44.4 MB, `pg_restore --list` parses it, 53 table-data entries) |
| Service | active, `/api/health` 200, `/api/health/ready` `{"ok":true,"ready":true}` |
| Errors in the log | 0 |

**Pre-deploy tree state.** Two untracked items were present and left alone:
`.config-baseline-20260910/` (an operator's config snapshot) and a 90-byte stub
`package-lock.json` at the repo root. No *tracked* file was modified, so the
reset could discard nothing.

**Protected counts across the deploy itself** — every one unchanged:
users 45, candidate 0, recruitment_request 1, application 0, interview 0,
offer 0, candidate_intake 127, mailbox_ingestion 1856, file_blob 129,
role_permission 244, microsoft_connection 1.

**Schema.** Five additive nullable columns created by `ensureSchema()` on boot;
zero destructive statements in the diff. No migration was run by hand.

## What the live tests produced

One real Site Engineer CV was parsed from the careers mailbox through the
production path. It became **CAN-00001 Hamada Said, Senior Project Engineer**,
classified `Construction / Engineering Core`, unflagged, intake CONVERTED, and
**no application**. That is the first candidate in the Talent Pool's history.

The 127-intake backlog was then reprocessed through `ingestIntake()` in batches
of 25 — normal business logic, no SQL shortcut, and **no re-parsing**, because
the parsed fields were already persisted (so the backlog run cost nothing in
model calls).

| | |
|---|---|
| Talent Pool | **136 candidates** (from 0) |
| Flagged | 21 — carrying Contact Missing, Unclassified, Incomplete Profile, Possible Duplicate, Needs Review |
| Unflagged | 115 |
| Intakes CONVERTED / DUPLICATE / PENDING | 136 / 6 / **4** |
| Remaining PENDING | exactly the 4 predicted `no-identity` hard exceptions |
| Applications / interviews / offers | **0 / 0 / 0** |
| Documents / proposals retained | 149 / audit intact |

Classification spread: Core 85, Support 20, Other Professional 14,
Unclassified 10, Adjacent 7.

**Idempotency** was proven without parsing: re-running `ingestIntake()` over
already-CONVERTED intakes resolved each as DUPLICATE against the person already
on file and created no candidate and no application.

## Operational note from this deployment

A verification script of mine passed `limit: 0` to `parseWaiting()` intending
"none". `Number(0) || 25` falls back to the default, so it parsed 15 real CVs
before it was stopped. The candidates it produced are legitimate — real CVs,
correctly ingested — and nothing was corrupted, but the run was unintended and
spent model budget.

`parseWaiting({ limit })` should treat 0 as zero, or reject it, rather than
silently meaning 25. Worth fixing before anyone else writes a batch script
against it.
