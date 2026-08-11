// Report formatting. Pure — takes a report, returns strings.

import type { Finding, ReconciliationReport, Severity } from './checks.js';

const RULE = '─'.repeat(78);

export function formatText(report: ReconciliationReport): string {
  const lines: string[] = [];
  const { counts } = report;

  lines.push(RULE);
  lines.push('  H1 RECONCILIATION REPORT — legacy hiring data');
  lines.push(`  generated ${report.generatedAt}`);
  lines.push(RULE);
  lines.push('');
  lines.push(`  scanned   ${counts.requisitions} requisitions · ${counts.seats} seats · ${counts.applications} applications`);
  lines.push(`  findings  ${counts.blocking} blocking · ${counts.warnings} warning`);
  lines.push('');

  if (report.findings.length === 0) {
    lines.push('  No findings. Legacy data satisfies every invariant the new model enforces.');
    lines.push('');
    lines.push(RULE);
    return lines.join('\n');
  }

  lines.push('  BY CODE');
  for (const [code, n] of Object.entries(report.byCode).sort((a, b) => b[1] - a[1])) {
    lines.push(`    ${String(n).padStart(5)}  ${code}`);
  }
  lines.push('');

  for (const severity of ['BLOCKING', 'WARNING'] as Severity[]) {
    const group = report.findings.filter((f) => f.severity === severity);
    if (group.length === 0) continue;

    lines.push(RULE);
    lines.push(`  ${severity} (${group.length})`);
    lines.push(RULE);
    for (const f of group) lines.push(...formatFinding(f));
    lines.push('');
  }

  lines.push(RULE);
  lines.push(report.migrationSafe
    ? '  MIGRATION SAFE — no blocking findings. Warnings are informational.'
    : `  MIGRATION BLOCKED — resolve ${counts.blocking} blocking finding(s) first.`);
  lines.push(RULE);
  return lines.join('\n');
}

function formatFinding(f: Finding): string[] {
  return [
    '',
    `  [${f.code}]  ${f.entity} ${String(f.entityId)}`,
    `    ${f.message}`,
    `    detail:  ${JSON.stringify(f.detail)}`,
    `    remedy:  ${f.suggestedRemedy}`,
  ];
}

/** Machine-readable output, for attaching to the migration runbook. */
export function formatJson(report: ReconciliationReport): string {
  return JSON.stringify(report, null, 2);
}

/**
 * One row per finding. The format HR or a DBA can filter and work through —
 * a blocking list nobody can sort is a blocking list nobody resolves.
 */
export function formatCsv(report: ReconciliationReport): string {
  const esc = (v: unknown): string => {
    const s = typeof v === 'string' ? v : JSON.stringify(v ?? '');
    return `"${s.replace(/"/g, '""')}"`;
  };
  const rows = [['severity', 'code', 'entity', 'entity_id', 'message', 'remedy', 'detail'].join(',')];
  for (const f of report.findings) {
    rows.push([
      f.severity, f.code, f.entity, String(f.entityId), f.message, f.suggestedRemedy,
      JSON.stringify(f.detail),
    ].map(esc).join(','));
  }
  return rows.join('\n');
}
