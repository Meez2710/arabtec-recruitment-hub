# Phase E — Production Validation Report

**Build:** `main` @ `16b41f3` · **Date:** 2026-07-27
**Verdict: 🔴 NO-GO — 1 new S2 defect, and Part 1 could not be executed**

---

## Executive summary

Two things happened in this phase.

**One: Part 1 could not be run.** The Chrome extension is not connected
(`list_connected_browsers` returns empty). No browser interaction was possible —
no clicking, no screenshots, no console, no viewport resizing. Every item in
Part 1 remains **unverified**. This is the third consecutive phase blocked on the
same dependency.

**Two: measuring instead of estimating found a defect that four phases of
testing had missed.** PDF text extraction is **completely non-functional** in
this environment. Every PDF silently parses to an empty string. Prior phases used
a `.txt` fixture, so it was never exposed.

Performance, by contrast, is excellent and is **not** a blocker.

---

# Part 1 — Browser UAT: ❌ NOT EXECUTED

| Module | Status |
|---|---|
| Login · Forced Password Change · Dashboard · Talent Pool · Candidate Profile · Resume Upload/Download/Re-Parse · Search · Filtering · Sorting · Pagination · Recruiter Workflow · Interview Workflow · Offer Workflow · User Management · Settings · Feature Flags · Responsive (Desktop/Tablet/Mobile) | **All unverified — no browser available** |

Server-side equivalents were verified in Phases 1–2 (94 checks, 93 pass), but as
required: *"No assumptions. No static analysis. Only browser-confirmed
behavior."* By that standard **zero** of Part 1 is complete.

`docs/BROWSER_VERIFICATION_CHECKLIST.md` (~230 checks) is ready for a human
executor. Estimated effort: **6–8 hours** for one tester.

---

# Part 2 — Performance Validation ✅ (measured)

Environment: 4 vCPU, 3.9 GB RAM, Node 22, SQLite, local loopback.
Network latency excluded — figures are server-side processing cost.

## 2.1 Upload by file size

| File | HTTP | Total ms | Throughput | Server RSS |
|---|---|---|---|---|
| 1 MB | 201 | **69 ms** | 14 MB/s | 92.8 MB |
| 5 MB | 201 | **91 ms** | 55 MB/s | 120.2 MB |
| 10 MB | 201 | **124 ms** | 80 MB/s | 120.0 MB |
| **20 MB** | **413** ❌ | 12 ms | — | 120.2 MB |
| 21 MB | 413 ✅ | 30 ms | — | — |

**Upload performance is excellent.** 10 MB in 124 ms; throughput improves with
size (fixed overhead amortises). Memory rises from a 79.5 MB baseline to ~120 MB
and then **stays flat** across 5, 10 and 20 MB — no leak, no size-proportional
growth.

**But a 20.000 MB file is rejected.** See defect **D-08**.

## 2.2 Parse duration — ⚠️ NOT MEASURABLE

The whole point of this measurement was the risk I flagged in Phase 2: *"a 20 MB
PDF now parses inside the upload request; response time under that load is
unmeasured."*

**It still is** — because PDF parsing fails instantly (D-09). Every PDF returns
empty in ~13 ms, which is failure time, not parse time. The 69–124 ms figures
above are **upload and storage only**.

Once D-09 is fixed, these benchmarks must be re-run. Real PDF parsing will add
meaningful CPU time inside the request, and the risk is unquantified.

DOCX parsing, which works, completes in **~20 ms** for a 1 KB file.

## 2.3 Large Talent Pool — 5,004 candidates

| Scenario | p50 | min | max |
|---|---|---|---|
| First page (25) | **3.5 ms** | 2.8 | 4.6 |
| Deep page 100 | **3.4 ms** | 3.2 | 5.0 |
| Deep page 200 (last) | **3.6 ms** | 3.5 | 4.1 |
| Large page size (200) | 12.3 ms | 11.4 | 14.6 |
| Sort by name | 3.1 ms | 2.6 | 3.4 |
| Sort by confidence | 3.8 ms | 3.6 | 4.3 |
| Sort by experience | 2.6 ms | 2.5 | 6.9 |
| Broad search (5,000 hits) | 2.6 ms | 2.6 | 3.0 |
| Narrow search (1 hit) | 2.7 ms | 2.5 | 3.0 |
| No-match search | 2.6 ms | 2.6 | 6.2 |
| Filter by company | 2.6 ms | 2.6 | 3.1 |
| Filter by university | 3.3 ms | 3.1 | 4.3 |

