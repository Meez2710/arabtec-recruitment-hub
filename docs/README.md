# Arabtec Recruitment Hub — Technical Documentation

Living documentation set. Every document here is updated at the end of each
completed phase, per the project's four-condition definition of done:

> A feature is complete only when it is **(1)** implemented, **(2)** verified in
> the browser, **(3)** documented, and **(4)** committed to a stable branch.

**Current build:** `main` @ `2249fe3` — merged, verified statically, **not pushed**
**Current phase:** Phase 1 — Browser Verification (UAT)

---

## Document status

| # | Document | Status | Last updated |
|---|---|---|---|
| — | [Pre-Merge Snapshot](PRE_MERGE_SNAPSHOT.md) | ✅ Complete | 2026-07-27 |
| — | [Merge Report](MERGE_REPORT.md) | ✅ Complete | 2026-07-27 |
| — | [Browser Verification Checklist (UAT)](BROWSER_VERIFICATION_CHECKLIST.md) | ✅ Ready to execute | 2026-07-27 |
| — | [Parser Technical Specification](PARSER_TECHNICAL_SPECIFICATION.md) | ✅ Complete | 2026-07-27 |
| 1 | Architecture Overview | ⬜ Not started | — |
| 2 | Module Inventory | ⬜ Not started | — |
| 3 | Database Schema Summary | ⬜ Not started | — |
| 4 | API Inventory | ⬜ Not started | — |
| 5 | UI Screen Inventory | ⬜ Not started | — |
| 6 | Feature Matrix | ⬜ Not started | — |
| 7 | Configuration Guide | ⬜ Not started | — |
| 8 | Deployment Guide | ⬜ Not started | — |
| 9 | Production Readiness Report | ⬜ Not started | — |
| 10 | Known Limitations | ⬜ Not started | — |
| 11 | Technical Debt Register | 🟡 Seeded below | 2026-07-27 |
| 12 | Changelog | 🟡 Seeded below | 2026-07-27 |
| 13 | Future Roadmap | 🟡 Seeded below | 2026-07-27 |

Documents 1–10 are authored during Phase 1, informed by what UAT actually finds
— writing an Architecture Overview before the browser has confirmed the
architecture works would document an assumption rather than a system.

---

## Roadmap

| Phase | Contents | Status |
|---|---|---|
| **A** | Working tree protection, branch consolidation, merge verification | ✅ **Complete** |
| **1** | Browser Verification (UAT) → Production Hardening → Error Boundary → API Error Handling → Feature Exposure | 🟡 **Current** |
| **2** | Candidate Bulk Operations · Duplicate Resolution Center · Parsing Control Center | ⬜ Planned |
| **3** | Candidate 360 Workspace · Recruiter Productivity Enhancements | ⬜ Planned |
| **4** | Executive Analytics & Dashboards | ⬜ Planned |
| **5** | White-Label Preparation (HireBased SaaS) | ⬜ Planned |
| **6** | AI Talent Intelligence | ⬜ Planned |

**Gate:** no Phase 2 work begins until Phase 1 closes with zero S1/S2 defects
and documents 1–10 exist.

---

## Impact assessment requirement

Every task from this point begins with a written impact assessment, approved
before any code changes:

```
Objective
Scope
Files expected to change
Risk level                (Low / Medium / High)
Backward compatibility impact
Database impact
API impact
UI impact
Estimated effort
Rollback strategy
```

Template: [`IMPACT_ASSESSMENT_TEMPLATE.md`](IMPACT_ASSESSMENT_TEMPLATE.md)

---

## Changelog (seed)

### 2026-07-27 — Branch consolidation

**Merged into `main` (not pushed):**

- **Auth hardening** — 12-character password policy with all four character
  classes, name/email and deny-list checks; forced password rotation enforced in
  `requireAuth`; last-active-admin protection; role-escalation guard on
  governance permissions; `ChangePasswordForm`, `ForcedPasswordChange`,
  `Forbidden`, `PasswordRules` components.
- **CV parser rewrite** — 9 focused modules under `backend/src/lib/cv/`
  replacing the monolithic `cv-parser.js`, which is now a thin facade preserving
  all 7 original exports.
- **Structured persistence** — `cv-mapper.js` seam; `parse_status`,
  `parse_confidence`, `parsed_at` columns; 9 candidate indexes.
- **Talent Pool** — server-side pagination, whitelisted sorting, filter chips,
  sticky header, parse-quality badges.
- **Resume download** — authenticated blob fetch preserving the original filename.
- **Upload cap** raised 15 MB → 20 MB.
- **Responsive CSS** — sidebar rail below 1180px, pager stacking below 700px.

**Fixed:** candidate `resume_path` was not persisted on upload; cache-version
bumps were silent no-ops on the parser branch.

**Breaking:** `GET /api/candidates` returns `{ candidates, pagination }` instead
of a bare array. Sole consumer updated in the same commit.

---

## Technical Debt Register (seed)

| ID | Item | Severity | Origin | Notes |
|---|---|---|---|---|
| TD-01 | No React error boundary — any render error blanks the entire SPA | **High** | pre-existing | Phase 1 |
| TD-02 | 17 unguarded `api()` calls with no error handling | **High** | pre-existing | Phase 1 |
| TD-03 | Native `prompt()` used for user input (`app.jsx` ~line 3782) | Medium | pre-existing | Phase 1 |
| TD-04 | 19 CSS selectors redefined outside `@media`; correctness depends on source order | Medium | Stage 3B/3C | verified pre-existing on `e08bb82` |
| TD-05 | `app.jsx` is a single 4,690-line file compiled in-browser; no build step, no bundling, no tree-shaking | Medium | architectural | deliberate — revisit at Phase 5 |
| TD-06 | State-based routing, no URLs per page — no deep links, no browser back | Medium | architectural | revisit at Phase 3 |
| TD-07 | `render.yaml` has no `buildFilters`; frontend-only commits never auto-deploy | Medium | config | one-line fix, needs a deploy to validate |
| TD-08 | Index-creation block in `schema.js` leaves a trailing comment on the closing brace | Low | this merge | cosmetic |
| TD-09 | Permissions resolved from database rows, so runtime role edits can escalate privilege | Medium | architectural | mitigated by the governance guard, not eliminated |
| TD-10 | No automated test suite | **High** | pre-existing | UAT is currently the only gate |
| TD-11 | `master` branch is 37 commits behind and abandoned | Low | housekeeping | delete after push |

---

## Known Limitations (seed)

- **Parser is frozen** except for production-critical defects. Accuracy against
  real-world resumes is **unmeasured** — see the Parser Validation Report,
  pending ~30 real PDF/DOCX samples.
- **No AI parsing.** Gated off by four independent conditions and off by default.
- **Resume text is never stored.** Re-parsing always re-reads the original file.
- **No automated tests.** Every regression guarantee currently rests on manual UAT.
- **Single-tenant.** White-label/multi-tenant work is Phase 5.
