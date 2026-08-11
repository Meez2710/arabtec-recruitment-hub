# ARABTEC ATS — SESSION HANDOFF

**Written:** 2026-08-03
**Branch:** `feat/hiring-domain-core`
**Commit state:** ⚠️ **NOTHING IS COMMITTED.** All work is uncommitted on the branch.
**Last commit on branch:** `1616dab fix(cv): preserve line structure in pdfjs text extraction` (inherited from `main`; not ours)

---

## 0. READ THIS FIRST

If you are a new session picking this up, these are the rules that are easy to violate and expensive to undo:

1. **Do not commit anything.** The user has said, every single turn, "keep everything uncommitted until I explicitly ask." They have never asked. Do not commit, do not push, do not `git add`.
2. **The Business Layer is frozen.** `backend/src/modules/**` is approved and signed off. If infrastructure work appears to require a business-layer change, **stop and explain the trade-offs before changing anything**. This is a standing instruction from the user, repeated across multiple turns.
3. **Never introduce business assumptions.** The user has explicitly rejected two inferred rules already (a salary formula, an auto-transition on assessment). Anything derived from a document is labelled **OBSERVED**; it becomes a **RULE** only with explicit user approval. Where a rule is needed but undefined, make it configurable and empty — do not fill in a plausible default.
4. **No business logic in repositories or Drizzle.** Repositories are persistence only. Schema files contain table definitions, not rules.
5. **Do not touch the UI.** The final UI will arrive as a separate Lovable project. Backend is the source of truth; the UI adapts to it. Never change business logic to satisfy a UI.
6. **Shell gotcha:** the Bash tool's working directory resets between calls in this environment. Always begin a command with `cd /Users/moutazadly/Downloads/arabtec-recruitment-hub/backend || exit 1`. Two commands failed in-session because of this, and one of them installed a wrong `tsc` package into the npx cache (harmless; `package.json` unaffected).
7. **Import convention:** all TypeScript imports use `.js` extensions (ESM-correct for compiled output). This is why `node --experimental-strip-types` cannot run the sources directly and `tsx` is used instead.

---

## 1. CURRENT PROJECT STATUS

The project is a rescue-and-rebuild of a **live, single-tenant Applicant Tracking System** in production use by Arabtec HR (Egypt). Three enterprise audits were completed, the architecture was redesigned across eight locked documents, and a new backend is being built alongside the legacy system using a strangler-fig approach.

### Where we are

| Layer | Status |
|---|---|
| Audits (3 planned, 2 executed) | Architecture ✅ · Business Logic ✅ · Security ⏭️ **skipped by user decision** |
| Architecture design (Documents 1, 2 Parts I–VIII) | ✅ Locked and approved |
| Domain layer | ✅ Complete, approved |
| Application layer | ✅ Complete, approved |
| Domain stabilization (Phase 2.5) | ✅ Complete, approved |
| Infrastructure design (Phase 2.6) | ✅ Delivered (chat only, not saved to a file) |
| Infrastructure implementation (Phase 3) | ✅ **All 12 steps complete**, pending review |
| AI foundation | ⬜ Not started (blocked until infrastructure completes) |
| AI features | ⬜ Not started |
| API layer + composition root | ✅ Complete, approved |
| Read layer (CQRS read side) | ✅ Complete |
| AI ports (interfaces only, no adapter) | ✅ Complete — `modules/shared/kernel/ai/` |
| Talent/Candidate context | ✅ Complete — manual CRUD, documents, proposals, provenance, full read side |
| Smart Search | ✅ Complete — `GET /search`, full-text + ILIKE fallback, optional skill expansion |
| Candidate Matching | ✅ Complete — `modules/matching`, advisory suggestions, human dismiss/link via Hiring gateway |
| Intake read model | ✅ Complete — list/detail, progress, live parse status, proposal summary |
| Bulk CV Upload | ✅ Complete — staging intake (`cv_intake_batch`/`item`), multipart, reuses the parse pipeline; Candidate invariants unchanged |
| Candidate Parsing | ✅ Complete — `ai_task` + dispatcher + worker, transactional submission, permanence-aware abstention, full generation provenance. No model adapter (AI phase) |
| UI | ⬜ Not started; will come from Lovable |

### Metrics at handoff

```
Tests                        691  (682 pass on PGlite, 9 skip)
Test files                    32
Typecheck                     clean (tsc --noEmit)
Coverage (all files)      95.95% statements · 89.83% branches · 94.87% functions

ADRs                          11   (an ADR for the shared-kernel extraction is still owed — it would be 0012)
Physical schema               13 tables · 8 enums · 38 indexes · 9 FKs · 8 CHECKs
Migrations                     8   (0002 Talent, 0003 ai_task, 0004 proposal generation, 0005 cv intake, 0006 candidate match, 0007 candidate search)
Repositories                   4   Drizzle adapters + 3 Units of Work
Outbox + event bus            transactional outbox, post-commit relay, polling dispatcher, idempotent fan-out
Integration harness           PGlite by default; REAL PostgreSQL when TEST_DATABASE_URL is set
```

### The legacy system

Still running, untouched, in `backend/src/lib/**` and `backend/src/routes/**` (JavaScript). It serves production today. It has **known live defects** the user has deliberately chosen not to patch (see §9). The new `backend/src/modules/**` tree runs alongside it and shares nothing.

---

