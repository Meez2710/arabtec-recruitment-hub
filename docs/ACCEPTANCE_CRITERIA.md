# Acceptance Criteria — CV Parsing Migration

**Frozen before results exist.** That is the point: thresholds agreed after seeing numbers
are not thresholds. Every rule below is implemented in
[score.ts](backend/src/infrastructure/tools/parser-bench/score.ts) and
[report.ts](backend/src/infrastructure/tools/parser-bench/report.ts), and pinned by 28 tests
in [parser-bench.test.ts](backend/src/infrastructure/tools/parser-bench/parser-bench.test.ts).

---

## 1. Normalization used for comparison

Comparison is normalized, or the numbers measure spelling rather than extraction.
Implemented in [text.ts](backend/src/modules/shared/kernel/text.ts) (24 tests).

| Field | Comparator | Rule |
| --- | --- | --- |
| Name, location, title, skills, certifications, languages | `COMPARATORS.name` / `.text` | NFC · invisible bidi marks and tatweel stripped · Arabic letter variants folded (أإآٱ→ا, ى→ي, ة→ه, ؤئ→ء) · diacritics stripped · Latin accents folded · lowercased · punctuation → space |
| Email | `COMPARATORS.email` | whitespace removed · domain lowercased · whole string lowercased for the key only |
| Phone | `COMPARATORS.phone` | Arabic-Indic **and** Eastern Arabic-Indic digits → ASCII · non-digits removed · leading `00` dropped · **last 9 digits** compared |
| Years of experience | numeric | `String(Number(v))` |

**Not applied to stored values.** Normalization produces a *key*. The raw extracted value is
retained — folding is lossy and would destroy the spelling a candidate actually uses.

## 2. Matching rules

**Scalars** — normalized exact match.

**Sets** (emails, phones, skills, certifications, languages) — set comparison on normalized
keys. Each unmatched prediction is one false positive; each unmatched label one false
negative.

**Entities**

| Entity | Match key | Why |
| --- | --- | --- |
| Employment | `(employer, title)` normalized | Dates are written a dozen ways; a format disagreement is not a failure to find the job |
| Education | `institution` normalized | Qualification wording varies too much to be a match key |

Date accuracy is reported separately and is not part of entity F1.

## 3. Counting

| Situation | Bucket |
| --- | --- |
| Value exists, predicted correctly | true positive |
| Value exists, predicted wrongly | false positive |
| Value exists, not predicted | false negative |
| **No value exists, none predicted** | **true negative** — correct, not a miss |
| **No value exists, one predicted** | **false positive** — this is the hallucination signal |
| Label says `unreadable` | **excluded** from precision and recall, counted separately |
| Pipeline abstained | counted in the abstention rate; the CV's values still count as false negatives |

- `precision = TP / (TP + FP)` · `recall = TP / (TP + FN)` · `f1 = 2PR/(P+R)`
- `falsePositiveRate = FP / (TP + FP)`
- `coverage = (TP + FP) / (TP + FP + FN + TN)`
- Abstention rate is reported separately, so a pipeline cannot buy precision by silently
  declining the hard documents.

**Absence must be labelled by cause** — `not-in-document`, `unreadable`, or
`unsupported-field`. Collapsing these makes the benchmark meaningless: a parser that misses a
phone number and one that correctly reports there is none would score identically.

## 4. Document-structure metrics

Human judgement against rendered output, recorded per document. A pipeline cannot
self-report these.

| Metric | Definition |
| --- | --- |
| Correct reading order | Content read top-to-bottom in the order a human reads it |
| Multi-column success | No content from one column interleaved into another |
| Table preservation | Row/column structure recoverable from the output |
| Page loss | Pages present in the source and absent from the output |
| Unreadable-document rate | Documents no pipeline could convert |

## 5. Cohort reporting — mandatory

Every metric is reported **overall and per cohort**. Language cohorts: `arabic`, `english`,
`mixed`. Trait cohorts: `digital`, `scanned`, `image-heavy`, `single-column`,
`multi-column`, `has-tables`, `long`, `malformed`. Cohorts overlap.

A cohort with **fewer than 8 documents** is flagged `⚠︎ underpowered` and is indicative only,
never evidence. **An overall average may not be used to report a cohort's result.**

## 6. Fields requiring human labels

All of them. No metric below can be computed without ground truth, and no label may be
seeded from a parser's output — an annotator confirming a pre-filled value measures the
parser, not the CV. Templates carry `__UNLABELLED__` and fail validation until replaced.

