# Merge Report — Branch Consolidation

**Date:** 2026-07-27
**Result:** ✅ Complete — all eight verification gates passed
**Pushed:** ❌ **No.** `main` is 5 commits ahead of `origin/main`, local only.

---

## 1. What was merged

| Step | Action | Outcome |
|---|---|---|
| 1 | Amend auth commit title | `d457322` → `cf1d0d0` |
| 2 | Merge auth into `main` | `c357866` — clean, no conflicts |
| 3 | Merge parser into `main` | `4d77183` — 2 conflicts, resolved |
| 4 | Commit pre-merge snapshot | `2249fe3` |
| 5 | Delete empty responsive branch | deleted (was `e08bb82`) |

```
* 2249fe3 (main) docs: pre-merge snapshot as rollback reference
*   4d77183 Merge branch 'feature/cv-parsing-engine' into main
|\
| * e1ee1c9 feat(cv): modular parser, structured persistence, stabilization fixes
* |   c357866 Merge branch 'feature/auth-user-security-system' into main
|\ \
| |/
|/|
| * cf1d0d0 fix(auth): password policy, rotation gate, governance guards + responsive shell CSS
|/
* e08bb82 (origin/main) fix: make user password create/reset usable from the UI
```

**Combined change vs. `origin/main`:** 24 files, **+2,478 / −273**.

### Commit message correction

`d457322` was titled as an auth-only change but also contained responsive and
app-shell CSS — the result of authoring those edits in the working tree and then
switching branches, which carried them along. The commit body now records this
explicitly, and `feature/responsive-mobile-tablet-ui` (which was empty as a
consequence) has been deleted. The history no longer misrepresents its contents.

## 2. Conflict resolution — as predicted, both trivial

Auto-merge succeeded on `backend/src/lib/models.js` and
`frontend/public/app.jsx`. The zero-overlapping-hunks prediction held: the two
branches touch disjoint regions of a 4,690-line file.

### `frontend/public/index.html` — 2 conflicts

Both branches bumped the cache token from the same base.

| | Value |
|---|---|
| base `e08bb82` | `v=20260726k` |
| auth `cf1d0d0` | `v=20260727b` |
| parser `e1ee1c9` | `v=20260727d` |
| **resolved** | **`v=20260727e`** |

Resolved to a **new, higher token** rather than either side. The merged artefact
is not byte-identical to either branch, so it needs its own cache identity —
taking `20260727d` would let a browser that had already fetched the parser
branch serve a stale hybrid.

### `frontend/public/styles.css` — 1 conflict

Both branches appended a block at end-of-file, and both blocks opened with the
same shared `/* ===` comment line, so git could not separate them.

**Resolved by keeping both**, auth's block first, with a fresh comment opener
inserted before the parser block. Without that inserted opener the parser
block's header text would have been orphaned outside a comment — valid CSS by
luck, but the header line would have been parsed as a selector.

Final: 1,050 lines. Zero conflict markers remain anywhere in the tree.

## 3. Verification gates

| # | Gate | Method | Result |
|---|---|---|---|
| 1 | Backend syntax | `node --check` on every file under `backend/src` | ✅ 0 failures |
| 2 | Module graph loads | Real ESM import of parser, mapper, passwords, schema | ✅ all resolve |
| 3 | Public API preserved | `cv-parser.js` exports | ✅ all 7 original exports intact, 4 added |
| 4 | **Frontend compiles** | `app.jsx` transformed by **the same `vendor/babel.min.js` the browser uses** | ✅ 4,690 lines → 377,098 chars |
| 5 | No merge artefacts | grep for conflict markers across js/jsx/css/html/json | ✅ clean |
| 6 | **No duplicated CSS** | selector-occurrence analysis, `@media`-aware | ✅ **zero new duplication** |
| 7 | **Cache versioning** | both assets carry the same new token | ✅ `?v=20260727e` |
| 8 | **Migrations idempotent** | pre-merge schema → merged schema → merged schema again, isolated temp DB | ✅ no error on any pass |