## 2. COMPLETED PHASES

### Audit #1 — Enterprise Architecture Review
Full read of the codebase. **30 findings (F-01…F-30).** Scores: Architecture 32/100, Maintainability 38, Scalability 16, Technical Debt 26, AI Readiness 20, Production Readiness 30. Composite 27/100.

Blocker-class findings: F-01 broken Postgres transactions · F-02 synchronous blocking data layer · F-03 no multi-tenancy · F-04 N+1 explosion · F-05 async handlers without error propagation · F-06 293 KB in-browser-Babel frontend · F-07 no service layer · F-08 single-instance-only · F-09 non-atomic sequences · F-10 file BLOBs in the OLTP database.

### CTO Execution Strategy
Findings reclassified into 5 priority categories. Key strategic call, accepted by the user: **ship as single-tenant for Arabtec as customer zero; defer multi-tenancy until a signed second customer.**

### Audit #2 — ATS Business Logic Audit
Traced every state-mutating rule from HTTP entry to database. **39 findings (BL-01…BL-39).** Scores: Workflow Correctness 41/100, Rule Enforcement Consistency 31, Data Integrity 36, Compliance Readiness 24, Audit Completeness 57, Reporting Accuracy 38.

Headline finding: **`stages.js` — the best-engineered file in the legacy codebase — was enforced on only one side.** `appCanMove()` had 2 call sites; `reqCanMove()` and `REQ_TRANSITIONS` had **zero**. Every requisition status change was a raw `UPDATE`.

### Product & UX Review
Full read of the 4,838-line `app.jsx` and 1,127-line `styles.css`. Found 4 broken primary actions (Edit button crashes with `ReferenceError`, offer approval has no UI at all, dead pipeline stage filter, board cannot reach `OFFER_SENT`), zero drag-and-drop, 4 different sorting paradigms, and WCAG failures. Produced a 25-item prioritized change list.

### Document 2 — Domain Model & Module Specification (Parts I–VIII)
Locked across several revisions with user corrections. Parts: I aggregates & invariants · II revised business rules · III confirmations · IV cross-cutting features · V extension seams · VI additional-requirement deltas · VII AI operations layer & plugin system · VIII AI execution architecture.

### Phase 1 — Domain Core
Requisition and Application aggregates, state machines, invariants H1–H5, error taxonomy. 140 tests. **Two real bugs found by tests before any persistence existed** (see §16).

### Phase 2 — Business Application Layer
`RequisitionService`, `PipelineService`, `InterviewService`, `OfferService`, notification contracts, formalized domain events. Interview and Offer bounded contexts created from scratch (aggregates + services). 263 tests.

### Phase 2.5 — Domain Stabilization
System-wide review against 15 criteria. Six structural defects found and fixed (see §6). Introduced `shared/kernel`. 263 tests still green, zero behaviour change.

### Phase 2.6 — Infrastructure Design
Complete design document delivered in chat covering PostgreSQL schema, Drizzle organization, repository mapping, UnitOfWork, locking, event bus, outbox, jobs, performance, security, AI readiness. **Two decisions raised and still unanswered — see §16.** ⚠️ This document exists only in the conversation; it was never written to a file.

---

## 3. COMPLETED FILES

All paths relative to repo root. **All are untracked (new).**

### Shared kernel — `backend/src/modules/shared/`
| File | Contents |
|---|---|
| `kernel/domain.ts` | `Actor`, `DomainEvent`, `Clock`, `systemClock`. Imports nothing. |
| `kernel/auth-context.ts` | `AuthContext` class — tenantId, userId, permissions, projectScopes, isGlobalScope, `has/hasAny/hasAll`, `canAccessProject`, `actor` getter, `AuthContext.system()` factory |
| `kernel/errors.ts` | `ApplicationError` base + `ForbiddenError`, `NotFoundError`, `StaleAggregateError` |
| `kernel/ports.ts` | `EventBus`, `JobQueue`, `NotificationHub`, `AuditTimeline`, `AIService`, `TimelineEntry`, `AIProposal` — interfaces only |
| `kernel/index.ts` | Kernel public surface |
| `ports/notifications.ts` | `EmailProvider`, `SmsProvider`, `CalendarProvider`, `InternalNotificationProvider`, `NotificationDispatch` — interfaces only |

### Hiring context — `backend/src/modules/hiring/`
| File | Contents |
|---|---|
| `domain/errors.ts` | 11 typed domain errors with stable machine codes |
| `domain/events.ts` | `HIRING_EVENTS` catalogue (14 types), `SIGNIFICANT_HIRING_EVENTS` |
| `domain/stages.ts` | 6 pipeline stages + 5 non-pipeline, `TRANSITIONS` map, MANUAL/SYSTEM triggers, `ENTRY_STAGES`, `REASON_FIELD`, `LEGACY_STAGE_ALIASES` |
| `domain/requisition-states.ts` | 8 states, transitions, **derived** `FillState`, `displayStatus`, `LEGACY_STATE_ALIASES` |
| `domain/requisition.ts` | Requisition aggregate — owns `Seat[]`, enforces H1–H3, ~490 lines |
| `domain/application.ts` | Application aggregate — owns `StageChange[]`, `transitionTo` is the sole stage mutator |
| `application/auth-context.ts` | `HIRING_PERMISSIONS` + re-export of `AuthContext` |
| `application/hiring-service.ts` | `recordHire`, `reverseHire` — the cross-aggregate transaction |
| `application/requisition-service.ts` | 11 operations: create, update, submit, recall, approve, reject, revise, assignRecruiter, hold/resume, adjustHeadcount, close, cancel, reopen |
| `application/pipeline-service.ts` | addCandidate, transition, applySystemTransition, resume, bulkTransition, setNextAction, assignRecruiter |
| `application/ports/repositories.ts` | `RequisitionRepository`, `ApplicationRepository` |
| `application/ports/unit-of-work.ts` | `UnitOfWork`, `TransactionScope` |
| `application/ports/offer-gateway.ts` | `OfferGateway` — Hiring's anti-corruption port over Offer |
| `application/__testing__/in-memory.ts` | Test-only fakes with real rollback semantics |
| `index.ts` | Module public surface + `PipelineGateway` declaration |

