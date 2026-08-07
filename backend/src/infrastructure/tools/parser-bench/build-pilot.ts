// Build the pilot corpus sample.
//
//   npx tsx src/infrastructure/tools/parser-bench/build-pilot.ts <dir> [<dir>…]
//
// WHAT THIS DOES AND DOES NOT DO
//
// It computes MECHANICAL document properties — content hash, size, format,
// whether a PDF carries a text layer, which scripts appear in that layer — and
// uses them to draw a stratified, reproducible sample.
//
// It does NOT assign ground truth, and it does not assign the authoritative
// language cohort. The script signal below is provisional and exists only so
// the sample is balanced; it is written to a separate stratification file, and
// `language` stays null in the manifest until a human fills in the label.
//
// PRIVACY: extracted text is used in memory to compute ratios and is never
// written anywhere. Outputs contain hashes, counts and pseudonymous ids only,
// and all of them land under backend/data/ which is gitignored.

import fs from 'node:fs';
import path from 'node:path';
import { sampleCorpus, sha256, docIdFor, formatOf, shuffle } from './manifest.js';
import { blankTemplate } from './annotation.js';
import type { CandidateFile } from './manifest.js';
import type { DocumentTrait, LanguageCohort } from './types.js';

const OUT_DIR = path.resolve(process.cwd(), 'data/bench');
const SEED = 20260807;
const PILOT_SIZE = 40;
const MIN_SCANNED = 8;
const EXTENSIONS = new Set(['.pdf', '.docx', '.doc']);

/** Provisional, for stratification only. Never the annotator's answer. */
interface Probe {
  readonly file: CandidateFile;
  /**
   * `unknown` when there is no text layer to inspect.
   *
   * An image-only document's script cannot be determined without OCR, and
   * defaulting it to English would misreport the corpus profile — precisely for
   * the cohort (scanned Arabic) most at risk in this migration.
   */
  readonly script: LanguageCohort | 'unknown';
  readonly hasTextLayer: boolean;
  readonly chars: number;
}

const ARABIC = /[؀-ۿ]/g;
const LATIN = /[A-Za-z]/g;

const walk = (dir: string): string[] => {
  const out: string[] = [];
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full));
    else if (EXTENSIONS.has(path.extname(e.name).toLowerCase())) out.push(full);
  }
  return out;
};

/** Uses the existing extractor: this measures the corpus, not a new pipeline. */
const probe = async (filePath: string): Promise<Probe | null> => {
  let bytes: Buffer;
  try { bytes = fs.readFileSync(filePath); } catch { return null; }
  if (bytes.byteLength === 0) return null;

  const file: CandidateFile = {
    filePath, bytes: bytes.byteLength, sha256: sha256(bytes),
  };

  let text = '';
  try {
    const extractor = await import('../../../lib/cv/extractor.js') as {
      extractTextAsync: (p: string) => Promise<string>;
    };
    text = await extractor.extractTextAsync(filePath);
  } catch { text = ''; }

  const arabic = (text.match(ARABIC) ?? []).length;
  const latin = (text.match(LATIN) ?? []).length;
  const total = arabic + latin;
  // A CV is "mixed" when neither script dominates. Thresholds are for sampling
  // balance only and carry no evidential weight.
  // No text layer in a PDF means the page is an image: the scanned cohort.
  const hasTextLayer = text.trim().length > 50;

  let script: LanguageCohort | 'unknown' = 'unknown';
  if (hasTextLayer && total > 0) {
    const arabicShare = arabic / total;
    if (arabicShare > 0.6) script = 'arabic';
    else if (arabicShare > 0.08) script = 'mixed';
    else script = 'english';
  }
  return { file, script, hasTextLayer, chars: text.length };
};

