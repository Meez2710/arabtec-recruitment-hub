# Legacy Baseline Record

Reproducibility record for the pre-seam state, so the "no regression" claim does not depend
on a temporary `git stash` that no longer exists.

**This is not a parser accuracy baseline.** No accuracy has been measured — that requires
human ground-truth labels which do not exist yet. This records the **test-suite baseline**:
what passed and failed before the injection seam, so the same claim can be re-checked later.

Contains no CV content, no candidate data, no secrets.

---

## Environment

| | |
| --- | --- |
| Date measured | 2026-08-07 |
| Source commit | `1616dabcbdf8c967cccc95443753fd9f6312e945` (`1616dab`) |
| Branch | `feat/hiring-domain-core` |
| Node | v24.15.0 · npm 11.12.1 |
| OS | macOS 26.5.2, arm64 (Apple M1, 8 cores, 8 GB) |
| Database under test | PGlite (no `TEST_DATABASE_URL` / `DATABASE_URL` set) |

The baseline was produced by stashing only the three tracked files the seam touches —
`backend/src/routes/candidates.js`, `backend/src/server.js`, `backend/run_tests.mjs` —
restoring the working tree to `1616dab` for those paths. New untracked files were inert
because nothing imported them.

## Reproducing the baseline

```bash
git stash push -- backend/src/routes/candidates.js backend/src/server.js backend/run_tests.mjs
```

```bash
cd backend && for s in inproc_test.mjs phase3_test.mjs phase3_qa_test.mjs screening_test.mjs; do node --experimental-sqlite "$s"; done
```

```bash
git stash pop
```

## Results — identical before and after the seam

| Suite | Baseline (`1616dab`) | With seam | Delta |
| --- | --- | --- | --- |
| `inproc_test.mjs` | 14 passed, 13 failed | 14 passed, 13 failed | 0 |
| `phase3_test.mjs` | 27 passed, 6 failed | 27 passed, 6 failed | 0 |
| `phase3_qa_test.mjs` | 39 passed, 10 failed | 39 passed, 10 failed | 0 |
| `screening_test.mjs` | 8 passed, 2 failed | 8 passed, 2 failed | 0 |

TypeScript suite at baseline: **682 passed / 9 skipped (691)**.

## Known pre-existing failures — NOT caused by this work

31 failures across the four suites above exist at `1616dab` and are unrelated to CV parsing.
They are audit-trail assertions:

- `audit captured user.deactivated`, `audit captured project.created`,
  `audit captured branding.changed` (`inproc_test.mjs`)
- `audit has request.seat_filled`, `audit has candidate.note_added`,
  `audit has application.bulk_action` (`phase3_test.mjs`, `phase3_qa_test.mjs`)
- `audit row has actor/role/entity/old/new/timestamp` (`phase3_qa_test.mjs`)

**Tracked as pre-existing debt on this branch. Not in scope for the parsing migration**, and
deliberately not fixed here — repairing them inside this change would make the
zero-regression comparison unverifiable.

## Post-seam verification

| Check | Command | Result |
| --- | --- | --- |
| Typecheck | `npm run typecheck` | clean |
| TypeScript suite | `npx vitest run` | 779 passed / 9 skipped (788) |
| Seam suite | `node --experimental-sqlite parser_seam_test.mjs` | 9 passed / 0 failed |
| Legacy suites | as above | identical to baseline |

## Safe checksums

Source SHA-256 (first 16 hex) of the seam, so a later reader can confirm the reviewed
version:

| File | Digest |
| --- | --- |
| `backend/src/lib/parsing/registry.js` | `7ce1c472f905fc2f` |
| `backend/src/lib/parsing/legacy-provider.js` | `40df19633e939d96` |
| `backend/src/lib/parsing/composition.js` | `323aa35850ff5ef6` |

Pilot manifest checksum: `2d064f6c15ff2eadbb97dda53e496ae1d660ba86bddfeb2c6a8081e44a5526cf`
(the manifest itself stays under `backend/data/`, gitignored).

## What has NOT been measured

- Parser accuracy, for either pipeline — no ground-truth labels exist
- Docling or Ollama behaviour against a live service
- Any latency or memory figure on a deployment host
- Any acceptance criterion in [ACCEPTANCE_CRITERIA.md](docs/ACCEPTANCE_CRITERIA.md)
