# Product excellence audit — issue #34

Date: 2026-09-26. Baseline: `5576d7aef3e54966c5be01e9df87a3656eec90ff`, verified against GitHub `main`. No open PRs returned at takeover. This is a source-level audit and planning milestone, not a claim that the live deployment or every screen has been tested.

## Product strategy

Make existing recruiting work dependable, contextual and visually consistent. Preserve the current Arabtec identity, approved HR rules and permission model. Codex owns inspection, implementation and targeted verification. Premium judgment is an optional, bounded review input, not the execution engine.

Choose a vertical polish pass through existing workflows. A CSS-only pass would miss misleading states and lost context; a frontend-v2 migration would multiply risk and cost. The selected approach improves the production UI in place and documents reusable seams without changing the runtime architecture.

### What already exists and must be reused

- Production hosting is `backend/src/server.js` serving `frontend/public`; on-prem deployment documentation confirms this. `frontend-v2` and the separate TypeScript API are not the target of this sprint.
- `frontend/public/app.jsx` already has role dashboards with record-specific actions, `PageHead`, `FilterToolbar`, `ViewToggle`, `CountPill`, `LoadError`, `RefetchError`, `Empty`, permission-gated navigation, pipeline transition guards and mobile chrome.
- The 14-page UI review and `claude-fable-enhanced-v2.html` are historical references. Several earlier gaps are already implemented. Do not recreate them or restore obsolete placeholder flows.
- Existing TypeScript modules already expose bounded interfaces. The production parser uses an adapter into that layer; this is evidence of gradual reuse, not evidence that the entire modular API serves production.

## Six findings

Line references below refer to the fixed baseline's `frontend/public/app.jsx`.

| ID | Current evidence and friction | Benchmark pattern and exact correction | Surface / reuse | Effort / impact |
|---|---|---|---|---|
| F1 | `useDashboardData` at 1954 catches request/interview failures as `null`, then converts them into empty lists. Recruiter action queues can look clear when a dependency failed. | Ashby Home groups actionable tasks. Keep existing actions, but distinguish unavailable sections from successful empty results; expose retry and retain successful sections. Do not invent missing counts. | Dashboard data hook and dependent panels; reusable loading-state contract. | S–M / High |
| F2 | `CandidateProfile` at 8615 has an uncaught initial load and no error state. `AssessmentPanel` at 6204 swallows metadata failure and can remain a skeleton indefinitely. | Structured hiring requires readable, available decision context. Use existing error/retry primitives; protect against late responses overwriting a newly selected record. | Candidate profile and assessment loader only; same state vocabulary. | S–M / High |
| F3 | Candidate profile shows identity and application count, but request/stage/recruiter context is in a separate tab. Application rows show request IDs as text, not navigation. Quick view identifies application number/stage but omits clear request title. | Lever distinguishes people from job opportunities; Ashby uses job-specific pipelines. Add a compact current-application summary and explicit authorized record links using data already returned. Keep person-level history separate from current application. | CandidateProfile, CandidateQuickView; small presentational context component. | M / High |
| F4 | `RequestPipeline` at 5635 retains selected IDs when filters hide rows. Bulk operation uses the entire selection; its destination list includes stages that may be ineligible and the UI gives no hidden/eligible count before submission. | Review workflows keep action scope understandable. Show selected/hidden/eligible counts and exact target stage before bulk mutation; require explicit acknowledgement when selected rows are hidden. Keep server revalidation and partial-result handling. | Request pipeline; presentation around existing transition helpers, no new stage rules. | M / High |
| F5 | Assessment section tabs show submitted checks, but candidate/request/evaluator context is distributed between the enclosing drawer and form. Source review identifies an opportunity; visual priority must be confirmed in a browser before editing. | Greenhouse and SmartRecruiters emphasize structured, owned feedback. Surface existing evaluator identity, section, draft/submitted state and saved outcome together. No new scoring, evaluator assignment, AI decision or approval policy. | AssessmentPanel/EvaluationForm only; sensitive-page review applies. | M / Medium–High |
| F6 | Shared header/filter primitives coexist with local variants, notably the raw pipeline toolbar. Six loaded CSS layers govern presentation; 9,359 lines of app JSX combine presentation and domains. This is maintenance risk, not proof that all pages look broken. | Benchmark workflows consistently expose context and actions. Apply existing primitives only to touched screens; amend the CSS layer owning the changed rule. Document boundaries rather than splitting the whole app or replacing its stylesheet stack. | Touched dashboard/candidate/pipeline/assessment surfaces; reusable UI and module extraction map. | S–M / Medium |

## Selected moves — maximum five

1. **M1: Honest loading and recovery** — F1 and F2, including candidate switching safety.
2. **M2: Candidate/application context** — F3, preserving one-active-request and scoped visibility rules.
3. **M3: Deliberate pipeline bulk actions** — F4, preserving existing transitions.
4. **M4: Assessment clarity** — F5, only after visual confirmation and with owner review before sensitive-page publication.
5. **M5: Consistency and extraction seams** — F6, limited to the touched surfaces, plus the module map.

Priority order is M1 → M3 → M2 → M4 → M5. Shared primitive reuse happens within each move; M5 is a final consistency check, not a redesign. Offers receive regression coverage only unless an actual regression requires correction. No new calendar integration, self-scheduling, CRM automation, billing, tenancy or drag-and-drop project.

## Benchmark sources

Public official documentation was reviewed on 2026-09-26. These are interaction principles, not a feature shopping list or hands-on vendor evaluation.

- [Ashby Home](https://docs.ashbyhq.com/home-page): task and interview context; informs F1.
- [Ashby Application Review](https://docs.ashbyhq.com/application-review): profile and bulk review; informs F3–F4.
- [Lever Applicant Pipeline](https://help.lever.co/s/article/Operating-the-Applicant-section-of-the-pipeline): opportunities associated with candidates; informs F3.
- [Greenhouse structured hiring guide](https://support.greenhouse.io/hc/en-us/articles/360039539772-Structured-hiring-guide): interview plans and scorecard expectations; informs F2/F5.
- [SmartRecruiters Hiring Success principles](https://www.smartrecruiters.com/resources/hiring-success-guide/hiring-success/principles-of-hiring-success/): evaluator alignment and structured reviews; informs F5.

## Evidence and limits

Read the production entry point, existing UI brief, full extracted PDF text, reference HTML, CSS load order, relevant frontend components, candidate/request routes, modular hiring facade and parser adapter. No production database was opened and no candidate records were mutated.

Baseline checks executed on the exact source snapshot: `node ui_compile_test.mjs` — 4 passed; `node ui_behavior_test.mjs` — 31 passed. These are source/runtime checks, not browser acceptance or a final regression pass. No product code changed at this milestone. Browser acceptance must use synthetic records at desktop and phone widths before a move is accepted.
