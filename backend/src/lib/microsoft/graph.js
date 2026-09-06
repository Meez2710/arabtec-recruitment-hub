// Microsoft Graph client for the delegated mailbox connection.
//
// DELEGATED ROUTES ONLY. Every path here is under `/me` — the mailbox that
// signed in. There is no `/users/{mailbox}` route in this file, because with
// delegated permission there is no other mailbox to name: the token IS the
// mailbox. That is the whole point of the migration off application permissions.
//
// READ-ONLY on mail, except for the one send route. No PATCH isRead, no move,
// no folder creation. De-duplication lives in mailbox_ingestion instead.

import { acquireGraphToken, classify, MicrosoftAuthError, CODES } from './msal-client.js';

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

/** Retries for a 429/503. Small on purpose: the daily timer is the real retry. */
const MAX_RETRIES = 3;
const MAX_RETRY_AFTER_MS = 60_000;

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms).unref?.(); });

/**
 * One authenticated Graph request.
 *
 * Respects `Retry-After` on 429 and 503 — Microsoft publishes the wait it wants
 * and ignoring it is how an integration gets its throttling window extended.
 * The header is capped so a hostile or mistaken value cannot park a scheduled
 * scan for an hour.
 */
export async function graphRequest(path, { method = 'GET', json, raw = false, accessToken = null, attempt = 0 } = {}) {
  const token = accessToken ?? (await acquireGraphToken()).accessToken;
  const url = path.startsWith('http') ? path : GRAPH_BASE + path;

  let response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        ...(json ? { 'content-type': 'application/json' } : {}),
      },
      body: json ? JSON.stringify(json) : undefined,
    });
  } catch (e) {
    throw classify(e);
  }

  if ((response.status === 429 || response.status === 503) && attempt < MAX_RETRIES) {
    const header = Number.parseInt(response.headers.get('retry-after') || '', 10);
    const waitMs = Math.min(
      Number.isFinite(header) && header > 0 ? header * 1000 : 2000 * (attempt + 1),
      MAX_RETRY_AFTER_MS,
    );
    await sleep(waitMs);
    return graphRequest(path, { method, json, raw, accessToken: token, attempt: attempt + 1 });
  }

  if (response.status === 429) {
    throw new MicrosoftAuthError(
      'Microsoft is throttling requests. The remaining messages will be picked up by the next scan.',
      CODES.GRAPH_THROTTLED, { status: 429 },
    );
  }
  if (response.status === 401) {
    // The token was accepted by MSAL but rejected by Graph — consent revoked,
    // password changed, or the account was removed from the app.
    throw new MicrosoftAuthError('Microsoft 365 connection requires sign-in again.',
      CODES.RECONNECT_REQUIRED, { status: 401 });
  }
  if (response.status === 403) {
    throw new MicrosoftAuthError(
      'Microsoft refused the request for this mailbox. The delegated Mail.Read / Mail.Send consent may have been withdrawn.',
      CODES.RECONNECT_REQUIRED, { status: 403 },
    );
  }
  if (response.status >= 500) {
    throw new MicrosoftAuthError('Microsoft Graph is unavailable. The next scheduled scan will retry.',
      CODES.GRAPH_UNAVAILABLE, { status: response.status });
  }
  if (!response.ok) {
    // Graph error bodies can echo message subjects and addresses. Keep the code,
    // drop the body.
    let graphCode = null;
    try { graphCode = (await response.json())?.error?.code ?? null; } catch { /* no body */ }
    throw new MicrosoftAuthError(`Microsoft Graph rejected the request (HTTP ${response.status}).`,
      CODES.UNEXPECTED, { status: response.status, graphCode });
  }

  if (raw) return Buffer.from(await response.arrayBuffer());
  // Graph signals success with an EMPTY body on more than one status: 204 for
  // most deletes, and 202 Accepted for POST /me/sendMail. Parsing that empty
  // body threw, so a message Microsoft had already accepted was reported as a
  // failure — and in `auto` mail mode that failure fell through to SMTP and
  // delivered the same mail twice. Decide on the body, not on a status list.
  const body = await response.text();
  if (body === '') return null;
  try { return JSON.parse(body); }
  catch {
    throw new MicrosoftAuthError('Microsoft Graph returned a response that could not be read.',
      CODES.UNEXPECTED, { status: response.status });
  }
}

