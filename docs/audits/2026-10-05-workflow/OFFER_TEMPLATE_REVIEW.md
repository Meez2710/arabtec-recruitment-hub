# Offer template fidelity — independent review

Date: 5 October 2026. Status: FAIL — corrections required.
Owner request: show the offer template and ensure it matches the supplied original,
changing only the fields that should vary.

## Sources
Original supplied PDFs found locally:
- /Users/moutazadly/Downloads/Eng. Basem Ahmed Wahdan - Job Offer.pdf
- /Users/moutazadly/Downloads/Eng. Heba El Shiekh - Job Offer.pdf
- /Users/moutazadly/Downloads/Mr. Bishoy Yaacoub - Job Offer.pdf

Codex rendered and visually inspected both Bishoy reference pages. The repository
docs/HANDOFF.md identifies these three originals as the intended fixed/variable
reference set. Do not use unrelated offers in Downloads as the company template.
Do not copy a real signature or applicant personal values into a new offer.

Current output inspected: localhost:4398/api/offers/1/preview, synthetic draft
OFR-2026-00001, implemented by backend/src/lib/email_templates.js offerLetterHtml
and backend/src/routes/offers.js preview route.

## Confirmed differences
1. Original branded symbol + black arabtec wordmark is replaced by red text
   and a red top rule. Footer red rule placement and header spacing differ.
2. Original footer telephone numbers are (+202)24146760 and (+202)24146761.
   Generated letter uses 24159266 / 24159267 and relabels the second as Fax.
3. Original fixed paragraph says terms are valid only if all the candidate's
   documents accord with employment prerequisites. Generated paragraph drops
   that condition and says the terms themselves are in accordance.
4. Original signatory title is Human Resources Director; generated says HR Director.
   Candidate acceptance/signature block placement differs materially.
5. Form supports flat salary and free-text benefits but original offers show
   separate Basic Salary, Accommodation, Transportation, Others and sometimes
   Area Allowance. Current preview hides free-text benefits and uses one Basic
   Salary amount. The original breakdown cannot be entered naturally through UI.
6. Expiry is collected by the form but preview hardcodes five days from creation.
   The authored expiryDate and letter validity can disagree.
7. User cannot preview the letter from the current offer detail UI, although
   /preview exists. Codex opened it directly to satisfy the owner's request.

## Acceptance required
Compare all three originals; preserve exact fixed wording, layout, letterhead,
footer, two-page structure and signatory title. Explicitly enumerate variable
fields: reference/date, prefix/name/salutation, position, compensation components
and total, permitted probation/validity values and conditional allowance footnotes.
Use synthetic examples only for proof. Do not invent or rewrite legal language.

Ensure form -> saved record -> preview -> issued output/email use the same
values. Add visible Preview/Print action, salary permission enforcement on the
preview route, HTML escaping of variable text, and representative PDF rendering
checks (long names/positions and breakdowns). Compare both pages before acceptance.

Send implementation and test evidence to Codex for review before deployment.
