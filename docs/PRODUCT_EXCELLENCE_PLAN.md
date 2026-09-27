# Product Excellence Implementation Plan

> **For agentic workers:** Execute natively in Codex using `superpowers:executing-plans`, task by task. Do not start autonomous premium implementation or rediscover the repository. Checkbox steps track work not yet completed.

**Goal:** Improve the existing Arabtec ATS through five bounded moves while preserving business behavior and Claude credit.

**Architecture:** Keep `frontend/public` and the current Express production server. Reuse existing components and interfaces; document current module seams and only extract a small presentational helper where the touched UI needs it. Do not migrate to `frontend-v2` or the separate modular API.

**Tech stack:** React with vendored Babel, CSS, Node 22.5–22.x, Express; existing SQLite/PostgreSQL paths and TypeScript modules remain in place.

**Spec:** `PRODUCT_EXCELLENCE_AUDIT.md`, issue #34 and `docs/ui-review/ATS_UI_ENHANCEMENT_BRIEF.md` for unchanged company-specific requirements.

## Global constraints

- Start implementation from freshly verified current `main`; the planning baseline is `5576d7aef3e54966c5be01e9df87a3656eec90ff`. If it moves, inspect only intervening changes and update the plan's affected assumptions. Never resume the old excellence/coherence branches.
- Five moves maximum. No rewrite, new dependency, schema migration, endpoint redesign, multi-tenancy, billing, pricing, new integration or speculative feature.
- Human hiring decisions remain human-controlled. Preserve transition rules, one-active-request rule, assessment criteria/weights, headcount rules, salary permissions, offer text and approval behavior.
- Keep Arabtec branding. Change an existing CSS owner layer; do not add a competing design system.
- Use synthetic local data with outbound email, mailbox sync and paid AI disabled. Do not run parsers or agentic AI simply to inspect a screen.
- Codex executes. Fable is optional and subject to `PREMIUM_WORKER_AND_CREDIT.md`. Unobservable or unbounded premium spend blocks dispatch.
- Targeted checks per move, then one final regression pass. Fix regressions in changed scope; do not chase every legacy test failure or repeat passing checks without a reason.
- Sensitive assessment/offer publication requires the review specified in the existing UI brief. Prepare a concrete diff and screenshots first. A plan does not approve new HR policy.

## Review focus

1. A failed request must not become a zero-work success state — M1 fault injection.
2. A late response for candidate A must not render after opening candidate B — M1 deferred responses.
3. Hidden selected applications must not move without clearly disclosed scope — M3 filtered selection scenario.
4. Archived applications and restricted salary fields must not become current/actionable or exposed — M2 fixtures.
5. Draft/submitted assessment state must remain faithful to server data and permissions — M4 fixtures and owner review.

## Execution ownership and milestones

Codex performs one move at a time in an isolated checkout, preserving a reviewable diff. Each milestone comment in #34 includes baseline/head, completed acceptance checks, files changed, observed evidence, remaining risk and actual premium credit observation if any. No automatic merge or deployment is included in this planning handoff.

Planning is complete when the audit, this plan, extraction map and premium ticket are published. Implementation is complete only when all accepted moves and the single final regression pass are evidenced. A deferred M4 must be explicitly reported, never called shipped.

### M1 — Honest loading and recovery

**Modify:** `frontend/public/app.jsx`: `useDashboardData`, dashboard consumers, `CandidateProfile`, `AssessmentPanel`; `backend/ui_behavior_test.mjs`.

**Interfaces:** Preserve existing API paths and returned domain payloads. Add `sectionErrors: { requests: string | null, interviews: string | null }` to the dashboard hook result; retain existing `err`, `loading`, `requests`, `interviews`, `d`, `reload`. Reuse `LoadError({text,onRetry})` and `RefetchError({text,onRetry})`. Candidate/assessment loading state remains local to those components.

- [ ] Add behavioral cases for failed requests with successful interviews, failed interviews with successful requests, initial candidate failure, metadata failure and candidate A/B out-of-order responses. Assert visible retry and absence of a false “nothing pending” conclusion for the failed section.
- [ ] Confirm those cases fail on the baseline for the intended reason.
- [ ] Keep independent dashboard results and expose per-section failure. Retain last successful data on refresh with a visible stale/error indication; never substitute an empty success for failure. Add guarded error/retry and request-generation cleanup to candidate/assessment reads.
- [ ] Run `node ui_behavior_test.mjs` and `node ui_compile_test.mjs` from `backend/`; all cases must pass.
- [ ] Browser-check first load, retry, partial failure and rapid candidate switch at 1440×900 and 390×844. No stuck skeleton, mismatched candidate or invented zero count. Keep draft inputs if a read refresh fails.
- [ ] Save an isolated diff and milestone evidence. Assessment loader changes belong to the sensitive-page review bundle before publication.

### M3 — Pipeline selection and action scope

**Modify:** `frontend/public/app.jsx`: `RequestPipeline`; existing UI CSS owner for toolbar/bulk panel; `backend/ui_behavior_test.mjs`.

**Interfaces:** Continue using `canPipelineMove`, `toApiStatus`, `/applications/bulk`, `r.affected` and `r.skipped`. Use controlled React state for the bulk destination instead of `document.getElementById('bulkStatus')`. No mutation contract changes.