/* ------------------------------- mail reads ------------------------------- */

/**
 * Inbox messages received at or after `sinceIso`, oldest first.
 *
 * `receivedDateTime` leads the filter because Graph requires the $orderby
 * property to appear first when $filter mixes properties.
 */
export async function listInboxMessages({ sinceIso, top = 50, accessToken = null, maxPages = 20 }) {
  const filter = encodeURIComponent(`receivedDateTime ge ${sinceIso} and hasAttachments eq true`);
  const select = encodeURIComponent('id,internetMessageId,subject,receivedDateTime,from,hasAttachments');
  let path = `/me/mailFolders/inbox/messages?$filter=${filter}&$select=${select}`
    + `&$orderby=receivedDateTime asc&$top=${Math.max(1, Math.min(Number(top) || 50, 200))}`;

  // PAGINATION IS NOT OPTIONAL HERE. Graph returns one page plus
  // @odata.nextLink; the sync then records its START time as the new watermark.
  // Dropping the next link therefore did not merely defer the rest of the page
  // set — it put those messages permanently behind the watermark, and their CVs
  // were never seen again. A busy Monday is exactly when that happens.
  const messages = [];
  for (let page = 0; page < maxPages && path; page += 1) {
    const body = await graphRequest(path, { accessToken });
    if (Array.isArray(body?.value)) messages.push(...body.value);
    path = body?.['@odata.nextLink'] ?? null;
  }
  // A cap, so a pathological mailbox cannot spin forever — but it must be LOUD,
  // because stopping early with pages outstanding is the very condition the
  // watermark cannot represent. runMailboxSync treats this as a partial pass.
  if (path) {
    console.log(JSON.stringify({
      level: 'warn', msg: 'microsoft.graph.pagination_capped',
      pages: maxPages, collected: messages.length,
    }));
    return Object.assign(messages, { truncated: true });
  }
  return messages;
}

/** Attachment metadata for one message. Never fetches contentBytes. */
export async function listAttachments(messageId, { accessToken = null } = {}) {
  const select = encodeURIComponent('id,name,contentType,size,isInline,@odata.type');
  const body = await graphRequest(`/me/messages/${encodeURIComponent(messageId)}/attachments?$select=${select}`,
    { accessToken });
  return Array.isArray(body?.value) ? body.value : [];
}

/** The attachment's bytes. */
export function downloadAttachment(messageId, attachmentId, { accessToken = null } = {}) {
  return graphRequest(
    `/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}/$value`,
    { raw: true, accessToken },
  );
}

// NO /me HELPER HERE, deliberately. Graph's /me user endpoint needs delegated
// User.Read, which this integration does not request and should not: the
// mailbox identity is already on the MSAL account, and Mail.Read is proven by
// reaching the inbox itself. A convenience wrapper for /me would be a 403
// waiting for whoever calls it.

/** Cheapest possible proof that Mail.Read reaches THIS mailbox. */
export function inboxProbe({ accessToken = null } = {}) {
  return graphRequest('/me/mailFolders/inbox?$select=id,displayName,totalItemCount', { accessToken });
}

/* -------------------------------- mail send ------------------------------- */

/**
 * Send as the connected mailbox. Delegated Mail.Send, `POST /me/sendMail`.
 *
 * `saveToSentItems` is left at Graph's default (true) so a recruiter can see
 * what the ATS sent from the mailbox they already read — an audit property, not
 * a mailbox mutation the integration performs on incoming mail.
 */
export async function sendMailAs({ to, subject, html, text, replyTo, accessToken = null }) {
  const recipients = (Array.isArray(to) ? to : String(to).split(','))
    .map((address) => String(address).trim()).filter(Boolean)
    .map((address) => ({ emailAddress: { address } }));
  if (!recipients.length) throw new MicrosoftAuthError('A recipient address is required.', CODES.UNEXPECTED);

  const message = {
    subject: subject ?? '',
    body: html ? { contentType: 'HTML', content: html } : { contentType: 'Text', content: text ?? '' },
    toRecipients: recipients,
  };
  if (replyTo) message.replyTo = [{ emailAddress: { address: String(replyTo).trim() } }];

  await graphRequest('/me/sendMail', { method: 'POST', json: { message, saveToSentItems: true }, accessToken });
  return { ok: true };
}
