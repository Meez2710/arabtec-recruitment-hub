# Impact Assessment — <task name>

**Date:** YYYY-MM-DD · **Author:** · **Phase:** · **Status:** Draft / Approved / Rejected

> Complete and get approval **before** any code changes.

---

## Objective

One paragraph. What problem does this solve, and how will we know it is solved?

## Scope

**In scope**

-

**Out of scope** *(state explicitly — this is what prevents drift)*

-

## Files expected to change

| File | Change type | Why |
|---|---|---|
| | new / modify / delete | |

Anything not listed here is a scope change and needs re-approval.

## Risk level

**Low / Medium / High**

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| | | | |

Rules of thumb for this codebase:

- Any change to `app.jsx` is **at least Medium** — it is compiled in-browser, so
  a syntax error blanks the entire application.
- Any change to `requireAuth` or permission resolution is **High**.
- Any change to a response shape is **High** unless every consumer is updated in
  the same commit.

## Backward compatibility impact

- Response shapes changed: ☐ none ☐ yes → list them and name every consumer
- Existing data still readable: ☐ yes ☐ no → migration plan required
- Breaking change: ☐ no ☐ yes → justify

## Database impact

- Schema change: ☐ none ☐ additive ☐ destructive
- Columns/indexes added:
- Migration idempotent on re-run: ☐ verified ☐ n/a
- Tested against a database created by the **previous** schema: ☐ yes ☐ n/a
- Down-migration: ☐ not needed (additive) ☐ provided

**Destructive migrations require explicit written approval.**

## API impact

| Endpoint | Change | Breaking? |
|---|---|---|
| | | |

New endpoints, changed status codes, new failure modes — all listed.

## UI impact

- Screens affected:
- New components:
- New states (loading / empty / error / forbidden):
- Responsive impact at 1180px and 700px:
- Cache token bump required: ☐ yes ☐ no

## Estimated effort

| Activity | Estimate |
|---|---|
| Implementation | |
| Browser verification | |
| Documentation | |
| **Total** | |

## Rollback strategy

- Revert commit: `git revert <hash>`
- Database rollback needed: ☐ no ☐ yes → describe
- Can this be rolled back **after** a deploy without data loss? ☐ yes ☐ no
- Feature-flagged: ☐ yes ☐ no

## Verification plan

How this will be proven in the browser, referencing the sections of
`BROWSER_VERIFICATION_CHECKLIST.md` that must be re-run.

| Check | Expected result |
|---|---|
| | |

## Documentation to update

☐ Architecture Overview ☐ Module Inventory ☐ Database Schema Summary
☐ API Inventory ☐ UI Screen Inventory ☐ Feature Matrix
☐ Configuration Guide ☐ Deployment Guide ☐ Known Limitations
☐ Technical Debt Register ☐ Changelog ☐ Browser Verification Checklist

---

## Approval

| | Name | Date | Decision |
|---|---|---|---|
| Requested by | | | |
| Approved by | | | ☐ Approved ☐ Approved with conditions ☐ Rejected |

**Conditions:**
