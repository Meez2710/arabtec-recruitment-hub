# CV Parser — Technical Specification

**Status:** Feature-complete and frozen for the current Arabtec Recruitment Hub scope.
Change only for a production-critical defect.

**Version:** Engine v2 · **Date:** 27 July 2026 · **Location:** `backend/src/lib/cv/`

---

## 1. Overall architecture

The parser is a set of single-responsibility modules behind a thin facade. No module
knows about HTTP, the database, or the ATS data model — parser output is generic
entities, and mapping to candidate columns happens outside this directory.

```
backend/src/lib/
├── cv-parser.js              Public facade. Re-exports only; no logic.
└── cv/
    ├── extractor.js          File bytes → plain text
    ├── section-detector.js   Text → canonical labelled sections
    ├── dictionaries.js       Domain vocabulary (data only, no logic)
    ├── entity-parser.js      Per-field detection rules
    ├── normalizer.js         Value shaping (pure, idempotent)
    ├── validator.js          Four-state plausibility classification
    ├── confidence-engine.js  Deterministic scoring + parse status
    ├── ai-parser.js          ONLY module permitted outbound network access
    └── index.js              Pipeline orchestration
```

### Design rules

1. **No database access inside `cv/`.** Verified: zero `INSERT`/`UPDATE`/`run()`.
2. **No logging inside `cv/`.** Verified: zero `console.*`. CV content is never logged.
3. **No temp files.** Read-only on disk.
4. **Deterministic.** Same input → identical output. No randomness, no clocks in
   decisions (except the current year for plausibility bounds).
5. **One generic pipeline.** No language-specific branches; languages contribute
   vocabulary, not code paths.
6. **Fail conservative.** An implausible value becomes `null`, never a guess.

---

## 2. Parsing pipeline

```
CV file
   ↓  extractor.js         pdf-parse / mammoth / utf-8
plain text
   ↓  section-detector.js  headings → canonical sections
sectioned text
   ↓  entity-parser.js     detectors → { value, method }
raw detections
   ↓  normalizer.js        value shaping
normalized values
   ↓  validator.js         verified | likely | uncertain | rejected
validated values
   ↓  confidence-engine.js per-field score + overall + parse status
structured candidate output
```

Every failure path returns an empty or null result rather than throwing, so one
malformed CV cannot break a bulk import batch.

---

## 3. Module responsibilities

| Module | Responsibility | Must never |
|---|---|---|
| `extractor.js` | File → text. Only format-aware layer. | Interpret content |
| `section-detector.js` | Heading normalisation, section boundaries | Extract field values |
| `dictionaries.js` | Vocabulary and patterns | Contain logic |
| `entity-parser.js` | Field detection, records *how* found | Persist or log |
| `normalizer.js` | Shape values; pure and idempotent | Invent or infer data |
| `validator.js` | Plausibility classification | Modify values (only nulls rejects) |
| `confidence-engine.js` | Scoring and status | Detect anything |
| `ai-parser.js` | Optional gated enrichment | Run without all four gates |
| `index.js` | Pipeline order | Contain detection rules |

---

## 4. Section detection

Headings are folded (case, accents, Arabic diacritics and letter variants stripped,
punctuation removed) then matched **exactly** against a term index sorted
longest-first, so `work experience` wins over `experience`.

**Canonical sections:** `experience`, `education`, `skills`, `summary`,
`certifications`, `projects`, `languages`, `contact`, `references`.
Everything before the first recognised heading becomes `header` — where names and
contact details normally sit.

### Multilingual support

| Language | Handling |
|---|---|
| English | Direct |
| Arabic | Diacritics/tatweel stripped; `أإآٱ→ا`, `ى→ي`, `ة→ه`, `ؤئ→ء` |
| German | Accents folded, `ß→ss` |
| French | Accents folded |

Verified: 26/26 heading variants across all four languages, zero false positives on
body text.

**Heading guards:** ≤60 chars, ≤5 words, not a sentence. Prevents
"I have 8 years of experience…" being read as a heading.

**Fallback:** with no recognised heading the whole document is `header`; detectors
fall back to nearby/global strategies at reduced confidence.

---

## 5. Entity extraction

Three-tier priority per field. A section-anchored hit always beats a global regex.

