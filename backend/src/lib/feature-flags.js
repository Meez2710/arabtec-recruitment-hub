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

// What each switch means to an administrator, and whether the code actually
// consults it. A switch nothing reads is listed as reserved, not offered as a
// control: an administrator must never be handed a toggle that does nothing.
export const FEATURE_META = {
  folder_watcher:            { label: 'CV folder watcher', description: 'Watch the configured CV inbox folder and import new files automatically. Takes effect on the next server start.', enforced: true },
  cv_parsing:                { label: 'CV parsing', description: 'Reserved. Parsing is governed by the parser configuration, not this switch.', enforced: false },
  ai_parsing:                { label: 'AI CV parsing', description: 'Reserved. Governed by the AI provider configuration.', enforced: false },
  ai_scoring:                { label: 'AI candidate matching', description: 'Reserved. Governed by the AI provider configuration.', enforced: false },
  auto_link_candidate:       { label: 'Create and link candidate in one step', description: 'Reserved. Always available today.', enforced: false },
  public_careers:            { label: 'Public careers page', description: 'Reserved. No careers page ships in this version.', enforced: false },
  email_notifications:       { label: 'Email notifications', description: 'Reserved. Email is governed by Email & Mailbox and per-event notification settings.', enforced: false },
  interview_self_schedule:   { label: 'Candidate self-scheduling', description: 'Reserved. Not built in this version.', enforced: false },
};
export function allFlags() {
  const flags = all("SELECT key, value FROM system_setting WHERE key LIKE 'feature.%' ORDER BY key");
  return flags.map((f) => {
    const key = f.key.replace(PREFIX, '');
    const meta = FEATURE_META[key] || { label: key, description: '', enforced: false };
    return { key, enabled: f.value === 'enabled', label: meta.label, description: meta.description, enforced: meta.enforced };
  });
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
    // Multiple processes can initialize together. Let the unique key arbitrate
    // the insert atomically while preserving any administrator's existing value.
    run('INSERT INTO system_setting (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING', [key, value]);
  }
}
