// CLI entry point for the reconciliation tool.
//
//   npm run reconcile -- --url file:data/arabtec.db
//   npm run reconcile -- --url $DATABASE_URL --format json --out report.json
//
// Exit codes:
//   0  no blocking findings — migration may proceed
//   1  blocking findings — migration must not proceed
//   2  the tool itself failed (connection, bad arguments)
//
// The non-zero exit on blocking findings is deliberate: this is meant to sit in
// a deploy pipeline as the gate on an irreversible migration.

import fs from 'node:fs';
import process from 'node:process';
import { reconcile } from './checks.js';
import { formatCsv, formatJson, formatText } from './report.js';
import { openSource } from './source.js';

interface Args {
  url: string;
  format: 'text' | 'json' | 'csv';
  out: string | null;
}

function parseArgs(argv: readonly string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const url = get('--url') ?? process.env['LEGACY_DATABASE_URL'] ?? process.env['DATABASE_URL'];
  if (!url) {
    throw new Error('Missing --url (or LEGACY_DATABASE_URL / DATABASE_URL).');
  }
  const format = (get('--format') ?? 'text') as Args['format'];
  if (!['text', 'json', 'csv'].includes(format)) {
    throw new Error(`Unknown --format '${format}'. Use text, json or csv.`);
  }
  return { url, format, out: get('--out') ?? null };
}

async function main(): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    return 2;
  }

  const source = openSource({ url: args.url });
  try {
    process.stderr.write(`Reading legacy data (${source.kind})…\n`);
    const snapshot = await source.read();
    const report = reconcile(snapshot);

    const rendered =
      args.format === 'json' ? formatJson(report)
      : args.format === 'csv' ? formatCsv(report)
      : formatText(report);

    if (args.out) {
      fs.writeFileSync(args.out, rendered, 'utf8');
      process.stderr.write(`Report written to ${args.out}\n`);
    } else {
      process.stdout.write(`${rendered}\n`);
    }

    return report.migrationSafe ? 0 : 1;
  } catch (err) {
    process.stderr.write(`Reconciliation failed: ${(err as Error).message}\n`);
    return 2;
  } finally {
    await source.close();
  }
}

main().then(
  (code) => { process.exitCode = code; },
  (err: unknown) => {
    process.stderr.write(`Unexpected failure: ${String(err)}\n`);
    process.exitCode = 2;
  },
);