**No deep-pagination penalty.** Page 200 costs the same as page 1 (3.6 vs
3.5 ms) — the nine indexes added during the parser phase are doing their job. A
classic `OFFSET` scan would have degraded visibly by page 200.

## 2.4 Concurrent recruiters

| Concurrent | Requests | Wall | p50 | p95 | max | Throughput | Errors |
|---|---|---|---|---|---|---|---|
| 1 | 10 | 0.05 s | 4.0 ms | 5.3 ms | 7.6 ms | 207/s | 0 |
| 5 | 50 | 0.14 s | 14.3 ms | 16.5 ms | 17.4 ms | 345/s | 0 |
| 10 | 100 | 0.35 s | 32.1 ms | 49.0 ms | 51.3 ms | 285/s | 0 |
| 20 | 200 | 0.44 s | 55.2 ms | 68.4 ms | 73.8 ms | **457/s** | 0 |

Latency scales linearly with concurrency (single-threaded Node, as expected), but
**p95 stays under 70 ms at 20 concurrent users** and throughput keeps climbing.
Zero errors, zero timeouts.

For context: Arabtec's recruiting team is far smaller than 20 simultaneous
active users. **Headroom is ample.**

## 2.5 Bottleneck analysis

| Area | Finding | Action |
|---|---|---|
| Talent Pool queries | 2.6–12.3 ms at 5,000 records | **None — do not optimise** |
| Pagination | flat to page 200 | **None** |
| Upload path | 80 MB/s at 10 MB | **None** |
| Memory | flat at ~120 MB | **None** |
| Concurrency | p95 < 70 ms at 20 users | **None** |
| **PDF parsing** | **broken — unmeasurable** | **Fix D-09, then re-benchmark** |

**No optimisation is recommended.** Every measurement is comfortably inside
acceptable limits, and recommending changes without measurements supporting them
would be exactly what this phase was designed to avoid.

---

# Part 3 — Talent Pool Operational Validation ⚠️ PARTIAL

Search, filter, sort, pagination and parse-quality data are **verified at the API
layer** and are fast. But click-counting, view switching, timeline review, and
"return to previous search without losing filters" are **browser-only
observations**. They cannot be assessed without a browser, and I will not infer
them from source.

One item can be stated from the API contract: filter state lives in React
component state with no URL representation (TD-06). A full page reload therefore
loses all filters. **Whether in-app back-navigation preserves them requires
browser confirmation.**

---

# Part 4 — User Management Validation ✅ (server-side)

All verified in Phases 1–2 and re-confirmed:

| Workflow | Result |
|---|---|
| Create user | ✅ 201, temporary password returned once |
| Temporary password authenticates | ✅ |
| Force password change | ✅ flag set; blocks all four protected routes |
| Rotation completes; gate lifts | ✅ |
| Assign roles | ✅ |
| Create with no roles | ✅ now rejected (D-05 fix) |
| Duplicate email | ✅ 409 |
| Weak password | ✅ 400, all five probes |
| Deactivate / activate | ✅ |
| Reset password | ✅ |
| Last-admin protection (demote) | ✅ 409 |
| Session — forged token | ✅ 401 |
| Session — unauthenticated | ✅ 401 on all six endpoints |

**Privilege escalation: none found.**

- HR Manager cannot create or list users (403) even by direct API call
- HR Manager cannot grant `user.manage` to any role (403)
- `PUT {active:false}` cannot bypass the deactivate guard — confirmed by re-read
- Permission matrix no longer readable by non-admins (D-04 fix)

**Caveat:** the UI layer of these workflows is unverified. Every result above is
API-level.

---

# Part 5 — Production Deployment Validation

