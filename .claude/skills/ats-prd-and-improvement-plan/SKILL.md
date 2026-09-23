---
name: ats-prd-and-improvement-plan
description: Turn Arabtec ATS audit findings or a feature request into a prioritised improvement plan and a PRD — goals, non-goals, and open questions with owners. Use after an audit, when scoping a new module, or when the user describes a problem rather than a solution.
---

# PRD and improvement plan (Arabtec ATS)

Adapted from the Claude Academy "PRD from a problem statement" and "Workflow
improvement planner" use cases.

## Interview before drafting
Ask about the problem, who actually hits it (recruiter, hiring manager, HR
director), the constraints (on-prem host, no build step, Arabic content, a
Postgres production database, two recruiters serving the company), and how
success would be measured in the product's own data. Push back on vague answers.

## The plan
- Group findings by the workflow they hurt, not by the file they live in.
- Rank by harm to real hiring work first, then effort. A finding that withholds
  candidates from recruiters outranks any cosmetic one.
- Every item names its owner and says what "done" is measured by.

## The PRD
- Problem, users, constraints, and success metric.
- **Goals and non-goals** stated explicitly — non-goals stop scope creep.
- **Open questions** flagged separately from decisions, each with who decides.
  Anything that would add a gate or a required step is an open question for the
  product owner, never a default.

## Output
`docs/plans/<topic>.md`. Match the depth of `docs/CV_INTAKE_DEPLOYMENT_HANDOFF.md`.