| Field | 1. Section | 2. Nearby | 3. Global |
|---|---|---|---|
| `full_name` | `header` | first 8 lines | filename |
| `email` | — | — | strict pattern |
| `phone` | labelled (`Mobile:`) | — | 9–15 digit run |
| `location` | `header`/`contact` | first 15 lines | city dictionary / `City, Country` |
| `current_company` | `experience` marked *Present* | narrative `at/with/for` | suffix-bearing line |
| `current_position` | same entry, title half | narrative | header tagline (guarded) |
| `years_experience` | — | — | `N years of experience` |
| `role_applied` | — | — | always `null` (never inferred) |
| `university` | `education` | — | institution-token line |
| `major` | `education` | — | longest keyword match |
| `graduation_year` | `education` | line naming a degree | — |
| `degree` | `education` | — | degree pattern |

### Two guards that matter

**Headline rejection (F1).** A company must show organisation evidence — corporate
suffix, `&`, legal form, university token, or a multi-word capitalised proper noun.
Personal headlines (`Fresh Graduate – Civil Engineering`, `Seeking a role…`,
`8 years of experience`) are rejected outright. The company fallback additionally
skips `education`, `summary`, `skills`, `certifications`, `languages` and
`references` sections — `B.Sc. Civil Engineering` matches the suffix "engineering"
but is a qualification, not an employer.

**Narrative splitting (F2).** `Site Engineer at Orascom Construction since 2019` →
title `Site Engineer`, company `Orascom Construction`. Trailing dates and
`since/from` clauses are stripped first. The connector is itself the evidence, so a
suffix is not additionally required — otherwise single-word employers such as
`Arabtec` are lost. Returns `null` when the line is not a recognisable role
sentence, so a whole sentence can never land in either field. Neither half may
exceed 8 words.

---

## 6. Normalization

All functions are pure and idempotent: `f(f(x)) === f(x)`.

| Type | Rule |
|---|---|
| **Job title** | 16 abbreviations expanded (`Sr.`→Senior, `Eng.`→Engineer, `Mgr.`→Manager), title-cased, acronyms preserved (HSE, QA/QC, MEP, HVAC, BIM, IT, HR, CAD, PMO) |
| **Degree** | Mapped to six levels: Bachelor's, Master's, Doctorate, Diploma, Associate's, Technical Certificate |
| **University** | Whitespace/punctuation only; leading `at/from/graduated from` and trailing years removed. **Never corrected against a registry.** |
| **Company** | Whitespace and punctuation only. **No registry matching, no expansion.** |
| **Location** | Spacing and capitalisation; canonical casing from a 52-city / 22-country MENA-GCC list. **No geocoding, no country inference.** |
| **Section** | Fold case, accents, Arabic variants; strip decoration |

---

## 7. Validation

Four states, not a boolean:

| State | Meaning | Effect |
|---|---|---|
| `verified` | Strong structural evidence | Kept |
| `likely` | Plausible, minor doubt | Kept |
| `uncertain` | Kept but should be reviewed | Kept, flagged |
| `rejected` | Implausible | **Value nulled** |

**Examples.** A name from filename is `uncertain`, never `verified`. A university
without an institution token is `rejected`. A future graduation year is `likely`.
A company found in the correct section *with* a corporate suffix is `verified`;
with only one of those, `likely`.

**Rejection criteria** include: names outside 2–5 words or containing digits;
emails failing the strict pattern; phones outside 9–15 digits; years outside
1950…currentYear+6; experience outside 0–60; free text outside length bounds.

---

## 8. Confidence

Deterministic and decomposable. No model, no probability estimate.

```
field confidence = METHOD_WEIGHT × VALIDATION_WEIGHT
overall = Σ(FIELD_WEIGHT × confidence) / Σ(FIELD_WEIGHT)
```

| Method | Weight | | Validation | Weight |
|---|---|---|---|---|
| section / labelled | 1.00 | | verified | 1.00 |
| nearby | 0.85 | | likely | 0.85 |
| global | 0.70 | | uncertain | 0.55 |
| filename | 0.35 | | rejected | 0 |

**Field weights:** `full_name` 2.0 · `email` 1.5 · `current_company` 1.5 ·
`current_position` 1.5 · `phone` 1.0 · `location` 1.0 · `university` 1.0 ·
`major` 0.75 · `graduation_year` 0.75 · `years_experience` 0.5 · `role_applied` 0.25

### Parse status — quality, not quantity

| Status | Condition |
|---|---|
| `failed` | No text, or nothing usable extracted |
| `partial` | Usable but incomplete |
| `review` | All core fields present but some uncertain — needs a human |
| `done` | All 7 core fields present, none uncertain, overall ≥ 0.75 |

