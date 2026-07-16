# Arabtec Recruitment Hub — Enhancement Spec
## "Recruitment Request as a Live Workspace" + HR Director Reporting Layer
**Status:** Design / spec only — **no code yet.** Awaiting your approval of scope + plan before implementation.
**Builds on:** the closed MVP (Phases 1–6). This is an enhancement of existing screens, not a rebuild.

---

## 0. Guiding decisions (from your answers)
- **Schema may be extended** (new candidate/request fields, lifecycle timestamps, stage history) — kept in parity across SQLite / Prisma / PostgreSQL, as in every prior phase.
- **Adopt the new pipeline stage list.** The existing 16-status model is remapped to your set (details in §2).
- **Spec first, code later.** This document is for review; implementation is phased and gated on your approval.
- **Keep request creation simple.** Advanced tracking moves to the detail page, candidate profile, and reporting — not the create form.

---

## 1. What already exists vs. what's new
| Capability | Today (MVP) | This enhancement |
|---|---|---|
| Request detail page | Tabs: Overview, JD, Approvals, Timeline, Pipeline | Becomes a **live workspace**: rich summary header, pipeline, insights, lifecycle health |
| Pipeline | 16 statuses, Kanban/List/Compact | **Remapped stages** + per-candidate row data + filters/sort/search |
| Candidate profile | 6 tabs incl. activity/audit | + professional-background fields, recruitment history, richer audit |
| Rejection | Reason required (lookup) | + **controlled reason list** from your doc + free-text + feeds reporting |
| Insights | none per-request | **Per-request executive insights** (funnel + time-to-X + aging) |
| Lifecycle dates | created/opened/closed | **Full lifecycle dates + auto-calculated durations + R/A/G health** |
| Hiring Manager view | shared screens, scoped | **Dedicated limited HM view** |
| Director dashboard | role-aware KPIs | **Expanded management dashboard** (delays, workload, source, rejection trends) |

---

## 2. Pipeline stage model (remap)
**New canonical stages** (ordered):
`new → screened → shortlisted → interview_1 → interview_2 → final_interview → offer_preparation → offer_sent → offer_accepted → hired`
**Terminal/side:** `rejected`, `withdrawn`.

**Mapping from existing → new** (so Phases 3–5 logic and history are preserved):
| Existing | New |
|---|---|
| applied | new |
| cv_screening | screened |
| shortlisted | shortlisted |
| phone_interview / technical_interview | interview_1 |
| client_interview | interview_2 |
| final_interview | final_interview |
| reference_check | final_interview (kept as sub-note) |
| offer_preparation | offer_preparation |
| offer_sent | offer_sent |
| offer_accepted | offer_accepted |
| joined | hired |
| rejected / on_hold / withdrawn / offer_rejected | rejected / (on_hold retained) / withdrawn |

> Interviews & Offers modules already key off specific statuses; the remap keeps the offer/joining automation intact (offer_sent/accepted/hired still drive the safe vacancy fill). "Hired" = the former "joined" so the seat automation is unchanged.

---

## 3. Request creation form (kept simple — unchanged scope)
Only these fields on create (most already exist):
job title · project · department · discipline · headcount · priority · employment type · staff category · grade · target join date · salary band (salary-gated) · **JD upload _or_ manual key requirements** · hiring manager notes.
**New on the form:** "manual key requirements" (short structured list) and "hiring manager notes" (text). JD upload = document metadata (file storage remains a known limitation; metadata + optional hash only, consistent with the MVP).

---

## 4. Request Detail = Live Workspace

### 4.1 Summary header
One scannable header with: request ID, job title, project, site, department, discipline, headcount (filled/total), priority, staff category, employment type, grade, request creator, hiring manager, recruiter assigned, created date, approval date, closing date, target join date, and a single clear **status** chip.
**Status set (display):** draft · pending approval · approved · active · sourcing · screening · interviewing · offer stage · on hold · closed. *(These are presentation states derived from the underlying request status + pipeline activity; see §9 for how each is computed — no conflicting second source of truth.)*

### 4.2 Candidate pipeline (core)
- Columns = the new stage list (§2).
- **Per-candidate row/card shows:** name, employer, current project, years experience, graduation year, university, major, status, current stage, assigned recruiter, last update, next action, next action date, rejection reason (if rejected), interview outcome (if interviewed).
- **Controls:** filter by status / recruiter / stage; sort by last-updated; search by name or employer.
- Views: Kanban + table (compact). Salary stays masked unless permitted.

### 4.3 Candidate profile (side panel or full page)
- **Professional background:** current employer, current project, position title, years experience, nationality, location, notice period, salary expectation (gated), university, graduation year, major.
- **Recruitment history:** applied date, source, current request, assigned recruiter, interview stages, offer status, final decision.
- **Feedback & audit trail (chronological, read-only):** recruiter note, shortlist decision, HM feedback, interview feedback, rejection reason, offer update, system update. **No silent edits** — every change writes who/what/when.

### 4.4 Rejection management
- Rejection reason **mandatory** on reject, chosen from a controlled list: insufficient experience · wrong discipline · weak interview performance · salary mismatch · unavailable · notice period too long · no project fit · communication issue · manager rejection · withdrawn by candidate · other.
- Plus optional free-text explanation. Both persist and feed reporting (§4.5, §8).

