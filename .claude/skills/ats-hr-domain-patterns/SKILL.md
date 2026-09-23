---
name: ats-hr-domain-patterns
description: Reference patterns for the Arabtec ATS's HR modules — opening a role (requisition intake), interview debrief synthesis, and the offer package. Use when designing, auditing or extending the Hiring Requests, Interviews or Offers modules.
---

# HR domain patterns (Arabtec ATS)

Adapted from three Claude Academy HR use cases: "Open a new role", "Interview
debrief synthesis", and "Offer process". They describe how good hiring work is
structured; use them as the yardstick for the ATS modules that hold that work.

## The rule that governs all three
**The system prepares; people decide.** No automatic shortlist, rejection,
application, interview, offer or stage movement. The debrief pattern states it
directly: it must not recommend hire or no-hire, because that belongs to the panel.

## Opening a role → Hiring Requests
A good requisition captures: what the person will own; must-have versus
nice-to-have skills; the level (from Arabtec's 459-designation catalogue) and
reporting line; and what good looks like at 90 days. The intake should push back
on vague answers and list what is still open for the recruiter, separately from
what is decided. Audit question: does the Request wizard capture all five, and
does it separate open questions from decisions?

## Interview debrief → Interviews
A useful debrief shows where the panel converged, where it split, which signals
are strong (seen by several interviewers) versus anecdotal (seen by one), which
competencies went uncovered, and the questions to settle in the room. Audit
question: can the Interviews module show panel convergence and coverage gaps,
not just a list of scores?

## Offer package → Offers
A complete offer is the filled offer fields for review, a warm note setting up
the offer conversation, and a short summary of the role, the numbers, and why
the candidate is wanted — each reviewed by a person before the candidate sees it.
Audit question: does the Offers module keep every candidate-facing output behind
a human approval?