### Gate 4 detail

This is the gate that matters most. There is no build step — `app.jsx` is
compiled in the browser by Babel-standalone, so a syntax error produces a blank
page with no server-side warning. Compiling with the exact vendored Babel binary
gives the same answer the browser will.

### Gate 6 detail

19 selectors are defined more than once outside any `@media` block (`.card`,
`.toolbar`, `.page-head`, `.ticket-header-card`, `.pcard`, and others). **All 19
already exist on `e08bb82`** — verified by running the same analysis against
`main`'s `styles.css`. Every duplicate pair sits below line 888; the merged
blocks begin at line 939. **The merge introduced none of them.**

They are pre-existing overrides from the Stage 3B/3C visual rebuild — legitimate
but fragile, since correctness depends on source order. Logged as technical debt.

`.card.flush` was the specific risk flagged in the conflict preview. Confirmed
clean: the `overflow-x: auto; overflow-y: hidden` correction appears exactly
once, at line 698.

### Gate 8 detail

Run against an isolated temp database at `/tmp/idem/a.db`. **No developer
database was read or written.**

The upgrade path was tested properly — not just a fresh install. `main`'s
pre-merge `schema.js` was extracted from git, applied first to build a
production-shaped database, and only then was the merged schema applied on top,
twice.

Post-conditions verified:

- `parse_status`, `parse_confidence`, `parsed_at` all added ✅
- `resume_text` **absent** ✅ (the approved design decision holds)
- all 9 `idx_candidate_*` indexes present ✅
- 0 duplicate indexes after three runs ✅

### Additional check — live boot

Server booted on an isolated temp database (port 4599): seed completed, and

| Probe | Status |
|---|---|
| `GET /` | 200 |
| `GET /api/health` | 200 |
| `GET /api/candidates` unauthenticated | **401** ✅ |
| `GET /app.jsx` | 200 |

AI gate confirmed off by default:
`{"envEnabled":false,"flagEnabled":false,"hasKey":false,"callerOptIn":false,"allowed":false}`

Upload cap confirmed at 20 MB.

## 4. Incident during execution

The first git write failed: a stale `.git/index.lock`, left by the commit that
was interrupted when the previous session ran out of context. The sandbox mount
refused to unlink it, which blocked **every** git write operation. Cleared by
requesting delete permission for the folder. No data was affected — the lock was
a zero-byte file and `e1ee1c9` had already been written successfully.

## 5. What has NOT been verified

**Nothing in this report is browser evidence.** Every gate above is static or
server-side. Specifically unverified:

- the forced-password-change screen has **never rendered in a browser**
- the Talent Pool's new pagination response shape has never been consumed by a real browser
- the responsive breakpoints at 1180px and 700px have never been seen
- resume download has never been exercised through a real click

That is what `docs/BROWSER_VERIFICATION_CHECKLIST.md` exists to establish.

## 6. Rollback

Unchanged from the pre-merge snapshot and still trivial, since nothing was
pushed:

```bash
git checkout main && git reset --hard e08bb82
```

Both feature branches survive the merge intact (`cf1d0d0`, `e1ee1c9`).

## 7. Current state

| Branch | Hash | Status |
|---|---|---|
| `main` | `2249fe3` | **ahead 5, not pushed** |
| `origin/main` | `e08bb82` | unchanged — production reference |
| `feature/auth-user-security-system` | `cf1d0d0` | retained |
| `feature/cv-parsing-engine` | `e1ee1c9` | retained |
| `feature/responsive-mobile-tablet-ui` | — | deleted (was empty) |

**Push gate:** blocked until the Browser Verification Checklist is executed with
zero S1/S2 defects. `render.yaml` has `autoDeploy: true` and this merge contains
backend changes, so a push **will** deploy.
