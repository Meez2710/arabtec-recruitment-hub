// Benchmark tooling — the scoring rules, stated as tests.
//
// These are the definitions the acceptance criteria cite. If a rule here
// changes, the numbers change, so each is pinned.

import { describe, expect, it } from 'vitest';
import {
  buildPathIndex, checksumOf, docIdFor, rng, sampleCorpus, shuffle, verifyManifest,
} from './manifest.js';
import {
  auditAnnotations, blankTemplate, containsUnlabelled, UNLABELLED, validateGroundTruth,
} from './annotation.js';
import {
  COMPARATORS, emptyCounts, emptyFieldCounts, emptyTotals, employmentKey,
  metricOf, percentile, scoreDocument, scoreEntities, scoreScalar, scoreSet,
} from './score.js';
import { buildReport, MIN_COHORT_SIZE, renderReport } from './report.js';
import type { CandidateFile } from './manifest.js';
import type { GroundTruth, PipelineOutput } from './types.js';

const file = (n: number, ext = '.pdf'): CandidateFile => ({
  filePath: `/corpus/cv-${n}${ext}`,
  bytes: 1000 + n,
  sha256: `${String(n).padStart(4, '0')}`.repeat(16).slice(0, 64),
});

const files = Array.from({ length: 50 }, (_, i) => file(i + 1));

describe('deterministic sampling', () => {
  it('produces the identical sample for the same seed', () => {
    const a = sampleCorpus(files, { name: 'p', seed: 42, size: 10, createdAt: 'T' });
    const b = sampleCorpus(files, { name: 'p', seed: 42, size: 10, createdAt: 'T' });
    expect(a.entries.map((e) => e.docId)).toEqual(b.entries.map((e) => e.docId));
  });

  it('produces a different sample for a different seed', () => {
    const a = sampleCorpus(files, { name: 'p', seed: 1, size: 10, createdAt: 'T' });
    const b = sampleCorpus(files, { name: 'p', seed: 2, size: 10, createdAt: 'T' });
    expect(a.entries.map((e) => e.docId)).not.toEqual(b.entries.map((e) => e.docId));
  });

  it('ignores input ordering, so a filesystem cannot change the sample', () => {
    const a = sampleCorpus(files, { name: 'p', seed: 7, size: 10, createdAt: 'T' });
    const b = sampleCorpus([...files].reverse(), { name: 'p', seed: 7, size: 10, createdAt: 'T' });
    expect(a.checksum).toBe(b.checksum);
  });

  it('deduplicates by content hash — one CV under two names is one document', () => {
    const dup: CandidateFile = { ...file(1), filePath: '/corpus/copy of cv-1.pdf' };
    const m = sampleCorpus([...files, dup], { name: 'p', seed: 3, size: 50, createdAt: 'T' });
    expect(new Set(m.entries.map((e) => e.sha256)).size).toBe(m.entries.length);
  });

  it('splits into held-out and tuning without overlap', () => {
    const m = sampleCorpus(files, {
      name: 'p', seed: 5, size: 40, heldOutFraction: 0.5, createdAt: 'T',
    });
    const held = m.entries.filter((e) => e.split === 'held-out');
    const tune = m.entries.filter((e) => e.split === 'tuning');
    expect(held).toHaveLength(20);
    expect(tune).toHaveLength(20);
    const overlap = held.filter((h) => tune.some((t) => t.docId === h.docId));
    expect(overlap).toEqual([]);
  });

  it('never guesses a language cohort — a human assigns it', () => {
    const m = sampleCorpus(files, { name: 'p', seed: 9, size: 5, createdAt: 'T' });
    expect(m.entries.every((e) => e.language === null)).toBe(true);
  });

  it('detects a tampered manifest', () => {
    const m = sampleCorpus(files, { name: 'p', seed: 11, size: 6, createdAt: 'T' });
    expect(verifyManifest(m)).toBe(true);
    expect(verifyManifest({ ...m, entries: m.entries.slice(1) })).toBe(false);
    expect(checksumOf(m.entries)).toBe(m.checksum);
  });

  it('keeps file paths out of the manifest entirely', () => {
    const m = sampleCorpus(files, { name: 'p', seed: 13, size: 5, createdAt: 'T' });
    expect(JSON.stringify(m)).not.toContain('/corpus/');
    // Paths live in a separate index that stays outside Git.
    expect(Object.values(buildPathIndex(files))[0]).toContain('/corpus/');
  });

  it('derives a stable pseudonymous id from content', () => {
    expect(docIdFor('abc123def456789012345')).toBe('cv-abc123def4567890');
  });

  it('shuffles deterministically and preserves membership', () => {
    const items = [1, 2, 3, 4, 5];
    expect(shuffle(items, 4)).toEqual(shuffle(items, 4));
    expect([...shuffle(items, 4)].sort()).toEqual(items);
    expect(items).toEqual([1, 2, 3, 4, 5]); // not mutated
    const next = rng(1);
    expect(next()).toBeGreaterThanOrEqual(0);
    expect(next()).toBeLessThan(1);
  });
});

