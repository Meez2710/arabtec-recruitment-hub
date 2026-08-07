// Validate ground-truth label files, and report inter-annotator agreement.
//
//   npx tsx src/infrastructure/tools/parser-bench/validate-labels.ts <dir> [<dir2>]
//
// One directory  → structural validation only.
// Two directories → validation plus a field-by-field disagreement report between
//                   two independent annotators, which is the whole point of
//                   calibration: a field two careful people label differently is
//                   a field whose DEFINITION is wrong, not a person who is wrong.
//
// PRIVACY: prints docIds, field names and counts. It never prints a label value,
// so the output is safe to paste into a ticket or a chat.

import fs from 'node:fs';
import path from 'node:path';
import { auditAnnotations, validateGroundTruth } from './annotation.js';
import { comparisonKey, emailMatchKey, normalizePhone } from '../../../modules/shared/kernel/text.js';
import type { GroundTruth, LabelledValue } from './types.js';

const readLabels = (dir: string): { docId: string; raw: unknown }[] => {
  if (!fs.existsSync(dir)) {
    console.error(`No such directory: ${dir}`);
    process.exit(2);
  }
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => {
      const full = path.join(dir, f);
      try {
        return { docId: path.basename(f, '.json'), raw: JSON.parse(fs.readFileSync(full, 'utf8')) };
      } catch (error) {
        return { docId: path.basename(f, '.json'), raw: { __parseError: String(error) } };
      }
    });
};

const scalarKey = (v: LabelledValue): string =>
  (v.present ? `value:${comparisonKey(v.value)}` : `absent:${v.reason}`);

/** Field-level comparison. Normalized, so spelling variance is not disagreement. */
const disagreements = (a: GroundTruth, b: GroundTruth): string[] => {
  const out: string[] = [];
  const scalar = (name: string, x: LabelledValue, y: LabelledValue): void => {
    if (scalarKey(x) !== scalarKey(y)) out.push(name);
  };
  const set = (name: string, x: readonly string[], y: readonly string[],
    norm: (s: string) => string): void => {
    const sx = new Set(x.map(norm));
    const sy = new Set(y.map(norm));
    if (sx.size !== sy.size || [...sx].some((k) => !sy.has(k))) out.push(name);
  };

  if (a.language !== b.language) out.push('language');
  set('traits', a.traits, b.traits, (s) => s);
  scalar('fullName', a.fullName, b.fullName);
  scalar('location', a.location, b.location);
  scalar('currentTitle', a.currentTitle, b.currentTitle);
  scalar('totalYearsExperience', a.totalYearsExperience, b.totalYearsExperience);
  set('emails', a.emails, b.emails, emailMatchKey);
  set('phones', a.phones, b.phones, (s) => normalizePhone(s).matchKey ?? s);
  set('skills', a.skills, b.skills, comparisonKey);
  set('certifications', a.certifications, b.certifications, comparisonKey);
  set('languages', a.languages, b.languages, comparisonKey);
  set('employment', a.employment.map((e) => `${e.employer}|${e.title}`),
    b.employment.map((e) => `${e.employer}|${e.title}`), comparisonKey);
  set('employmentDates', a.employment.map((e) => `${e.from ?? ''}|${e.to ?? ''}`),
    b.employment.map((e) => `${e.from ?? ''}|${e.to ?? ''}`), (s) => s);
  set('education', a.education.map((e) => e.institution),
    b.education.map((e) => e.institution), comparisonKey);
  return out;
};

const main = (): void => {
  const [dirA, dirB] = process.argv.slice(2);
  if (dirA === undefined) {
    console.error('usage: validate-labels.ts <labels-dir> [<second-annotator-dir>]');
    process.exit(2);
  }

  const recordsA = readLabels(dirA);
  const auditA = auditAnnotations(recordsA);

  console.log(`\nValidation — ${dirA}`);
  console.log(`  files            : ${auditA.total}`);
  console.log(`  valid            : ${auditA.valid}`);
  console.log(`  still templates  : ${auditA.unlabelled}`);
  console.log(`  double-reviewed  : ${auditA.doubleReviewed}`);
  for (const bad of auditA.invalid) {
    console.log(`  ✗ ${bad.docId}`);
    for (const e of bad.errors.slice(0, 6)) console.log(`      ${e}`);
  }

  if (dirB === undefined) {
    console.log(auditA.invalid.length === 0
      ? '\n✓ All label files are structurally valid.\n'
      : `\n✗ ${auditA.invalid.length} file(s) need attention.\n`);
    process.exit(auditA.invalid.length === 0 ? 0 : 1);
  }

  /* ------------------------- two-annotator agreement ---------------------- */

  const recordsB = readLabels(dirB);
  const auditB = auditAnnotations(recordsB);
  console.log(`\nValidation — ${dirB}`);
  console.log(`  files: ${auditB.total} · valid: ${auditB.valid} · templates: ${auditB.unlabelled}`);

  const byId = (records: { docId: string; raw: unknown }[]): Map<string, GroundTruth> => {
    const map = new Map<string, GroundTruth>();
    for (const r of records) {
      const v = validateGroundTruth(r.raw);
      if (v.ok) map.set(r.docId, v.value);
    }
    return map;
  };
  const a = byId(recordsA);
  const b = byId(recordsB);
  const shared = [...a.keys()].filter((id) => b.has(id)).sort();

  console.log(`\nAgreement — ${shared.length} document(s) labelled by both`);
  if (shared.length === 0) {
    console.log('  Nothing to compare yet.\n');
    process.exit(1);
  }

  const fieldCounts = new Map<string, number>();
  let clean = 0;
  for (const id of shared) {
    const diff = disagreements(a.get(id) as GroundTruth, b.get(id) as GroundTruth);
    if (diff.length === 0) { clean += 1; continue; }
    console.log(`  ${id}: ${diff.join(', ')}`);
    for (const f of diff) fieldCounts.set(f, (fieldCounts.get(f) ?? 0) + 1);
  }

  console.log(`\n  fully agreeing documents: ${clean}/${shared.length}`);
  if (fieldCounts.size > 0) {
    console.log('\n  Disagreement by field — each one is a field DEFINITION to fix:');
    for (const [field, n] of [...fieldCounts.entries()].sort((x, y) => y[1] - x[1])) {
      console.log(`    ${String(n).padStart(3)}/${shared.length}  ${field}`);
    }
    console.log('\n  Reconcile these in reconciliation.md before labelling anything else.\n');
  } else {
    console.log('\n✓ No disagreements. The schema is ready for the remaining documents.\n');
  }

  process.exit(fieldCounts.size === 0 && auditA.invalid.length === 0
    && auditB.invalid.length === 0 ? 0 : 1);
};

main();
