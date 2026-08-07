// Assemble the five-CV calibration package.
//
//   npx tsx src/infrastructure/tools/parser-bench/build-calibration.ts
//
// Selects five documents from the TUNING split only — never the held-out split —
// and only ones with a readable text layer, because a calibration round is about
// whether two people agree on FIELD DEFINITIONS, and an unreadable scan tests
// eyesight instead.
//
// It writes EMPTY templates for two independent annotators. It never prefills,
// infers, or copies a value from any parser: a label seeded with a machine's
// guess measures the machine, not the CV.

import fs from 'node:fs';
import path from 'node:path';
import { blankTemplate } from './annotation.js';
import type { CorpusManifest } from './types.js';

const BENCH = path.resolve(process.cwd(), 'data/bench');
const OUT = path.join(BENCH, 'calibration');
const SIZE = 5;

interface Provisional {
  readonly docId: string;
  readonly hasTextLayer: boolean;
  readonly provisionalScript: string;
  readonly format: string;
}

const read = <T>(file: string): T => JSON.parse(fs.readFileSync(file, 'utf8')) as T;

const main = (): void => {
  const manifest = read<CorpusManifest>(path.join(BENCH, 'manifest.json'));
  const provisional = read<Provisional[]>(path.join(BENCH, 'stratification.provisional.json'));
  const readable = new Map(provisional.map((p) => [p.docId, p]));

  // Tuning split only, readable only, manifest order (already seeded/shuffled).
  const chosen = manifest.entries
    .filter((e) => e.split === 'tuning')
    .filter((e) => readable.get(e.docId)?.hasTextLayer === true)
    .slice(0, SIZE);

  if (chosen.length < SIZE) {
    console.error(`Only ${chosen.length} readable tuning documents available; need ${SIZE}.`);
    process.exit(1);
  }

  for (const reviewer of ['reviewer-a', 'reviewer-b']) {
    const dir = path.join(OUT, reviewer);
    fs.mkdirSync(dir, { recursive: true });
    for (const entry of chosen) {
      const target = path.join(dir, `${entry.docId}.json`);
      if (fs.existsSync(target)) continue; // never overwrite a human's work
      fs.writeFileSync(target, `${JSON.stringify(blankTemplate(entry), null, 2)}\n`);
    }
  }

  fs.writeFileSync(path.join(OUT, 'documents.json'), `${JSON.stringify({
    selectedFrom: 'tuning split only',
    manifestChecksum: manifest.checksum,
    docIds: chosen.map((e) => e.docId),
    note: 'Resolve each docId to a file via path-index.json, which stays out of Git.',
  }, null, 2)}\n`);

  console.log(`Calibration package: ${OUT}`);
  console.log(`  documents : ${chosen.map((e) => e.docId).join(', ')}`);
  console.log('  reviewers : reviewer-a, reviewer-b (independent, do not compare while labelling)');
  console.log(`  templates : ${chosen.length * 2} empty files written`);
};

main();
