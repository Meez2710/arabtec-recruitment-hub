---
name: ats-vendor-risk
description: Assess the third-party services the Arabtec ATS depends on — Microsoft 365 / Graph, the Anthropic API, Power Automate, the SMTP relay — and give a go/no-go with required mitigations and owners. Use when adding or changing an external dependency, or when asked what could fail outside the ATS.
---

# Vendor risk review (Arabtec ATS)

Adapted from the Claude Academy "Vendor risk review" use case.

## The ATS's external dependencies
| Vendor | What the ATS uses it for | Failure looks like |
|---|---|---|
| Microsoft 365 / Graph | reads `career@arabtecegy.com`; sends mail when `MS_ENABLE_SEND=true` | intake stops; notifications silent |
| Anthropic API | CV parsing (`ANTHROPIC_MODEL`) | CVs stay WAITING, never parsed |
| Power Automate | unknown flows on the M365 side | mail moved out of Inbox, never seen by Graph |
| SMTP relay (Office 365) | fallback mail; basic SMTP AUTH is refused (535) | no fallback when Graph is down |

## Method
1. For each vendor gather what exists: the scopes consented in Entra, data
   sent (CV contents go to Anthropic), retention, the contract or DPA if the user has it.
2. Score against: data sensitivity (CVs are personal data), blast radius if it
   fails, whether the ATS degrades safely, and whether anyone would notice.
3. Give **go or no-go** per vendor, then the required mitigations — each one
   discrete, with an owner, and citing where the evidence came from.
4. Never read or print a secret to do this. Configuration is SET or MISSING.

## Output
`docs/audits/vendor-risk-<date>.md`: one row per vendor, the call, and the
mitigation list. An unobservable failure (Power Automate moving mail) counts as a
mitigation gap even if nothing has broken yet.