- [ ] Add cases: select two rows then filter one out; mixed eligible/ineligible statuses; clear selection; failed bulk request; partial success; no bulk permission; double click during submission.
- [ ] Show total selected, hidden selected and eligible count for the chosen target. Disable execution when eligibility is zero. If any selected rows are hidden, show explicit confirmation with the total and hidden counts before sending. Never silently narrow or broaden selection.
- [ ] List only targets with at least one eligible selected application and retain existing reason requirements. The server remains authoritative; report moved/skipped results and reconcile once.
- [ ] Reuse `FilterToolbar` with existing inputs and `ViewToggle`; retain filter values across view changes and mobile disclosure. Wrap the bulk panel on phone widths without clipping controls.
- [ ] Run the two UI checks and exercise the scenario in a browser with synthetic records. Cancelled confirmation sends no mutation; accepted confirmation sends only eligible selected IDs.
- [ ] Record before/after action scope and changed files in #34.

### M2 — Candidate/application context

**Modify:** `frontend/public/app.jsx`: `CandidateProfile`, `CandidateQuickView`, existing navigation integration; relevant CSS owner; `backend/ui_behavior_test.mjs`. Read `backend/src/routes/candidates.js` and existing candidate list application semantics; do not change their policy.

**Interfaces:** Add a presentational `ApplicationContext({application,onOpenRequest})` in the existing frontend scope. Consume existing application IDs, request reference, position, status, recruiter and activity fields. Follow the actual candidate route DTO; do not infer IDs from display codes. Use `openRequest(id,onNavigate)` and existing interview/offer navigation only where already permission-authorized.

- [ ] Define fixtures for no applications, one active plus historical applications, missing optional fields, restricted salary and no request access. Reuse the production definition of an active application; do not invent a new terminal-status set.
- [ ] Show current request title/short code, application stage and recruiter in a compact context strip. History remains labeled history. If no active application exists, say so and keep existing authorized linking path.
- [ ] Add an explicit request link when a valid permitted request reference is available. Never display a dead button or fetch extra sensitive data to populate the strip. Keep CV and next-action entry points in the existing workflow.
- [ ] Check that history is never promoted to current context, request navigation uses the correct ID, and unauthorized links/values are absent. Run UI behavior/compile checks.
- [ ] Browser-check long titles/names, absent context and narrow layouts. Candidate identity and current application must be distinguishable before opening another tab.
- [ ] Record the resulting navigation and context improvement, without claiming a measured click reduction until observed.

### M4 — Assessment clarity, conditionally selected after visual confirmation

**Modify only if the gap remains visible:** `frontend/public/app.jsx`: `AssessmentPanel`, `EvaluationForm`, enclosing candidate context; relevant existing CSS; `backend/ui_behavior_test.mjs`.

**Interfaces:** Preserve `/assessments/meta`, `/assessments/application/:id` and current form payloads. Display evaluator/section/state fields only if present and authorized; missing evaluator becomes “Not recorded,” not a fabricated assignment.

- [ ] Capture the existing form with synthetic draft, submitted and read-only cases. If context is already clear, close this move as unnecessary rather than styling for its own sake.
- [ ] Make candidate/request, HR vs technical section, evaluator and draft/submitted state visible together; keep current notes, scores, critical flags and recommendation controls unchanged.
- [ ] Verify a submitted section stays submitted after refresh, read-only users cannot edit, draft failures retain entered values, and saved payloads/score calculations are unchanged.
- [ ] Run the focused UI checks; prepare desktop/phone before-and-after views and an exact payload comparison.
- [ ] Obtain owner review of this concrete sensitive-page change before publishing it, as required by the existing UI brief. Fable may critique presentation if its credit gate is satisfied, but cannot approve company HR rules.

### M5 — Consistency and modular seams

**Modify:** existing touched CSS rules; `frontend/public/app.jsx` only for duplicated presentation already changed by M1–M4; `docs/MODULE_EXTRACTION_MAP.md`. No wholesale app split or backend migration.

**Interfaces:** Keep `PageHead`, `FilterToolbar`, `ViewToggle`, `CountPill`, state components and status vocabularies as the shared UI surface. Preserve `applyBranding` and existing server configuration. The module map describes current runtime adapters separately from future modular facades.

- [ ] Check touched page headers, primary/secondary actions, filter density, labels, empty/error states and phone wrapping against current Arabtec tokens.
- [ ] Consolidate a repeated touched presentation fragment only when at least two actual consumers benefit. Keep domain status maps separate; similarly named request/application/offer statuses need not share meaning.
- [ ] Update the extraction map with actual touched seams, dependencies and company-specific exclusions. Mark boundaries documented versus code extracted truthfully.
- [ ] Run relevant existing toolbar/layout/responsive checks only for CSS actually changed, plus a browser check of touched screens. No new tests for cosmetic constants.
- [ ] Finish the single final regression below and publish the checkpoint report.

## One final regression pass

Use one synthetic request and candidate per role-sensitive case in an isolated local environment. Follow Hiring Request → Candidate → Pipeline → Interview/Assessment → Offer. Verify allowed transitions, required reasons, unchanged scoring/approval rules and role-scoped navigation for Recruitment Manager, Recruiter and Hiring Manager. Confirm restricted salary remains hidden and offer wording unchanged. Check touched screens on desktop and phone, keyboard focus and return navigation.

Run UI compile/behavior checks once on the final diff, plus existing focused permission/workflow tests corresponding to changed logic. No full backend suite by default. Run typecheck/build only if TypeScript changes occur; the production JSX has its own compile check. Any blocked browser/database checks must be explicitly reported, not counted as passed.

## Stop and rollback

Stop premium execution at or before the $50 cumulative gate; owner review is mandatory before any additional premium spend. Stop the affected change if it needs new HR rules, offer wording, wider permissions or broad architectural work. Keep unrelated accepted work reviewable. Revert the offending isolated move rather than resetting shared work or rewriting `main`.

Checkpoint report: shipped changes; why each is better; modularity actually achieved; evidence actually collected; maximum five remaining gaps; actual credit observation and any uncertainty.