describe('annotation templates refuse to become fake ground truth', () => {
  const entry = {
    docId: 'cv-0123456789abcdef', sha256: 'x', bytes: 1, format: 'pdf' as const,
    language: null, traits: [], split: 'tuning' as const,
  };

  it('produces a blank template that fails validation until a human fills it', () => {
    const t = blankTemplate(entry);
    expect(containsUnlabelled(t)).toBe(true);
    expect(validateGroundTruth(t).ok).toBe(false);
  });

  it('rejects an untouched template rather than scoring it as all-absent', () => {
    // The dangerous failure: an empty label set would award a perfect score to a
    // pipeline that extracts nothing at all.
    const report = auditAnnotations([{ docId: entry.docId, raw: blankTemplate(entry) }]);
    expect(report.valid).toBe(0);
    expect(report.unlabelled).toBe(1);
  });

  it('accepts a fully human-labelled record', () => {
    const good = {
      ...blankTemplate(entry),
      annotator: 'mona',
      reviewedBy: 'sara',
      language: 'mixed',
      traits: ['scanned', 'multi-column'],
      fullName: { present: true, value: 'أحمد حسن' },
      location: { present: false, reason: 'not-in-document' },
      currentTitle: { present: true, value: 'Site Engineer' },
      totalYearsExperience: { present: false, reason: 'unsupported-field' },
      emails: ['ahmed@example.com'],
    };
    const r = validateGroundTruth(good);
    expect(r.ok).toBe(true);
    const audit = auditAnnotations([{ docId: entry.docId, raw: good }]);
    expect(audit.valid).toBe(1);
    expect(audit.doubleReviewed).toBe(1);
  });

  it('rejects an unknown absence reason', () => {
    const bad = {
      ...blankTemplate(entry), annotator: 'mona', language: 'english',
      fullName: { present: false, reason: 'dunno' },
      location: { present: false, reason: 'not-in-document' },
      currentTitle: { present: false, reason: 'not-in-document' },
      totalYearsExperience: { present: false, reason: 'not-in-document' },
    };
    expect(validateGroundTruth(bad).ok).toBe(false);
  });

  it('flags a record still carrying the marker even if otherwise well-formed', () => {
    expect(containsUnlabelled({ annotator: UNLABELLED })).toBe(true);
    expect(containsUnlabelled({ annotator: 'mona' })).toBe(false);
  });
});

describe('scoring rules', () => {
  it('counts a correctly reported absence as a true negative, not a miss', () => {
    const c = emptyCounts();
    scoreScalar({ present: false, reason: 'not-in-document' }, undefined, COMPARATORS.text, c);
    expect(c.trueNegatives).toBe(1);
    expect(c.falseNegatives).toBe(0);
  });

  it('counts a value invented for an absent field as a false positive', () => {
    const c = emptyCounts();
    scoreScalar({ present: false, reason: 'not-in-document' }, 'Cairo', COMPARATORS.text, c);
    expect(c.falsePositives).toBe(1);
  });

  it('excludes unreadable labels from precision and recall', () => {
    const c = emptyCounts();
    scoreScalar({ present: false, reason: 'unreadable' }, 'anything', COMPARATORS.text, c);
    expect(c.excluded).toBe(1);
    expect(c.falsePositives).toBe(0);
    expect(c.truePositives).toBe(0);
  });

  it('matches Arabic name spelling variants as correct', () => {
    const c = emptyCounts();
    scoreScalar({ present: true, value: 'أحمد حسن' }, 'احمد حسن', COMPARATORS.name, c);
    expect(c.truePositives).toBe(1);
  });

  it('matches an Arabic-Indic phone against its Latin-digit label', () => {
    const c = emptyCounts();
    scoreSet(['01001234567'], ['٠١٠٠١٢٣٤٥٦٧'], COMPARATORS.phone, c);
    expect(c.truePositives).toBe(1);
    expect(c.falsePositives).toBe(0);
  });

  it('does not match two genuinely different people', () => {
    const c = emptyCounts();
    scoreScalar({ present: true, value: 'Ahmed Hassan' }, 'Ahmed Hussein', COMPARATORS.name, c);
    expect(c.falsePositives).toBe(1);
  });

  it('scores employment entities on employer and title, ignoring date wording', () => {
    const c = emptyCounts();
    scoreEntities(
      [{ employer: 'Orascom', title: 'Site Engineer', from: '2019' }],
      [{ employer: 'orascom', title: 'site engineer', from: 'Jan 2019' }],
      employmentKey, c,
    );
    expect(c.truePositives).toBe(1);
    expect(c.falsePositives).toBe(0);
  });

  it('computes precision, recall and F1 from the counts', () => {
    const m = metricOf({
      truePositives: 8, falsePositives: 2, falseNegatives: 2, trueNegatives: 0, excluded: 0,
    });
    expect(m.precision).toBeCloseTo(0.8);
    expect(m.recall).toBeCloseTo(0.8);
    expect(m.f1).toBeCloseTo(0.8);
    expect(m.falsePositiveRate).toBeCloseTo(0.2);
  });

  it('still counts the missed values when a pipeline abstains', () => {
    const truth = {
      docId: 'cv-0000000000000001', annotator: 'a', reviewedBy: null,
      language: 'english', traits: [],
      fullName: { present: true, value: 'Ahmed Hassan' },
      emails: ['a@x.com'], phones: [],
      location: { present: false, reason: 'not-in-document' },
      currentTitle: { present: true, value: 'Site Engineer' },
      totalYearsExperience: { present: false, reason: 'not-in-document' },
      employment: [], education: [], skills: [], certifications: [], languages: [],
    } as GroundTruth;
    const output: PipelineOutput = {
      docId: truth.docId, abstained: true, permanent: false,
      employment: [], education: [], skills: [], certifications: [], languages: [],
      latencyMs: 10,
    };
    const counts = emptyFieldCounts();
    const totals = emptyTotals();
    scoreDocument(truth, output, counts, totals);
    expect(totals.abstentions).toBe(1);
    // Declining does not erase the name that was in the CV.
    expect(counts.fullName.falseNegatives).toBe(1);
    expect(counts.emails.falseNegatives).toBe(1);
  });

  it('uses nearest-rank percentiles', () => {
    expect(percentile([10, 20, 30, 40], 50)).toBe(20);
    expect(percentile([10, 20, 30, 40], 95)).toBe(40);
    expect(percentile([], 50)).toBe(0);
  });
});

