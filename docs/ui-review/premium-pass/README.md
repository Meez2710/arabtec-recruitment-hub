# Premium product design pass — before / after evidence

Captured with Playwright/Chromium on the local synthetic build of the same code
(the on-prem host is not reachable from the build container). Desktop at
1440×900 (viewport capture), phone at 390×844 (viewport capture; the `-full`
variants in the scratch run were full-page). Same data, same accounts, same
routes, before and after.

Columns: **content y** = top of the first working element (table, board, KPI
row, list, form field) in page pixels; **head** = height of the page head;
**bands** = header-like blocks (page head, toolbar, tabs, notice, card head)
stacked above that first element; **doc** = document height.

| Viewport | Page | content y before | after | head before | after | bands before | after | doc before | after |
|---|---|---|---|---|---|---|---|---|---|
| desktop | dashboard | 279 | 161 | 82 | 73 | 2 | 1 | 1410 | 1388 |
| desktop | dashboard-recruiter | 260 | 161 | 82 | 73 | 2 | 1 | 1038 | 933 |
| desktop | requests | 329 | 268 | 82 | 73 | 2 | 2 | 900 | 900 |
| desktop | request-detail | 329 | — | 82 | 148 | 2 | 2 | 900 | 1255 |
| desktop | pipeline | 329 | — | 82 | 148 | 2 | 2 | 900 | 1237 |
| desktop | talent-pool | 441 | 349 | 178 | 141 | 3 | 3 | 1016 | 917 |
| desktop | candidate-profile | — | — | None | None | 2 | 2 | 1103 | 915 |
| desktop | interviews | 296 | 240 | 103 | 93 | 2 | 2 | 900 | 900 |
| desktop | offers | 275 | 220 | 82 | 73 | 2 | 2 | 900 | 900 |
| desktop | offer-detail | — | — | 105 | 96 | 1 | 1 | 966 | 944 |
| desktop | cv-intake | 571 | 496 | 103 | 93 | 4 | 4 | 1037 | 977 |
| desktop | candidate-review | 345 | 290 | 82 | 73 | 2 | 2 | 900 | 900 |
| desktop | org-structure | 325 | 269 | 82 | 73 | 2 | 2 | 1294 | 1212 |
| desktop | reports | 186 | 161 | 82 | 73 | 1 | 1 | 1179 | 1035 |
| desktop | workflow | — | — | 82 | 73 | 5 | 5 | 1270 | 1159 |
| desktop | email | 267 | 227 | 82 | 73 | 3 | 3 | 1758 | 1667 |
| desktop | control | 340 | 310 | 103 | 93 | 1 | 1 | 3744 | 3684 |
| desktop | users | 269 | 214 | 82 | 73 | 2 | 2 | 1084 | 1021 |
| desktop | empty-interviews-admin | 296 | 240 | 103 | 93 | 2 | 2 | 900 | 900 |
| desktop | empty-offers-admin | 275 | 220 | 82 | 73 | 2 | 2 | 900 | 900 |
| phone | dashboard | 278 | 155 | 85 | 77 | 2 | 1 | 2359 | 2517 |
| phone | dashboard-recruiter | 259 | 155 | 85 | 77 | 2 | 1 | 1615 | 1534 |
| phone | requests | 346 | 209 | 141 | 77 | 2 | 2 | 1394 | 1229 |
| phone | request-detail | — | — | 144 | 130 | 2 | 2 | 1360 | 1279 |
| phone | pipeline | — | — | 144 | 130 | 2 | 2 | 1360 | 1279 |
| phone | talent-pool | 556 | 352 | 205 | 95 | 4 | 4 | 1448 | 1259 |
| phone | candidate-profile | — | — | None | None | 2 | 2 | 1826 | 1222 |
| phone | interviews | 271 | 194 | 65 | 61 | 2 | 2 | 1753 | 1684 |
| phone | offers | 271 | 194 | 65 | 61 | 2 | 2 | 1739 | 1655 |
| phone | offer-detail | — | — | 128 | 116 | 1 | 1 | 1207 | 1180 |
| phone | cv-intake | 713 | 659 | 25 | 23 | 4 | 4 | 1210 | 1155 |
| phone | candidate-review | 393 | 340 | 117 | 77 | 2 | 2 | 935 | 873 |
| phone | org-structure | — | — | 41 | 37 | 2 | 2 | 881 | 872 |
| phone | reports | 199 | 155 | 117 | 77 | 1 | 1 | 1529 | 1356 |
| phone | workflow | — | — | 25 | 23 | 5 | 5 | 1416 | 1350 |
| phone | email | 182 | 164 | 25 | 23 | 2 | 2 | 3064 | 2981 |
| phone | control | 292 | 284 | 25 | 23 | 1 | 1 | 4076 | 4056 |
| phone | users | 254 | 210 | 85 | 77 | 2 | 2 | 1198 | 1129 |
| phone | empty-interviews-admin | 271 | 194 | 65 | 61 | 2 | 2 | 844 | 844 |
| phone | empty-offers-admin | 271 | 194 | 65 | 61 | 2 | 2 | 844 | 844 |

Phone "after" values include the 56px fixed top bar the "before" run did not
count (the content padding was measured from the document top in both runs;
the phone shell keeps its bar).

A `—` means the page has no list/table as its first element (detail pages
open on the record's own header and the working tabs below it).

## Representative pairs

| Screen | Before | After |
|---|---|---|
| Dashboard (HR Director) | before/desktop-dashboard.png | after/desktop-dashboard.png |
| Request detail | before/desktop-request-detail.png | after/desktop-request-detail.png |
| Candidate profile | before/desktop-candidate-profile.png | after/desktop-candidate-profile.png |
| Pipeline (Talent Pool board) | before/desktop-talent-pool.png | after/desktop-talent-pool.png |
| Data-heavy list (Hiring Requests) | before/desktop-requests.png | after/desktop-requests.png |
| Empty state (Offers, admin) | before/desktop-empty-offers-admin.png | after/desktop-empty-offers-admin.png |
| CV Inbox | before/desktop-cv-intake.png | after/desktop-cv-intake.png |
| Phone dashboard | before/phone-dashboard.png | after/phone-dashboard.png |
| Phone request detail | before/phone-pipeline.png | after/phone-pipeline.png |
| Phone candidate profile | before/phone-candidate-profile.png | after/phone-candidate-profile.png |
| Phone list (Requests) | before/phone-requests.png | after/phone-requests.png |
| Phone Talent Pool | before/phone-talent-pool.png | after/phone-talent-pool.png |
| Phone empty state | before/phone-empty-offers-admin.png | after/phone-empty-offers-admin.png |