### Interview context — `backend/src/modules/interview/`
| File | Contents |
|---|---|
| `domain/assessment.ts` | **Direct transcription of the Arabtec Interview Assessment Sheet**: 5 behavioural + 5 technical criteria with hints, score guide, 3 critical flags, 5 decisions, fit bands 4.2/3.5/3.0, `averageScore` (N/A excluded), `fitBandFor`, `completeness` |
| `domain/errors.ts` | 8 typed errors |
| `domain/events.ts` | `INTERVIEW_EVENTS` (6 types) |
| `domain/interview.ts` | Interview aggregate — panel, assessments, status machine, rule-based `recommendation()` |
| `application/ports.ts` | `InterviewRepository`, `InterviewUnitOfWork` |
| `application/interview-service.ts` | schedule, reschedule, setPanel, complete, markNoShow, cancel, recordAssessment, recommendation |
| `application/__testing__/in-memory.ts` | Fakes + `FakeCalendarProvider` |
| `index.ts` | Module public surface |

### Offer context — `backend/src/modules/offer/`
| File | Contents |
|---|---|
| `domain/errors.ts` | 6 typed errors incl. `LiveOfferExistsError`, `OfferSelfApprovalError` |
| `domain/events.ts` | `OFFER_EVENTS` (10 types) |
| `domain/offer.ts` | Offer aggregate — 9 statuses, compensation lines, template pinning, fail-closed threshold |
| `application/offer-service.ts` | draft, setCompensation, submit, recall, approve, rejectApproval, send, accept, decline, withdraw, expire, expireDue |
| `application/__testing__/in-memory.ts` | Fakes + `RecordingPipelineGateway` |
| `index.ts` | Module public surface |

