# Page-by-page review — owner instructions

Live review of the company ATS (http://10.20.0.9:4001, release `6bd501a`), started 4 October 2026.
Process: Claude opens each page in the browser pane (owner signed in), describes what it sees and the weak points, the owner answers, and the owner's answer is recorded here as the instruction for that page. Nothing is changed in production during the review; agreed changes are implemented, tested and released afterwards.

| # | Page | Claude's observations | Owner instruction | Status |
|---|---|---|---|---|
| 0 | All pages (global) — footer quotes | — | Replace the footer quotes with the owner's 150-quote list; give the editor add / remove / replace controls. | Done — deployed in `4504ecf` |
| 0 | All pages (global) — desktop sidebar | Desktop sidebar is charcoal while the phone menu is light. | Make the desktop sidebar light grey like the phone, **not white**, a little darker than the page background. | Done — `#E8EAED` on the `#F4F5F7` canvas, green active item |
| 1 | Dashboard | One request repeated in 6 cards; age counted while awaiting approval; Candidate Review count not shown; empty Recruiter workload box; "Offer approvals" primary with 0 offers; role tabs unexplained; emoji icons in footer; duplicated branding in top bar. | *(awaiting owner answer)* | Open |