Required per document: name · emails · phones · location · current title · total experience ·
employment entries · education entries · skills · certifications · languages · language
cohort · document traits.

**≥ 20% of the set must be double-reviewed** (`reviewedBy` non-null) to detect annotation
error.

## 7. Pass thresholds — held-out set only

| # | Criterion | Threshold |
| --- | --- | --- |
| 1 | Email precision **and** recall | ≥ 99% |
| 2 | Phone precision **and** recall | ≥ 98% |
| 3 | Name normalized exact match | ≥ 97% |
| 4 | Current/recent title | ≥ 93% |
| 5 | Work-history entity F1 | ≥ 90% |
| 6 | Education entity F1 | ≥ 90% |
| 7 | Skills + certifications entity F1 | ≥ 85% |
| 8 | Critical-field false-positive rate (name, email, phone) | ≤ 1% |
| 9 | Correct reading order | ≥ 95% |
| 10 | Table preservation | ≥ 90% |
| 11 | CVs silently discarded | **0** |
| 12 | Raw CV content or PII in normal logs | **none** |
| 13 | External network calls during runtime parsing | **none** |
| 14 | Parse CV endpoint request/response contract | unchanged |
| 15 | Proposal, review, validation, persistence behaviour | unchanged |

**Comparative**

| # | Criterion | Threshold |
| --- | --- | --- |
| 16 | Composite primary score vs legacy baseline | documented, meaningful improvement |
| 17 | Regression in any critical contact field (name, email, phone) | ≤ 1 percentage point |
| 18 | Regression in any cohort (arabic / english / mixed / scanned / multi-column) | none material |
| 19 | Latency and memory | within the Stage 2 budget **measured on the accepted host** |

**Composite primary score** = mean F1 across name, email, phone, title, employment,
education, weighted 2/2/2/1/2/1.

### Latency and memory

**Deliberately unset.** No target hardware has been accepted. Provisional go/no-go values are
in [STAGE2_RUNTIME_REQUIREMENTS.md](docs/STAGE2_RUNTIME_REQUIREMENTS.md) §6 and become binding
only when a machine passes its smoke benchmark. A threshold invented without hardware is a
number, not a criterion.

## 8. Protocol

- The **held-out set is used once**, after tuning is frozen. It does not move after results
  are seen.
- Tuning happens on the tuning split only.
- Before the held-out run, pin: Docling version and pipeline config, Ollama version, model
  name + digest + quantization, context size, prompt version, schema version.
- Report every cohort and every failed criterion. **If a threshold is not met, it is not
  lowered** — report the failing fields, examples (by `docId`, never by content), likely
  cause, and recommended action.
- No criterion may be declared passed from selected examples.

## 9. Current status

**No criterion has been evaluated.** Blocked on human ground-truth labels and on an accepted
runtime host.

### The 40-CV sample is NOT an acceptance benchmark

It is a **40-CV tooling and annotation-schema pilot; not an acceptance or production cutover
set.** Its 20-document "held-out" split is **not** the final held-out acceptance set and must
not be reported as one.

Three reasons, each disqualifying on its own:

1. **Language is unknown.** Every manifest entry carries `language: null`. Nothing has
   assigned an authoritative cohort.
2. **Arabic and mixed representation is insufficient.** Of 666 unique documents probed, only
   **1 is Arabic-dominant and 5 are mixed**. Criterion 18's Arabic and mixed cohorts cannot
   be evaluated at all, and §5's 8-document minimum cannot be met.
3. **Image-only documents cannot be language-classified before OCR.** 31 of the 666 have no
   text layer, so their script is unknowable until OCR exists — which is one of the things
   being evaluated.

The seed (`20260807`), checksum
(`2d064f6c15ff2eadbb97dda53e496ae1d660ba86bddfeb2c6a8081e44a5526cf`) and manifest are
preserved for reproducibility of the **tooling**, not of any accuracy result.

### The acceptance corpus must be rebuilt

Only after all three hold:

- **OCR-based language classification is available**, so image-only documents can be assigned
  a cohort
- **Enough Arabic and mixed-language CVs have been sourced** to meet §5's per-cohort minimum.
  This is a sourcing problem — no sampling strategy fixes a corpus that does not contain the
  documents
- **The annotation schema has passed calibration** (see the five-CV package under
  `backend/data/bench/calibration/`)

Until then no number produced from this sample may be presented as an acceptance result.