| Item | Status | Notes |
|---|---|---|
| Environment variables | ✅ | `DATABASE_URL`, `PORT`, `SEED_ADMIN_PASSWORD`, `BCRYPT_ROUNDS`, `CV_AI_PARSING_ENABLED` (default false), `ANTHROPIC_API_KEY` (optional). No secrets in git. |
| Database migrations | ✅ | Idempotent across 3 consecutive runs; upgrade path from pre-merge schema verified |
| File uploads | ⚠️ | Works; 20 MB boundary defect (D-08) |
| Resume storage | ✅ | Stored file is source of truth; `resume_path` persists; download authenticated (401 without token) |
| File retention | ✅ | Retained until candidate deletion, per approved policy |
| Logging | ⚠️ | Server log clean under load — but **`catch { return '' }` in the extractor hides total parser failure** (root cause of D-09 going undetected) |
| Error handling | ⚠️ | API-level solid (404/400/413/403/401 all correct). **No React error boundary (TD-01)** — unverified in browser |
| Recovery from failures | ✅ | Parse failure no longer costs the upload; 21 MB rejected cleanly; zero-byte handled |
| Backup strategy | ⚠️ | `docs/BACKUP_AND_RESTORE.md` exists but has **not been rehearsed** this phase |
| Rollback strategy | ✅ | Nothing pushed; `git reset --hard e08bb82` restores. Migrations additive — no down-migration needed |

## Blocking conditions

| Requirement | Status |
|---|---|
| Zero unresolved S1 | ✅ **Met** |
| Zero unresolved S2 | ❌ **NOT met — D-09 open** |

---

# New defects

## D-08 — A 20 MB file is rejected by the 20 MB cap (S3)

**Measured:** a file of exactly 20.000 MB → **HTTP 413**. 21 MB → 413 (correct).
10 MB → 201.

**Root cause:** `MAX_BYTES` in `upload.js` is applied to the **entire request
body**, not the file. The multipart envelope (boundary, headers, terminator) adds
a few hundred bytes, pushing a 20.000 MB file over a 20,971,520-byte limit.

**Impact:** the UI advertises a 20 MB limit; a genuinely 20 MB CV fails with a
confusing error. Effective usable limit is ~19.99 MB.

**Recommended fix:** apply the cap to the extracted file part rather than the
request, or raise the request cap to `MAX_BYTES + 64 KB` envelope allowance.
One-line change, low risk.

## D-09 — PDF text extraction is completely non-functional (S2) 🔴

**Measured:** a valid, text-bearing PDF → `extractTextAsync()` returns **0
characters**. Every PDF field is `NULL` after upload.

**Root cause — precisely identified:**

```
ReferenceError: DOMMatrix is not defined
Warning: Cannot load "@napi-rs/canvas" package: "Error: Failed to load native binding".
```

`pdf-parse@2.4.5` depends on `@napi-rs/canvas@0.1.80`, which supplies the DOM
polyfills `pdfjs-dist` needs. The only native binding installed is
**`@napi-rs/canvas-darwin-arm64`** — a macOS Apple Silicon binary. `node_modules`
was installed on a Mac. On Linux there is no matching binding, the native load
fails, and `getText()` throws.

**Why it went undetected for four phases:** `extractor.js` wraps every path in
`catch { return ''; }`. A total library failure is indistinguishable from an
empty CV. Nothing is logged. `parse_status` is still written, so the system
reports success.

**Isolation performed:**

| Test | Result |
|---|---|
| `pdf-parse` called directly | ❌ throws `DOMMatrix is not defined` |
| `extractTextAsync()` on PDF | ❌ returns `''` silently |
| **DOCX via mammoth** | ✅ **290 chars extracted** |
| **DOCX full entity parse** | ✅ name, phone `+201005551234`, company `Arabtec Construction LLC`, university `Cairo University` — all correct |

**The parser pipeline is sound.** Only the PDF extraction layer is broken.

**Will this happen on Render?** **Unknown — and that is the problem.** Render runs
`npm install` on Linux x64 at build time, which *should* fetch
`@napi-rs/canvas-linux-x64-gnu`. Two reasons that is not sufficient:

