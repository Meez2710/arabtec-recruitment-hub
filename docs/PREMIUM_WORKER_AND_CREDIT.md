# Premium worker ticket and credit governance

Date: 2026-09-26. Owner issue: #34. Codex is the primary executor.

## Observed credit evidence

Claude desktop usage panel showed **Cloud session credits: $100 of $100 left** and an expiry label of **9:59 AM GMT+2, November 5**. The same panel separately showed **Usage credits: $30.66 of $50.00**. These are different counters; do not subtract one from the other or report $30.66 as this sprint's spend.

The model selector contains **Fable 5.1 — Requires usage credits**. Availability is verified. Which credit pool a Fable job would debit has not been established. The inspected cloud-environment settings expose network, environment variables, credentials and setup script; no per-task dollar cap was shown. No settings were saved and no paid job was submitted.

There is no measured sprint expenditure to report from a premium job in this takeover because none was dispatched. Do not interpret that statement as an audit of all historical Claude use. The currently observed cloud balance is $100; the owner's $50 cumulative gate is unchanged.

## Dispatch gate

Before a premium job:

1. Establish its actual billing pool and the sprint's prior cumulative spend across any premium pools used. Record timestamp, balance/cumulative value and evidence source.
2. Require an enforced per-job or account cap. Reserve at most $5 for the first review; this is a maximum allocation, not a cost prediction. Never submit when `confirmed cumulative + reserved in-flight + task cap > $50`.
3. Use one premium job at a time, with no autonomous continuations, subagents, paid tools or nested model calls. If billing is delayed, ambiguous or the cap cannot be enforced, keep the job queued and use Codex.
4. At completion record actual before/after evidence and any unallocated concurrent account activity. Do not assign an account-wide delta to this sprint if another job may have consumed it.
5. At the gate, stop premium work and return owner-review evidence. Do not buy credits, change billing limits, enable auto-recharge or treat the unused $50 as authorized continuation.

Current disposition: **ready ticket, not dispatched**. Fable is available; its billing-pool attribution and enforceable task cap are not verified. This blocks premium dispatch, not Codex execution.

## Ticket P1 — One-pass product logic review

**Worker:** Fable 5.1 if the dispatch gate is satisfied; otherwise Codex review.

**Purpose:** Identify an important logical error or priority mistake that a mechanical implementation could miss. This is where premium judgment can add value.

**Input pack:** This audit, the five-move plan, extraction map, fixed baseline SHA, exact relevant source snippets and synthetic desktop/phone before-and-after screenshots when available. No production CVs, candidate records, credentials or unrelated repository history.

**Task:** Review M1/M3/M2 first. Assess whether recovery messages are truthful, bulk-action scope is understandable and current application context remains distinct from candidate history. Evaluate M4 presentation only; do not change HR rules.

**Limits:** Read only; no code changes, full-repo discovery, benchmark research, tool setup, package installation, network browsing, testing campaign or feature backlog. One response, maximum 800 words and three findings. No follow-up run unless Codex finds a specific unresolved issue worth a new bounded ticket.

**Acceptance:** Each finding names the move, exact scenario, source/screenshot evidence, practical user consequence and minimum correction. Mark unknowns explicitly. If the plan is sound, say so; do not manufacture changes. Return pass / pass with corrections / blocking concern and a recommended move order.

**Done:** Codex incorporates justified corrections once, records decisions in #34, and closes the ticket. Fable does not merge, deploy, approve company policy or expand the sprint.

## Milestone ledger

| Milestone | Executor | Premium work | Evidence |
|---|---|---|---|
| M0 takeover | Codex | None submitted | Current main and issue verified; kickoff comment posted |
| Phase 0 audit/plan | Codex | None submitted | Six findings, five moves, module map, baseline 4 compile + 31 behavior checks |
| P1 | Fable, conditional | Queued, not running | Billing pool and enforceable cap unresolved |
| M1–M5 | Codex by default | None authorized automatically | Implementation/acceptance evidence must be appended as completed |

## Issue-update format

Milestone / baseline and head / concrete change / files / checks actually run / browser evidence / known risks / next bounded move / actual premium billing observation with timestamp, or “not observable.” No invented dollar costs, completion claims or unattended monitoring promises.
