# Pattern audit — status badges

Method: `.claude/skills/ats-pattern-consistency-audit`. Date: 23 Sep 2026.
Scope: every badge in `app.jsx` and the four modules, against the six stylesheets.

## Variants found

| Surface | Component | Renders via | Verdict |
|---|---|---|---|
| Requests, Offers, Interviews, Talent Pool stages | `ReqStatusBadge`, `OfferStatusBadge`, `IvStatusBadge`, `AppStatusBadge`, `PriorityBadge`, `StatusBadge`, `HistoryBadge` | canonical `<Badge variant>` | ✅ consistent |
| CV Inbox (states, Microsoft status) | `h(Badge, …)` | canonical `<Badge variant>` | ✅ — migrated off a local `Pill` in `fdc609e` |
| Match score | `ScoreBadge` | own `span.score-badge` | ✅ **intentional** — a number on a 3-band scale, not a status |
| Talent Pool data-quality labels | `QualityBadges` | own `span.cc-flag` + hard-coded hex | ❌ **bypasses the palette** |
| Direct JSX | `<Badge>` | — | 32 call sites, all resolve |

## Classes emitted vs defined

Every `badge-*` class emitted in JSX is defined in the stylesheets. The two
apparent dead classes were false positives: `badge-danger` appears only inside an
explanatory comment, and `badge-btn` is a substring of `hist-badge-btn`, which is
defined.

## Recommendation

Reuse `<Badge variant>`. Migrate `QualityBadges` onto it and delete the `.cc-flag`
hex rules.

Also correct its colour semantics. It showed `Contact Missing` in red. The red
`critical` variant is what the product uses for Rejected and Failed, so on a
candidate card red reads as "this person was turned down". That contradicts
the no-automatic-rejection principle. Two tiers instead:

- **warning (amber)** — actionable: Needs Review, Possible Duplicate, Contact Missing
- **soft (grey)** — informational: Incomplete Profile, Low Confidence, Unclassified
