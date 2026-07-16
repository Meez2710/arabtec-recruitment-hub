// Feature flag utility — reads from system_setting table (key/value store).
// Admin toggles these via Settings → Feature Flags in the admin UI.
//
// Usage:
//   import { isEnabled } from '../lib/feature-flags.js';
//   if (isEnabled('cv_parsing')) { ... }
//
// Flags are seeded with sensible defaults (see ensureFeatureFlags below).

import { get, all, run } from './db.js';

const PREFIX = 'feature.';

export function isEnabled(featureKey) {
  const row = get('SELECT value FROM system_setting WHERE key = ?', [`${PREFIX}${featureKey}`]);
  return row?.value === 'enabled';
}

export function allFlags() {
  const flags = all("SELECT key, value FROM system_setting WHERE key LIKE 'feature.%' ORDER BY key");
  return flags.map(f => ({ key: f.key.replace(PREFIX, ''), enabled: f.value === 'enabled' }));
}

export function setFlag(featureKey, enabled) {
  const key = `${PREFIX}${featureKey}`;
  const existing = get('SELECT id FROM system_setting WHERE key = ?', [key]);
  if (existing) {
    run('UPDATE system_setting SET value = ?, updated_at = datetime(\'now\') WHERE key = ?', [enabled ? 'enabled' : 'disabled', key]);
  } else {
    run('INSERT INTO system_setting (key, value) VALUES (?, ?)', [key, enabled ? 'enabled' : 'disabled']);
  }
}

export const DEFAULT_FEATURE_FLAGS = [
  ['feature.cv_parsing',        'disabled'],  // requires pdfplumber/docx python deps
  ['feature.folder_watcher',    'disabled'],  // requires chokidar npm + running sidecar
  ['feature.auto_link_candidate','enabled'],  // one-step candidate+request creation
  ['feature.public_careers',    'disabled'],  // public careers page + apply form
  ['feature.ai_parsing',        'disabled'],  // Claude CV parsing (needs ANTHROPIC_API_KEY)
  ['feature.ai_scoring',        'disabled'],  // AI candidate-job matching
  ['feature.email_notifications','disabled'],  // real SMTP email sending
  ['feature.interview_self_schedule','disabled'], // candidate self-booking
];

// Idempotent: seed flags that don't exist yet.
export function ensureFeatureFlags() {
  for (const [key, value] of DEFAULT_FEATURE_FLAGS) {
    const existing = get('SELECT id FROM system_setting WHERE key = ?', [key]);
    if (!existing) {
      run('INSERT INTO system_setting (key, value) VALUES (?, ?)', [key, value]);
    }
  }
}