const main = async (): Promise<void> => {
  const dirs = process.argv.slice(2);
  if (dirs.length === 0) {
    console.error('usage: build-pilot.ts <corpus-dir> [<corpus-dir>…]');
    process.exit(2);
  }

  const paths = dirs.flatMap(walk);
  console.log(`Found ${paths.length} candidate documents across ${dirs.length} director(ies).`);
  if (paths.length === 0) process.exit(1);

  const probes: Probe[] = [];
  for (const [i, p] of paths.entries()) {
    const result = await probe(p);
    if (result) probes.push(result);
    if ((i + 1) % 50 === 0) console.log(`  probed ${i + 1}/${paths.length}…`);
  }

  // Deduplicate by content before stratifying, so a CV filed twice cannot
  // occupy two slots in the pilot.
  const seen = new Set<string>();
  const unique = probes.filter((p) => {
    if (seen.has(p.file.sha256)) return false;
    seen.add(p.file.sha256);
    return true;
  });

  const scanned = unique.filter((p) => !p.hasTextLayer);
  const digital = unique.filter((p) => p.hasTextLayer);
  const byScript = (list: Probe[], s: LanguageCohort | 'unknown'): Probe[] =>
    list.filter((p) => p.script === s);

  console.log('\nCorpus profile (mechanical, provisional):');
  console.log(`  unique documents : ${unique.length}`);
  console.log(`  digital / scanned: ${digital.length} / ${scanned.length}`);
  for (const s of ['arabic', 'english', 'mixed', 'unknown'] as const) {
    console.log(`  script=${s.padEnd(8)}: ${byScript(unique, s).length}`
      + (s === 'unknown' ? '  (image-only: script needs OCR or a human)' : ''));
  }

  // Stratify: take scanned first (the scarce, high-value stratum), then fill the
  // remainder from the digital pool balanced across scripts.
  const picked: Probe[] = [];
  const takeFrom = (pool: Probe[], n: number): void => {
    for (const p of shuffle(pool, SEED).slice(0, n)) {
      if (!picked.some((q) => q.file.sha256 === p.file.sha256)) picked.push(p);
    }
  };

  const scannedPerScript = Math.ceil(MIN_SCANNED / 3);
  for (const s of ['arabic', 'mixed', 'english'] as const) {
    takeFrom(byScript(scanned, s), scannedPerScript);
  }
  takeFrom(scanned, MIN_SCANNED); // top up if a script had none

  const remaining = PILOT_SIZE - picked.length;
  const perScript = Math.ceil(remaining / 3);
  for (const s of ['arabic', 'mixed', 'english'] as const) {
    takeFrom(byScript(digital, s), perScript);
  }
  takeFrom(digital, PILOT_SIZE);

  const finalPick = picked.slice(0, PILOT_SIZE);
  const scannedCount = finalPick.filter((p) => !p.hasTextLayer).length;

  const manifest = sampleCorpus(finalPick.map((p) => p.file), {
    name: 'pilot-40',
    seed: SEED,
    size: PILOT_SIZE,
    heldOutFraction: 0.5,
    // Injected rather than read from the clock, so the manifest is reproducible.
    createdAt: process.env['BENCH_CREATED_AT'] ?? '2026-08-07T00:00:00.000Z',
  });

  // Mechanical traits only. The annotator adds layout and adjusts the rest.
  const traitsFor = (p: Probe): DocumentTrait[] => [
    p.hasTextLayer ? 'digital' : 'scanned',
    ...(p.chars > 12_000 ? (['long'] as DocumentTrait[]) : []),
  ];

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(path.join(OUT_DIR, 'labels'), { recursive: true });

  fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  // Paths and provisional signals stay OUT of the manifest and out of Git.
  fs.writeFileSync(path.join(OUT_DIR, 'path-index.json'), `${JSON.stringify(
    Object.fromEntries(finalPick.map((p) => [docIdFor(p.file.sha256), p.file.filePath])), null, 2,
  )}\n`);
  fs.writeFileSync(path.join(OUT_DIR, 'stratification.provisional.json'), `${JSON.stringify(
    finalPick.map((p) => ({
      docId: docIdFor(p.file.sha256),
      provisionalScript: p.script,
      hasTextLayer: p.hasTextLayer,
      format: formatOf(p.file.filePath),
      suggestedTraits: traitsFor(p),
    })), null, 2,
  )}\n`);

  let written = 0;
  for (const entry of manifest.entries) {
    const target = path.join(OUT_DIR, 'labels', `${entry.docId}.json`);
    if (fs.existsSync(target)) continue; // never overwrite a human's work
    fs.writeFileSync(target, `${JSON.stringify(blankTemplate(entry), null, 2)}\n`);
    written += 1;
  }

  console.log('\nPilot sample');
  console.log(`  size          : ${manifest.entries.length}`);
  console.log(`  scanned       : ${scannedCount} (minimum ${MIN_SCANNED})`);
  console.log(`  held-out      : ${manifest.entries.filter((e) => e.split === 'held-out').length}`);
  console.log(`  tuning        : ${manifest.entries.filter((e) => e.split === 'tuning').length}`);
  console.log(`  checksum      : ${manifest.checksum}`);
  console.log(`  blank labels  : ${written} written to ${path.join(OUT_DIR, 'labels')}`);
  console.log('\nEvery label file needs a human. Templates fail validation until filled.');
  if (scannedCount < MIN_SCANNED) {
    console.log(`\n⚠︎  Only ${scannedCount} scanned documents available — below the ${MIN_SCANNED} minimum.`);
  }
};

await main();