### Infrastructure — `backend/src/infrastructure/`
| File | Contents |
|---|---|
| `tools/reconcile/checks.ts` | **15 pure reconciliation checks** across 6 families |
| `tools/reconcile/source.ts` | Read-only SQLite + PostgreSQL snapshot readers |
| `tools/reconcile/report.ts` | text / JSON / CSV formatters |
| `tools/reconcile/run.ts` | CLI, exit codes 0/1/2 |
| `db/schema/{hiring,interview,offer,platform,index}.ts` | Drizzle physical schema — 13 tables. **Extensionless relative imports** in this folder only (Drizzle Kit's CJS bundler cannot resolve `.js` → `.ts`); documented inline. |
| `db/schema/schema.test.ts` | Boundary / drift / **emission** / shape / cascade guards — 32 tests |
| `db/migrations/0000_init_hiring_interview_offer.sql` | Generated by drizzle-kit |
| `db/migrations/0001_business_number_sequences.sql` | Hand-written: 4 sequences + compensation-component seed |
| `db/{types,client,errors,scope,numeric,sequences,transaction,version-guard}.ts` | Shared persistence primitives. **`Executor`** is the driver-agnostic handle every repository is written against. |
| `db/testing/{pglite,fixtures}.ts` | Integration harness — real PostgreSQL 18 in WASM, real migration files |
| `modules/<ctx>/infrastructure/` | Drizzle repository adapters + Unit of Work, one folder per bounded context (the barrel's stated home for adapters) |

### Test files (16)
`hiring/domain/{requisition,application,errors,invariants}.test.ts` · `hiring/application/{hiring-service,requisition-service,pipeline-service,auth-context}.test.ts` · `hiring/index.test.ts` · `interview/application/interview-service.test.ts` · `offer/application/offer-service.test.ts` · `modules/events.test.ts` · `modules/surface.test.ts` · `infrastructure/tools/reconcile/{checks,report}.test.ts` · `infrastructure/db/schema/schema.test.ts`

### Documentation — `docs/adr/`
`README.md` + `0001`…`0011` (see §7).

---

## 4. MODIFIED FILES

| File | Change | Ours? |
|---|---|---|
| `.gitignore` | Added `coverage/`, `**/coverage/` | ✅ ours |
| `backend/package.json` | Added devDeps `typescript@5`, `vitest@2`, `@types/node@22`, `@vitest/coverage-v8@2`, `tsx@4`. Added scripts `test:domain`, `test:domain:watch`, `test:domain:coverage`, `typecheck`, `reconcile` | ✅ ours |
| `backend/package-lock.json` | Dependency install | ✅ ours |
| `backend/tsconfig.json` | **New file.** strict, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, includes `src/modules/**` and `src/infrastructure/**` | ✅ ours |
| `backend/vitest.config.ts` | **New file.** Test include patterns, coverage thresholds (lines 90 / functions 90 / branches 85 / statements 90), exclusions for `__testing__/` and pure-interface files | ✅ ours |
| `backend/src/lib/email_templates.js` | ⚠️ Modified **before** this session began | ❌ pre-existing |
| `backend/src/lib/models.js` | ⚠️ Modified **before** this session began | ❌ pre-existing |
| `backend/src/lib/schema.js` | ⚠️ Modified **before** this session began | ❌ pre-existing |
| `HR_DIRECTOR_HANDOVER.md` | Untracked, pre-existing | ❌ pre-existing |

> **Important:** the three `backend/src/lib/*.js` modifications and `HR_DIRECTOR_HANDOVER.md` were already dirty in the working tree at session start. **We did not touch them.** Do not attribute them to this work, and do not include them in any commit without asking the user.

**No legacy runtime file was modified by this work.** `npm start` behaves exactly as before.

---

## 5. REMAINING WORK

### Phase 3 — Infrastructure (COMPLETE — 0 of 12 steps remaining)

| # | Step | Status | Evidence |
|---|---|---|---|
| 1 | Data reconciliation tooling | ✅ **DONE** | 15 checks; 4 injected defects in a real DB copy all detected |
| 2 | PostgreSQL schema | ✅ **DONE** | 8 CHECKs + 4 partial uniques verified present in the emitted SQL |
| 3 | Drizzle schema & migrations | ✅ **DONE** | Migrations apply cleanly to a real PostgreSQL 18 from an empty schema |
| 4 | Repository implementations | ✅ **DONE** | Mapper round-trip property tests over 11 seeds |
| 5 | UnitOfWork | ✅ **DONE** | Repositories built inside the transaction; rollback verified on real PG |
| 6 | Transaction boundaries | ✅ **DONE** | Cross-aggregate rollback; uncommitted writes invisible outside the scope |
| 7 | Row locking (`FOR UPDATE`) | ✅ **DONE** | **Real PG: session B provably blocks until A commits**; 10 parallel hires on 3 seats → exactly 3 |
| 8 | Transactional outbox | ✅ **DONE** | Option A, per user decision. Rollback writes no events; ADR-0011 |
| 9 | Event bus | ✅ **DONE** | Idempotent fan-out via `processed_event`; replay delivers nothing twice |
| 10 | Integration tests | ✅ **DONE** | Auto-uses real PostgreSQL when `TEST_DATABASE_URL` is set; skips cleanly otherwise |
| 11 | Concurrency validation | ✅ **DONE** | 9 real-PG tests: blocking, overfill, lost update, **genuine deadlock + retry**, 4 parallel dispatchers |
| 12 | Performance validation | ✅ **DONE** | Query counts measured, not assumed; one real N+1 found and fixed |

### Phase 4 — AI Foundation (blocked until Phase 3 completes)
`AIService` · `AIProvider` abstraction · `OllamaProvider` · Qwen integration · Prompt Registry · Tool Registry · `EmbeddingService` · AI Output Ledger · Prompt Execution log · AI Cache · `PageContext` · **local inference only** · cloud providers only behind `AIProvider`.

### Phase 5 — AI Features
Resume Parsing · CV OCR · Candidate Matching · Semantic Search · AI Assistant · AI Recommendations · AI Interview Assessment · AI Search · Smart Filters.

### Not yet designed or built
- **Talent context** (candidate aggregate) — does not exist. Needed for resume parsing, GDPR erasure, the expanded candidate profile (employment history, education, skills, languages, certifications, address, DOB, LinkedIn, portfolio, references, `salutationTitle`).
- **Identity/RBAC context** — user, role, permission management.
- **Platform context** — settings, feature flags, branding, custom fields.
- **Organization context** — projects, departments (Site entity retired).
- **HTTP layer** — no routes, no controllers, no Express wiring. Zero.
- **Composition root** — nothing wires the services together yet.
- **Offer templates** — user said they would provide official templates; not yet received.
- **Hiring documents checklist** — designed from the 2026 PDF, not implemented.

---

## 6. CURRENT ARCHITECTURE DECISIONS

### Style
**Modular monolith.** One deployable, hard internal module boundaries. Explicitly not microservices.

### Locked stack
| Layer | Decision |
|---|---|
| Runtime | Node 22 LTS pinned (machine currently runs v24.15.0 — note the mismatch) |
| Language | TypeScript, `strict`, `noUncheckedIndexedAccess` |
| HTTP | Express 5 (native async error propagation) — **not yet installed** |
| Database | PostgreSQL 17, single engine. Regex SQL translator to be deleted. |
| ORM | **Drizzle** (user confirmed — explicitly **not Prisma**) |
| Validation | Zod |
| Jobs & cache | BullMQ on Redis |
| Storage | S3-compatible object storage |
| Frontend | Vite + React 19 + React Router 7 + TanStack Query + Tailwind 4 — **from Lovable, do not build** |
| Testing | Vitest + Testcontainers + Playwright |
| Observability | OpenTelemetry |
| AI | **Ollama + Qwen, local-first.** `bge-m3` or equivalent for embeddings. Cloud providers are plugins only. |

### Bounded contexts
`hiring` (requisition + pipeline) · `interview` · `offer` · `shared/kernel`
Planned: `talent`, `identity`, `organization`, `platform`, `collaboration`, `insight`.

### Layering per context
```
domain/          aggregates, state machines, invariants — ZERO I/O
application/     services (use cases, transaction boundary), ports
infrastructure/  adapters (none exist yet)
index.ts         the module's ONLY public surface
```

### Non-negotiable rules
1. Modules import each other **only through `index.ts`**.
2. The domain layer imports nothing outside its own context and the kernel.
3. The kernel imports **no context** (verified mechanically).
4. One service method = one transaction.
5. Repositories always take `AuthContext`; scope lives in the query; out-of-scope returns `null` → `NotFoundError`, never a distinguishable 403.
6. Aggregates create their own events; services publish after commit.
7. AI is advisory — it proposes, a domain service applies, a human decides.
8. Nothing is overwritten: documents version, audit is append-only, manual edits are permanent, issued documents are reproducible.

### The invariants (Document 2 §2)
```
H1  seats.length === headcount              (rows, any state)
H2  filledCount <= headcount
H3  every FILLED seat references exactly one application
H4  every hired application occupies exactly one FILLED seat
H5  a candidate holds at most one filled seat across active requisitions
```
H1–H3 are enforced inside the Requisition aggregate and re-checked on `fromState()`. H4/H5 are cross-aggregate and enforced by `HiringService`.

### Business-rule decisions the user made explicitly
| Decision | Value |
|---|---|
| Requisition fields | Project, Department, Requester, Recruiter **only**. Site, Location, Hiring Manager removed. |
| Site entity | **Retired entirely** |
| Approval | Two modes only. Disabled → DRAFT→APPROVED. Enabled → HR Director **and** System Admin both notified, **first to act completes it**. No chains, no levels, no policy engine. Self-approval barred. |
| Pipeline stages | 6: SOURCED → MATCHED → INTERVIEWING → OFFER_PREPARATION → OFFER_SENT → HIRED |
| "Awaiting feedback" | **Not a stage.** Derived from interview state. |
| Salary visibility | Current/Expected Salary are HR-only, enforced at the **domain** level. Hiring Managers and panel never see them. |
| Compensation | **Manual entry over configurable components. Total is a sum. No ratios, no derivation.** The 40/30/30 pattern observed in three sample letters was explicitly rejected as policy. |
| Assessment outcome | **Recommendation only.** No automatic pipeline transition. A human must explicitly confirm. |
| Interview `RESCHEDULED` | **Not a status.** A counter; the interview stays SCHEDULED. |
| Offer validity | 5 days from document date (from the real letters), configurable |
| Multi-tenancy | `tenant_id` designed in from day one; RLS written but not enabled. Single tenant until customer #2. |
| Workflow engine | **Seam only. Engine deferred** until a second real workflow variant exists. |
| Report builder | **Components + metadata from day one; visual designer deferred.** |

---

## 7. ADRs CREATED

All in `docs/adr/`. Format is deliberately short.

| # | Title | Closes |
|---|---|---|
| **0001** | The domain layer performs no I/O | — |
| **0002** | Unit of Work owns the transaction; repositories come from the scope | F-01 |
| **0003** | Hire spans two aggregates in one transaction | BL-03, BL-23, BL-27 |
| **0004** | Seat acquisition is serialised by a row lock on the requisition | — |
| **0005** | Scope lives in the query; out-of-scope is indistinguishable from missing | F-25, BL-08, BL-30 |
| **0006** | Events are collected on aggregates and published after commit | — |
| **0007** | Cross-context reads go through gateway ports | — |
| **0008** | Audit and notifications subscribe to events; services do not call them | BL-34, BL-36 |
| **0009** | Migration is incremental via adapters over the legacy data layer | — |
| **0010** | The repository records the version it loaded; no baseline means insert | — |
| **0011** | Repositories drain events into the outbox; the Unit of Work relays after commit | — |

**No ADR has been written for the Phase 2.5 shared-kernel extraction.** That is a gap — it should become ADR-0012 (0010 and 0011 are taken).

---

## 8. OPEN RISKS

| # | Risk | Severity | Detail | Mitigation |
|---|---|---|---|---|
| **R1** | **Cross-context atomicity gap** | High | `OfferService.send` writes its aggregate, then calls `PipelineGateway.applySystemTransition` in a **separate transaction**. Failure between them leaves an offer SENT with the application not moved. Same class as F-01, one level up. | Transactional outbox (step 8). ⚠️ Needs the §16 decision. |
| **R2** | **Production data may violate H1** | High → **downgraded** | `Requisition.fromState()` throws `InvariantViolationError` on load if `seats.length !== headcount`. **The dev database (3 requisitions / 5 seats / 7 applications) is completely clean.** But it is tiny and may not reflect production. | Reconciliation tool now exists. **Must be run against production before step 4.** |
| **R3** | **Row-lock behaviour unproven** | High | In-memory fakes have no locks, so ADR-0004 is asserted, not verified. | Blocking CI test at step 7: 10 parallel hires on a 3-seat requisition → exactly 3 succeed, 7 get `NO_OPEN_SEAT`. |
| **R6** | **Lock-order deadlock** | High | Two paths take the same two locks in opposite order. `HiringService.recordHire`: application → requisition. `RequisitionService.close`: requisition → application. Concurrently these deadlock. | UoW retry on `40P01`/`40001` (zero business change) — plan of record. Canonical lock ordering is the better fix but needs a one-line business change. |
| **R4** | Commit→publish window | Med | Process death between COMMIT and `events.publish()` loses the event. | Outbox closes it. Subscribers must be idempotent meanwhile. |
| **R5** | Offer threshold currency not converted | Med | `directorThreshold` is compared against `totalNet` with no FX conversion. Meaningless across currencies. | **Business rule the user has not defined. Do not invent one.** |
| **R7** | Seat-diff `save()` is the most intricate mapper | Med | A bug there corrupts H1. | Property test: random ops → save → reload → invariants hold. |
| **R8** | History tail-insert depends on the row lock | Med | Repository will insert `history.slice(storedCount)`. Correct only under the lock. | Assert in the integration test; document in the mapper. |
| **R9** | Per-context cutover is irreversible | Med | Once legacy routes for a context are disabled, rollback means re-enabling them. | Rehearse on a restored snapshot; keep the re-enable switch 30 days. |
| **R10** | Alias-map edits weaken the reconciliation gate | Low | `checks.ts` imports `LEGACY_*_ALIASES` from `modules/hiring`. Adding a value to make a migration pass silently makes the check accept it. | Alias-map changes require explicit review. |
| **R11** | Node version mismatch | Low | `package.json` says `>=22.5.0 <23`; the machine runs v24.15.0. | Decide: relax the engines field or install Node 22. |

---

## 9. KNOWN TECHNICAL DEBT

### In the new code
| # | Item | Why it exists |
|---|---|---|
| D1 | `InterviewService.schedule` uses **two transactions** — book, then bind the external calendar id | Deliberate: the calendar call must not hold a lock. Benign — a failed bind leaves `externalEventId` null, already the no-calendar state. |
| D2 | `Offer.approve` throws `OfferSelfApprovalError` for the *director-authority* case too | Message is right, code is imprecise. Deserves its own code. Cosmetic. |
| D3 | `shared/ports/notifications.ts` and `kernel/ports.ts` both describe notification channels at different grain | Consolidate when the Notification Hub is built. Merging speculatively would guess the wrong shape. |
| D4 | No ADR for the shared-kernel extraction | Should be ADR-0012. |
| D5 | `offer-gateway.ts` shows 0% coverage | It is a pure interface; should be added to the vitest coverage exclusion list. |

### In the legacy system (NOT being fixed — user's explicit decision)
The user said: *"do NOT patch main in parallel yet. I prefer keeping Phase 1 focused. We'll decide after the new domain reaches the application-service layer whether to backport targeted fixes or let the new architecture supersede them."*

**That decision point has now passed** — the application-service layer is complete. **This should be raised with the user.**

| Defect | Impact |
|---|---|
| `setEditing` is not defined in `RequestDetail` (`app.jsx:2552`) | **Edit button on a hiring request crashes the page.** `ReferenceError`. |
| No offer approval UI anywhere | **No offer can ever be completed through the product.** "Send Offer" shows for `draft` but the API requires `approved` → guaranteed 409. |
| GDPR erasure incomplete | PII survives in `file_blob`, `candidate_activity`, `ticket_post`, `audit_log`, `interview_feedback`, `offer`. **Live regulatory exposure that grows daily.** |
| Broken Postgres transactions (F-01) | Silent data corruption in production today. |
| Dead pipeline stage filter | Selecting any stage returns zero results. |
| 8 requisition lifecycle actions have no UI | Submit, approve, reject, assign, hold, resume, cancel all unreachable. |
| Project/site scoping enforced nowhere | Administrators believe access is restricted when it is not. |

---

## 10. CURRENT BRANCH

```
Branch:        feat/hiring-domain-core
Created from:  main
Base commit:   1616dab
Commits made:  0
Working tree:  dirty (all new work uncommitted)
Remote:        not pushed
```

Created because the session began on `main` and the harness rule requires branching before work.

---

## 11. PENDING MIGRATIONS

**None written. Zero migration files exist.**

Planned (step 2–3):
- **New tables**, prefixed `hiring_`, `interview_`, `offer_` — no collision with legacy `recruitment_request`, `requisition_seat`, `application`, `offer`.
- **Strategy: new tables → one-time data migration → hard cutover per context.** Dual-write was explicitly rejected (two sources of truth for headcount is the corruption we removed).
- 10 tables: `hiring_requisition`, `hiring_seat`, `hiring_application`, `hiring_stage_history`, `interview`, `interview_panel`, `interview_assessment`, `offer`, `offer_compensation_line`, `offer_compensation_component`
- Platform: `outbox_event`, `processed_event`, `timeline_entry`
- Migrations run as a **deploy step, never at application boot** (closes F-13). Forward-only.
- Vocabulary migration uses `LEGACY_STAGE_ALIASES` / `LEGACY_STATE_ALIASES`, exported from `modules/hiring` for exactly this.

### Constraints planned (safety net, not enforcement)
```sql
UNIQUE(requisition_id, seat_no)
CHECK ((state='FILLED') = (application_id IS NOT NULL))          -- H3
UNIQUE(application_id) WHERE state='FILLED'                       -- H3/H4
UNIQUE(tenant_id, candidate_id, requisition_id) WHERE stage NOT IN (terminal)   -- BL-26
UNIQUE(tenant_id, ticket_no) / application_no / interview_no / offer_no          -- F-09
EXCLUDE on offer(application_id) WHERE status IN ('SENT','ACCEPTED')
```
**H1 is deliberately NOT a database constraint** — it would need a trigger, and a trigger is business logic in the database.

### Soft delete — decided: **do not implement**
There is no delete operation anywhere in the business layer. Every removal is a modelled state (CANCELLED, WITHDRAWN, EXPIRED) with a reason and an actor. GDPR erasure is anonymise-in-place. Adding `deleted_at` would create a second, invisible deletion concept. **Exception:** configuration tables use an `active` boolean.

---

## 12. PENDING INFRASTRUCTURE

**Zero infrastructure implementations exist.** Only interfaces.

| Port | Implementation | Notes |
|---|---|---|
| `UnitOfWork` | `PostgresUnitOfWork` | One implementation satisfies all context UoW interfaces — this is the fix path for R1 |
| `RequisitionRepository` | `DrizzleRequisitionRepository` | Seat diff: upsert by `seat_no`, delete absent |
| `ApplicationRepository` | `DrizzleApplicationRepository` | History tail-insert by count under the row lock |
| `InterviewRepository` | `DrizzleInterviewRepository` | Panel diff + assessment upsert by evaluator |
| `OfferRepository` | `DrizzleOfferRepository` | Line diff |
| `EventBus` | `OutboxEventBus` | ⚠️ blocked on §16 decision |
| `JobQueue` | BullMQ, 4 priority queues | INTERACTIVE / STANDARD / BATCH / IDLE |
| `NotificationHub` | Event subscriber | |
| `AuditTimeline` | Event subscriber, append-only, DB grants | |
| `CalendarProvider` | Internal `.ics` first; Google/M365 later | `externalEventId` stored from V1 |
| `OfferGateway` | Reads offer status for the close-block | Currently stubbed; **close-block is unenforced until this exists** |

Also missing: connection pool, health probe, Express 5 app, composition root, `drizzle-kit` config, Testcontainers setup.

---

## 13. PENDING AI WORK

**Nothing started. Explicitly blocked until infrastructure completes.**

Architecture is fully designed (Document 2 Parts V, VII, VIII):

```
Module Service → AIService → AIProvider (plugin) → Ollama → Qwen
```

| Component | Status |
|---|---|
| `AIService` (capability layer) | Interface stub exists in `kernel/ports.ts` — `propose()` only, returns `AIProposal \| null` |
| `AIProvider` abstraction | Designed. Ollama / OpenAI / Azure / Anthropic as plugins. |
| Prompt Registry | Designed. **Prompt is data; output schema stays in code.** |
| Tool Registry | Designed. Tools wrap existing services. Execute under the **caller's** `AuthContext`. WRITE tools produce proposals only. MCP-shaped. |
| `EmbeddingService` | Designed. pgvector. **Embedding model pinned per row.** Similarity scoped inside the query. |
| AI Output Ledger | Designed. `confidence`, `reasoningSummary`, `sourcesUsed` **NOT NULL**. Versioned, approvable. |
| Prompt Execution log | Designed. Separate from the ledger; 90-day retention; records failures. |
| AI Cache | Designed. Key includes **`visibilityFingerprint`** — omitting it leaks masked data through cache. |
| `PageContext` | Designed, **simplified per user**: entity, permissions, visibleFields, filters only. Built **server-side**. |
| Conversation memory | **Persistence only in V1.** No long-term memory, no ranking, no self-learning. |

**Hard constraints:** local inference by default · every AI call is an asynchronous queued job (Qwen on CPU can take 20–40s — never inside an HTTP request) · consent checked before any egress · AI never writes · the model **never generates SQL** (it emits a validated `ListQuery` against a whitelisted field catalog).

---

## 14. PENDING UI WORK

**None. Do not build UI.**

The user's instruction, verbatim in spirit: the final UI will come from a **separate Lovable project**. When it arrives:
- Keep its design, branding, layout and components.
- Only connect it to the backend.
- **The backend is the source of truth. The UI adapts to the backend. Never change business logic to satisfy the UI.**

A full product/UX review of the legacy `app.jsx` was completed and a 25-item change list produced (Tier 1 defects, Tier 2 recruiter productivity, Tier 3 consistency). That review is **reference material for the Lovable brief**, not a build instruction.

The legacy frontend (`frontend/public/app.jsx`, 4,838 lines, in-browser Babel) remains in production and untouched.

---

## 15. EXACT NEXT TASK TO EXECUTE

> **Phase 3, Steps 2 + 3 — PostgreSQL schema and Drizzle schema, together.**

They are the same artifact expressed twice (migration SQL and typed table definitions). Splitting them means writing every table twice and risking drift.

### Deliverables
1. `backend/src/infrastructure/db/schema/hiring.ts` — `hiring_requisition`, `hiring_seat`, `hiring_application`, `hiring_stage_history` + relations
2. `.../schema/interview.ts` — `interview`, `interview_panel`, `interview_assessment`
3. `.../schema/offer.ts` — `offer`, `offer_compensation_line`, `offer_compensation_component`
4. `.../schema/platform.ts` — `outbox_event`, `processed_event`, `timeline_entry`
5. `.../schema/sequences.ts` — business-number sequences
6. `.../schema/index.ts` — re-exports only
7. `drizzle.config.ts` + generated initial migration SQL, reviewed and committed to the repo
8. The constraint set listed in §11
9. The index set derived from **actual repository queries** (not guessed)
10. A CI check asserting `schema/` imports nothing from `modules/`
11. Tests: schema shape assertions; a test that every column in each `*Props` interface has a corresponding column

### Field mapping source of truth
Read these files for the exact shapes — do not guess:
- `RequisitionProps`, `Seat` → `modules/hiring/domain/requisition.ts`
- `ApplicationProps`, `StageChange` → `modules/hiring/domain/application.ts`
- `InterviewProps`, `PanelMember`, `Assessment` → `modules/interview/domain/interview.ts`
- `OfferProps`, `CompensationLine` → `modules/offer/domain/offer.ts`

### Before starting
```bash
cd /Users/moutazadly/Downloads/arabtec-recruitment-hub/backend
npm run typecheck          # must be clean
npm run test:domain        # must be 292 passing
```

### Acceptance
- `tsc --noEmit` clean
- 292 existing tests still passing (business layer unchanged)
- Coverage thresholds still met
- `schema/` imports nothing from `modules/`
- No business rule expressed as a trigger or computed column

---

## 16. ANYTHING ANOTHER CLAUDE INSTANCE MUST KNOW

### ⚠️ TWO DECISIONS ARE OPEN AND UNANSWERED

The user was asked both in the Phase 2.6 design document and answered neither — they replied "do not stop for additional design documents, continue directly into Phase 3."

**Decision 1 — Deadlock strategy (needed at step 7).**
- Option A: UoW retries on `40P01`/`40001`, bounded, exponential backoff + jitter. **Zero business change.** Safe because `fn` re-executes from scratch with no side effects outside the transaction.
- Option B: canonical lock order (always requisition before application). One-line change in `HiringService`. Better long-term.
- **Plan of record: proceed with A.** It needs no permission. Raise B when the user next allows a business-layer touch.

**Decision 2 — Outbox mechanism (needed at step 8). ⚠️ MUST ASK BEFORE PROCEEDING.**
A true outbox needs the event row written **inside** the business transaction. The services currently pull events inside but publish after commit.
- Option A: repository drains `pullEvents()` during `save()`. **Zero business change** — but depends on an *undocumented call-order coupling* (every service happens to call `save()` before `pullEvents()`). One reordered line in a future service silently loses events.
- Option B: `TransactionScope` gains `collect(events)`; services call `tx.collect(...)`. Explicit, order-independent, type-checked. **~1 line per service method, 9 methods. No business rule moves.**
- Option C: accept the gap, rely on idempotency + a reconciliation sweep.
- **Recommendation: B.** But it touches the business layer, so **stop and ask**.

### The user's working style
- Extremely engaged, reviews carefully, approves explicitly phase by phase.
- Corrects inferred assumptions immediately and expects them removed, not defended.
- Wants **evidence**, not claims: file:line references, real test output, actual coverage numbers.
- Asked for a specific end-of-slice report format: **What was implemented · Files created/modified · Tests added · Coverage · Risks found · Remaining work · Recommended next slice.** Use it every time.
- Said: *"If a better implementation appears during development, stop and explain the trade-offs before changing the architecture."*

### Two real bugs the tests caught (why the discipline is worth it)
1. **`DRAFT` has two `submit` edges** (approval on/off). The transition lookup matched on `(from, action)` and returned the first, so approval-disabled mode threw `IllegalTransition`. Fixed by making the target participate in resolution.
2. **`adjustHeadcount` mutated before validating.** When there weren't enough `OPEN` seats to remove, it spliced some out and *then* threw — leaving `seats.length < headcount`, breaking H1 on a **failed** operation. Found by the property test on 4 of 6 seeds at ~200 operations. No example-based test caught it.

### Reference documents the user provided
Read via PDF extraction. The offer letters are **scanned images with no text layer** — they had to be rendered with `pdf-parse`'s `getScreenshot()` and read visually.
- `assesment sheet.pdf` — the Interview Assessment Form. **Transcribed exactly** into `interview/domain/assessment.ts`.
- Three job offers (Basem Wahdan, Heba El Shiekh, Bishoy Yaacoub) — used as a diff set to separate fixed template text from variables.
- `Required Hiring Documents Staff 2026[46].pdf` — 15 bilingual items, designed but not implemented.
- The user attached a **signature image** and asked about using it for signing. Design delivered (owner-only application, re-authentication, document hashing, audit as the evidence). **The image was never stored anywhere and must not be.**

### Commands that work
```bash
cd /Users/moutazadly/Downloads/arabtec-recruitment-hub/backend
npm run typecheck                  # tsc --noEmit
npm run test:domain                # vitest run  → 292 tests
npm run test:domain:coverage       # with thresholds
npm run reconcile -- --url file:data/arabtec.db
npm run reconcile -- --url $DATABASE_URL --format json --out report.json
```

### Coverage thresholds are a ratchet
`vitest.config.ts` enforces lines 90 / functions 90 / branches 85 / statements 90. Current actuals are far above. **Do not lower them.** When coverage drops, add tests — that is how the untested `AuthContext` methods and the uncovered service guards were found.

### What "done" looked like at each approval
The user approved: Phase 1 (domain core) · Phase 2 (business application layer) · Phase 2.5 (stabilization) · Phase 2.6 design (implicitly, by saying to proceed). Each approval came after a report in the format above with real numbers.

### Final reminder
**Nothing is committed. Do not commit until the user explicitly asks.**