describe('cohort reporting', () => {
  const truth = (docId: string, language: GroundTruth['language'],
    traits: GroundTruth['traits']): GroundTruth => ({
    docId, annotator: 'a', reviewedBy: null, language, traits,
    fullName: { present: true, value: 'Ahmed Hassan' },
    emails: [], phones: [],
    location: { present: false, reason: 'not-in-document' },
    currentTitle: { present: false, reason: 'not-in-document' },
    totalYearsExperience: { present: false, reason: 'not-in-document' },
    employment: [], education: [], skills: [], certifications: [], languages: [],
  });
  const out = (docId: string, name?: string): PipelineOutput => ({
    docId, abstained: false, ...(name !== undefined ? { fullName: name } : {}),
    employment: [], education: [], skills: [], certifications: [], languages: [],
    latencyMs: 100,
  });

  it('reports every cohort separately, never only an average', () => {
    const report = buildReport({
      pipeline: 'new', pinnedConfig: { model: 'qwen3:8b' }, split: 'held-out',
      manifestChecksum: 'abc', generatedAt: 'T',
      pairs: [
        { truth: truth('cv-1', 'english', ['digital']), output: out('cv-1', 'Ahmed Hassan') },
        { truth: truth('cv-2', 'arabic', ['scanned']), output: out('cv-2') },
      ],
    });
    const names = report.byCohort.map((c) => c.cohort);
    expect(names).toContain('english');
    expect(names).toContain('arabic');
    expect(names).toContain('scanned');
    // English found the name; Arabic did not. The average would hide that.
    expect(report.byCohort.find((c) => c.cohort === 'english')?.fields.fullName.recall).toBe(1);
    expect(report.byCohort.find((c) => c.cohort === 'arabic')?.fields.fullName.recall).toBe(0);
  });

  it('marks an underpowered cohort rather than reporting it as evidence', () => {
    const report = buildReport({
      pipeline: 'new', pinnedConfig: {}, split: 'tuning',
      manifestChecksum: 'abc', generatedAt: 'T',
      pairs: [{ truth: truth('cv-1', 'mixed', []), output: out('cv-1', 'Ahmed Hassan') }],
    });
    expect(report.overall.underpowered).toBe(true);
    expect(renderReport(report)).toContain(`fewer than ${MIN_COHORT_SIZE} documents`);
  });

  it('renders a report containing no CV content — safe to commit', () => {
    const report = buildReport({
      pipeline: 'new', pinnedConfig: { model: 'qwen3:8b' }, split: 'held-out',
      manifestChecksum: 'abc', generatedAt: 'T',
      pairs: [{ truth: truth('cv-1', 'english', []), output: out('cv-1', 'Ahmed Hassan') }],
    });
    const md = renderReport(report);
    expect(md).not.toContain('Ahmed Hassan');
    expect(md).toContain('qwen3:8b');
    expect(md).toContain('| fullName |');
  });
});