1. **Unproven.** PDF parsing has never been verified working anywhere. I could
   not install the Linux binding here (npm registry blocked: HTTP 403), so I
   cannot demonstrate the code path succeeds even once.
2. **Silent failure is the real defect.** If the binding fails to load in
   production for any reason — musl vs glibc, ARM instance, missing shared
   library, install-time network failure — every PDF parses to empty with **no
   error, no log, no alert**. Recruiters would see candidates silently arriving
   with blank fields. PDFs are the dominant CV format.

**Recommended fix (two parts):**

1. **Make the failure loud.** Log the caught exception in `pdfText()`, and mark
   `parse_status: 'failed'` when extraction yields zero characters from a
   non-empty file. Never let a library failure look like an empty CV.
2. **Prove it works on the deployment target.** Deploy to a Render preview and
   upload a real PDF, or add a startup self-check that parses a bundled fixture
   PDF and logs a clear warning if extraction returns empty.

Also: add `@napi-rs/canvas` as an explicit dependency so the platform binding is
resolved deterministically rather than transitively.

---

# Remaining known issues

| ID | Severity | Status |
|---|---|---|
| **D-09** PDF extraction non-functional | **S2** | 🔴 **Open — blocks release** |
| D-08 20 MB boundary | S3 | Open |
| D-07 ~35 routes need authorization triage | S3 | Deferred |
| TD-01 No React error boundary | High | Open |
| TD-02 17 unguarded `api()` calls | High | Open |
| TD-03 Native `prompt()` | Medium | Open |
| TD-06 No URL routing — reload loses filters | Medium | Open |
| TD-10 No automated test suite | High | Open |
| **Part 1 browser UAT** | — | 🔴 **Not executed** |
| Parser accuracy on ~30 real CVs | — | Never measured |
| Backup/restore rehearsal | — | Not performed |

---

# Final Production Readiness Score

| Dimension | Weight | Score | Weighted |
|---|---|---|---|
| Functional correctness (API) | 20 | 18/20 | 18 |
| **Browser-verified behaviour** | **25** | **0/25** | **0** |
| Security & authorization | 15 | 13/15 | 13 |
| **Performance** | **15** | **14/15** | **14** |
| Data integrity & migrations | 10 | 10/10 | 10 |
| **Core feature reliability (parsing)** | **10** | **2/10** | **2** |
| Operational readiness | 5 | 3/5 | 3 |
| **Total** | **100** | | **60/100** |

**Down from 74.** Not because the build got worse — because measuring replaced
assuming, and it found a broken core feature. A lower, accurate score is worth
more than a higher, unfounded one.

---

# Go / No-Go: 🔴 **NO-GO**

Threshold is ≥ 90/100 with zero S1/S2. Current: **60/100 with one open S2.**

## What prevents release

| # | Blocker | Severity | Effort |
|---|---|---|---|
| 1 | **D-09 PDF extraction** — verify on Linux + make failure loud | S2 | **4–6 h** |
| 2 | **Part 1 browser UAT** — ~230 checks | — | **6–8 h** |
| 3 | Defects found by that UAT | unknown | **4–16 h** |
| 4 | D-08 20 MB boundary | S3 | **0.5 h** |
| 5 | TD-01 error boundary | High | **2–3 h** |
| 6 | Re-run benchmarks once PDFs parse | — | **1 h** |

**Total to reach ≥ 90: roughly 18–35 hours**, dominated by the browser UAT and
whatever it uncovers.

## Recommended order

1. **Fix D-09 first.** Until PDFs parse, the browser UAT would validate a
   half-working product and need re-running.
2. Fix D-08 and TD-01 in the same pass — both are small.
3. Re-run performance benchmarks with working PDF parsing.
4. Execute the browser UAT.
5. Triage and fix what it finds.
6. Re-score.

## The one thing to take from this phase

Four phases of testing reported PDF parsing as working. It never was. The
`.txt` fixture and the `catch { return '' }` between them produced a system that
*reported success while doing nothing*.

That pattern — a silent catch masking a hard failure — is more dangerous than the
missing binding, and it is worth auditing for elsewhere in the codebase before
release.

**Do not begin SaaS transformation.** This phase has not passed.