### 4.5 Per-request insights
- **Counts:** received, screened, shortlisted, interviewed, offered, accepted, hired, rejected, withdrawn.
- **Analytics (visual):** source effectiveness, rejection-reason breakdown, time-to-shortlist, time-to-interview, time-to-offer, time-to-hire, aging candidates, aging request.
- Rendered with the existing inline-SVG chart approach (no new chart library).

### 4.6 Request lifecycle dates + health
- **Tracked dates:** created, approved, first candidate added, first shortlist, first interview, first offer, closing.
- **Auto-calculated:** days open, days since approval, days since last candidate update, days remaining to target join date.
- **Health indicators:** 🟢 healthy · 🟠 attention · 🔴 overdue (thresholds configurable in Admin → System Settings).

---

## 5. Hiring Manager view (dedicated, limited)
A focused screen showing only: request status, shortlisted candidates, interview schedule, feedback pending (theirs), offer progress, final hiring result. No admin/config fields, no salary unless explicitly permitted. Implemented as a scoped variant of the workspace (HM permission set already exists; this trims the surface and adds a "feedback pending" queue).

---

## 6. HR Director dashboard (management/reporting layer)
Expands the current dashboard with: open requests, **delayed requests**, **critical vacancies** (priority=critical + aging/overdue), requests by status, candidates in pipeline, upcoming interviews, offers pending approval, hires completed, **average time-to-fill**, **recruiter workload**, **source performance**, **rejection trends**. Org-wide for leadership; scoped for others (existing scope rules). Read-only, no salary.

---

## 7. Data model deltas (new fields/tables)
**`candidate` (add):** `university`, `graduation_year`, `major`, `current_project`, `position_title`, `nationality` (exists), `notice_period` (exists), plus `source` (exists). *(Most contact/experience fields already exist.)*
**`application` (add):** `current_stage` (remapped), `next_action`, `next_action_date`, `interview_outcome` (denormalized convenience), and lifecycle helpers.
**`application_stage_history`** already exists → becomes the backbone for time-to-X analytics (no change needed beyond reads).
**`recruitment_request` (add):** lifecycle timestamps — `first_candidate_at`, `first_shortlist_at`, `first_interview_at`, `first_offer_at` (created/approved/closed already exist), and `key_requirements`, `hiring_manager_notes`.
**`reject_reason`** → reseed with the controlled list in §4.4.
**Settings:** health thresholds (amber/red days) + lifecycle config in `system_setting`.
All additions mirrored in `schema.js`, `schema.prisma`, and `docs/SCHEMA.sql` (parity discipline preserved).

---

## 8. Reporting / analytics computation
- **Time-to-X** derived from `application_stage_history` (first transition into each stage) and request lifecycle dates — no manual entry.
- **Source effectiveness** = hires grouped by `candidate.source`.
- **Rejection trends** = grouped `reject_reason` over time / by request / by recruiter.
- **Recruiter workload** = active applications + open requests per recruiter.
- All aggregation server-side, scope-enforced, salary-free (same guarantees as the Phase 6 dashboard).

---

## 9. Status derivation (single source of truth)
The header's presentation status is **computed**, never a second editable field:
- draft / pending_approval / approved / closed / on_hold → from `recruitment_request.status` directly.
- **active/sourcing/screening/interviewing/offer stage** → derived from request being open + the furthest-along application stage (e.g. any app in interview_* → "interviewing"; any in offer_* → "offer stage"; else "sourcing"/"screening"). This avoids the anti-pattern of two conflicting status fields.

---

## 10. Governance, usability, scalability (acceptance bar)
- **Audit:** every mutation logged (actor/what/when); no silent edits; controlled dropdowns where possible, free-text only where needed.
- **Usability:** fewer clicks, fast scanning, prominent status, easy filters, clean cards.
- **Scalability:** server-side pagination/filtering on candidate-heavy requests; indexes on the new query paths.
- **Data quality:** one clear current stage per application (already enforced); dedup retained.

---

## 11. Proposed phased build plan (for approval)
Each stage ends with tests + a short report; nothing proceeds without your OK.

- **Stage A — Data & stage remap (backend):** new fields/timestamps, stage remap + history backfill logic, reseed reject reasons, schema parity, lifecycle-date auto-capture, derived-status helper. *(No visible UI change yet; full regression must stay green.)*
- **Stage B — Request Detail workspace (frontend):** summary header, remapped pipeline with per-candidate rows + filters/sort/search, lifecycle health indicators, rejection-reason flow.
- **Stage C — Candidate profile + audit depth:** professional background, recruitment history, chronological feedback/audit panel.
- **Stage D — Insights + HR Director dashboard + Hiring Manager view:** per-request insights, expanded management dashboard, dedicated HM screen.

**Estimated surface:** Stage A is the riskiest (touches schema + the stage values that interviews/offers depend on) and will get the most test coverage. B–D are largely additive UI + read-only analytics.

---

## 12. Open questions before build (please confirm)
1. **Reference check** — keep as its own stage, or fold into final_interview (as proposed)?
2. **Interview 1 / Interview 2** — map to interview *rounds* (the Interviews module already has `round`) so scheduling round 2 auto-advances the stage? Recommended yes.
3. **Health thresholds** — default amber/red at, say, 30/45 days open and target-join overrun? Adjustable in Admin.
4. **JD upload** — confirm metadata-only is acceptable for now (real file storage remains a documented MVP limitation).
5. **Build order** — proceed Stage A→D as above, or reprioritize (e.g. Director dashboard earlier for leadership demo)?

---

**No code has been written.** On your approval of this spec (and the answers to §12), I'll begin **Stage A** and report back before continuing.
