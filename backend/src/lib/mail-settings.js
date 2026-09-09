// Private mail configuration. Only this module decrypts SMTP credentials.
// Reuses the deployment's AES-GCM key; secrets never pass through generic settings.
import { run, tx } from './db.js';
import { SystemSettings } from './models.js';
import { encrypt, decrypt, hasEncryptionKey } from './microsoft/crypto.js';

export const EMAIL_CONFIG_KEY = 'email_configuration';
export const DEFAULT_SMTP_HOST = 'smtp.office365.com';
const FIELDS = ['provider', 'host', 'port', 'encryption', 'user', 'from', 'fromName', 'replyTo'];
export const isPrivateSetting = (key) => key.startsWith('email_') || /pass|secret|token|credential|pwd|api[_-]?key|_key$/i.test(key);
export const safeSystemSettings = () => Object.fromEntries(Object.entries(SystemSettings.all()).filter(([key]) => !isPrivateSetting(key)));
export const validEmail = (value) => typeof value === 'string' && value.length <= 254 && /^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(value);

function stored() {
  const raw = SystemSettings.get(EMAIL_CONFIG_KEY);
  if (!raw) return {};
  const value = JSON.parse(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Stored email configuration is invalid.');
  return value;
}
function environment() {
  const provider = String(process.env.MAIL_PROVIDER || 'auto').trim().toLowerCase();
  const port = Number(process.env.SMTP_PORT || 587);
  return { provider: ['smtp','graph'].includes(provider) ? provider : 'auto',
    host: process.env.SMTP_HOST || DEFAULT_SMTP_HOST, port,
    encryption: port === 465 ? 'tls' : port === 587 ? 'starttls' : 'none',
    user: process.env.SMTP_USER || '', from: process.env.MAIL_FROM || process.env.SMTP_USER || '',
    fromName: process.env.MAIL_FROM_NAME || 'Arabtec Careers', replyTo: process.env.MAIL_REPLY_TO || '' };
}
export function publicMailSettings() {
  const row = stored();
  const result = {...environment()};
  for (const key of FIELDS) if (Object.hasOwn(row,key)) result[key] = row[key];
  return {...result, passwordSetAt: row.passwordSetAt || null,
    passwordSet: !!(row.passwordCipher || process.env.SMTP_PASS),
    passwordSource: row.passwordCipher ? 'saved' : process.env.SMTP_PASS ? 'environment' : 'none',
    encryptionReady: hasEncryptionKey(), updatedAt: row.updatedAt || null };
}
export function effectiveMailSettings(draft, { includePassword = true } = {}) {
  const row = stored();
  const config = publicMailSettings();
  const pass = draft && Object.hasOwn(draft,'password') ? draft.password : !includePassword ? '' : row.passwordCipher ? decrypt(row.passwordCipher) : process.env.SMTP_PASS || '';
  const value = {...config, pass};
  if (draft === undefined) return value;
  if (!draft || typeof draft !== 'object' || Array.isArray(draft)) throw new Error('Email settings must be an object.');
  for (const key of Object.keys(draft)) if (![...FIELDS,'password'].includes(key)) throw new Error(`Unknown email setting: ${key}`);
  for (const key of FIELDS) if (Object.hasOwn(draft,key)) value[key] = draft[key];
  if (Object.hasOwn(draft,'password')) {
    if (typeof draft.password !== 'string' || !draft.password || draft.password.length > 4096) throw new Error('A non-empty replacement password is required.');
    value.pass = draft.password;
  }
  if (!['auto','graph','smtp'].includes(value.provider)) throw new Error('Choose Automatic, Microsoft 365, or SMTP.');
  if (!Number.isInteger(value.port) || value.port < 1 || value.port > 65535) throw new Error('SMTP port must be between 1 and 65535.');
  if (!['starttls','tls','none'].includes(value.encryption)) throw new Error('Choose STARTTLS, TLS, or None.');
  if (typeof value.host !== 'string' || !value.host || value.host.length > 253 || !/^[a-zA-Z0-9.-]+$/.test(value.host)) throw new Error('Enter an SMTP hostname without a URL or path.');
  for (const key of ['user','from','fromName','replyTo']) {
    if (typeof value[key] !== 'string' || value[key].length > 254 || /[\r\n\u0000]/.test(value[key])) throw new Error(`Invalid ${key}.`);
  }
  if (value.from && !validEmail(value.from)) throw new Error('Enter a valid From email address.');
  if (value.replyTo && !validEmail(value.replyTo)) throw new Error('Enter a valid Reply-to email address.');
  if (value.provider === 'smtp' && (!value.user || !(value.pass || (!includePassword && value.passwordSet)) || !validEmail(value.from))) throw new Error('SMTP requires a username, password, and valid From address.');
  return value;
}
export function saveMailSettings(draft) {
  const value = effectiveMailSettings(draft, {includePassword:false});
  const row = stored();
  const next = {};
  for (const key of FIELDS) next[key] = value[key];
  next.passwordCipher = row.passwordCipher || null;
  next.passwordSetAt = row.passwordSetAt || null;
  if (Object.hasOwn(draft,'password')) {
    next.passwordCipher = encrypt(draft.password);
    next.passwordSetAt = new Date().toISOString();
  }
  next.updatedAt = new Date().toISOString();
  tx(() => {
    SystemSettings.upsert(EMAIL_CONFIG_KEY, JSON.stringify(next));
    SystemSettings.upsert('email_last_verified', 'null');
  });
  return publicMailSettings();
}
export function safeMailError(error, config) {
  let message = String(error?.response || error?.message || error || 'Email connection failed.');
  for (const secret of [config?.pass, process.env.SMTP_PASS, process.env.MS_CLIENT_SECRET]) {
    if (secret) message = message.split(secret).join('[redacted]');
  }
  return message.slice(0, 1200);
}

export function mailVerification() {
  let value = null;
  try { value = JSON.parse(SystemSettings.get('email_last_verified') || 'null'); } catch { /* no previous verification */ }
  return value;
}
export function recordMailVerification(provider) {
  SystemSettings.upsert('email_last_verified', JSON.stringify({provider,at:new Date().toISOString()}));
}

export function mailDeliveryStats() {
  const month = new Date().toISOString().slice(0,7);
  return {month, sentThisMonth:Number(SystemSettings.get('email_sent_'+month)||0)};
}
export function recordMailDelivery() {
  // A single SQL increment stays correct across worker processes.
  try {
    const month = new Date().toISOString().slice(0,7);
    run(`INSERT INTO system_setting (key,value,updated_at) VALUES (?,?,?)
      ON CONFLICT(key) DO UPDATE SET value=CAST(CAST(system_setting.value AS INTEGER)+1 AS TEXT), updated_at=excluded.updated_at`,
      ['email_sent_'+month,'1',new Date().toISOString()]);
  } catch { /* Counting must never turn an accepted email into a send failure. */ }
}