`done` is a statement about **reliability**, not completeness. A CV with many
populated but doubtful fields cannot reach `done`. Every status carries a
`parse_status_reason` string naming the missing or uncertain fields.

**Core fields:** `full_name`, `current_company`, `current_position`, `location`,
`university`, `major`, `graduation_year`.

---

## 9. Supported formats

| Format | Library | Notes |
|---|---|---|
| PDF | `pdf-parse` | Text-layer only; scanned PDFs yield no text |
| DOCX | `mammoth` | Raw text extraction |
| DOC | `mammoth` | Legacy support, less reliable |
| TXT | `fs` | UTF-8 |

Upload ceiling **20 MB**, with MIME and extension validation. Measured: 2.26 MB of
text (20,011 lines) parses in 67 ms using +9.6 MB heap.

**Performance:** 0.18 ms/CV average, ~5,600 CV/s single-threaded. No heap growth
across 1,500 parses (+0.17 MB). Bottleneck is text extraction, not the rules.

---

## 10. Current limitations

### Critical
None outstanding.

### High
- **Two-column PDF layouts** interleave on extraction; sections become unreliable.
  The parser returns nulls rather than corrupt values — correct but incomplete.
- **Real-binary extraction unverified.** All 30 QA fixtures are `.txt`; PDF/DOCX
  extraction has not been exercised against real files.
- **Scanned PDFs** produce no text (`parse_status: failed`). Requires OCR.

### Medium
- **Table-structured CVs** parse partially; label/value rows are not understood.
- **Employment history** — only the current role; prior roles are not captured.
- **`years_experience`** requires the literal phrase; not computed from dates.
- **Skills** are never extracted, though the section is detected.
- **Multi-line experience entries** (company, title, dates on separate lines) miss.

### Low
- Arabic-script names are preferred over a Latin transliteration when both appear.
- The first email wins; personal addresses are not deprioritised.
- Company names in all-caps are not re-cased (deliberate: no invention).

---

## 11. Extension points

Each future capability attaches without modifying existing parser logic.

| Capability | Extension point |
|---|---|
| **Skills extraction** | New `detectSkills()` in `entity-parser.js` + `skills` group in `index.js`. The `skills` section is already detected. |
| **Employment history** | New module `cv/history-parser.js` consuming `sectionLines(detected,'experience')`; `splitRole()` is reusable per entry. |
| **Languages / certifications** | Sections already detected; add detectors following the `{ value, method }` contract. |
| **AI enrichment** | `ai-parser.js` exists and is gated. Add fields to its schema; the orchestrator already merges AI results over heuristics with `parsed_by` provenance. |
| **OCR** | New branch in `extractor.js` only. Everything downstream is text-agnostic. |
| **Candidate matching / semantic search** | Consume `parseEntities()` output. Normalised title, company, university and location are already comparable keys. |
| **Talent intelligence** | `metadata.overall_confidence` and per-field `validation` support quality-weighted aggregation. |
| **New language** | Add terms to `HEADING_TERMS` in `dictionaries.js`. No code change. |

### Contracts to preserve

1. Detectors return `{ value, method }`.
2. `heuristicParse()` output stays byte-identical (legacy consumers depend on it).
3. `parseEntities()` returns `{ personal, employment, education, metadata }`.
4. No module under `cv/` gains database access, logging, or ungated network access.

---

## 12. Public API

```js
// Legacy — byte-identical to the pre-refactor parser. Do not change.
heuristicParse(text, filename) → { full_name, email, phone, years_experience,
                                    role_applied, raw_text, extraction_status }

// Rich — the shape persistence should consume.
parseEntities(text, filename)  → { personal, employment, education, metadata }
parseEntitiesFromFile(path)    → same, reading and extracting the file

extractText(path) / extractTextAsync(path)
extractPhone(text)
isAiEnabled(opts) / aiGateStatus(opts)
```

**`parseEntities` never returns `raw_text`.** Extracted CV text is not persisted;
the uploaded file is the single source of truth and is re-read on re-parse.

---

## 13. AI gating

Four independent gates, **all** required. Default in every environment: OFF.

1. `CV_AI_PARSING_ENABLED === 'true'`
2. `feature.ai_parsing` flag enabled (database, defaults disabled)
3. `ANTHROPIC_API_KEY` present
4. Caller passes `{ allowAi: true }`

Verified with a `fetch` trip-wire: key + env flag + caller opt-in with the database
flag off yields `allowed=false` and **zero outbound attempts**. On failure or
timeout the heuristic result is kept and `parsed_by` records `heuristic`.
