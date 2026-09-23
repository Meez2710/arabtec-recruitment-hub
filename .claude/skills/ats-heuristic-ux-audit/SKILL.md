---
name: ats-heuristic-ux-audit
description: Score the Arabtec ATS's recruiter-facing screens against usability heuristics with evidence, and name what to fix. Use for a UX review, "polish" pass, premium-quality check, or before shipping any change a recruiter will see.
---

# Heuristic UX audit (Arabtec ATS)

Adapted from the Claude Academy "Competitive teardown and heuristic audit" use
case, turned inward: the baseline is the ATS itself, screen by screen.

## Heuristics — Nielsen's ten, plus four that are specific to this product
1–10. Nielsen: visibility of system status; match with the real world; user
control and freedom; consistency and standards; error prevention; recognition
over recall; flexibility and efficiency; aesthetic and minimalist design; help
users recover from errors; help and documentation.

11. **Never add a blocker unasked.** The ATS exists to accelerate hiring. Any
    gate, required field or mandatory approval must be something the product
    owner decided — flag every one that is not.
12. **Uncertainty is labelled, not hidden.** A candidate with thin data is shown
    with a badge and a reason, never withheld from a list.
13. **Arabic and mixed-language content renders correctly** — names, positions,
    and truncation do not break on Arabic script.
14. **Phone parity.** The screen works in the dedicated phone shell at 360, 390
    and 430 px: no horizontal overflow, 44 px tap targets, no hidden duplicate controls.

## Severity (Nielsen's scale)
0 not a problem · 1 cosmetic · 2 minor · 3 major · 4 catastrophe — fix before release.

## Method
1. Pick the screens: Dashboard, Hiring Requests, Talent Pool, Candidate Review,
   CV Inbox, Interviews, Offers — and their phone views.
2. Walk each as the role that uses it (recruiter, recruitment manager, HR director).
3. For every finding record: heuristic, severity, evidence (file:line AND a
   screenshot or measured DOM value), and the smallest fix.
4. End with the three strongest patterns to keep and the three to remove.

## Output
`docs/audits/heuristic-<date>.md`: a table per screen, then the keep/remove lists.
Severity-4 findings are release blockers and go straight to `ats-launch-readiness`.
