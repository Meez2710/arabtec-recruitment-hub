/* Arabtec CV Inbox — what the careers mailbox delivered, and what became of it.
   Wired to the REAL routes on the cv-intake router (mounted at /api/cv-intake):
     GET  /cv-intake/inbox?state=inbox|failed|history  -> { counts, rows, mailbox, connection }
     GET  /cv-intake/items/:id/document                -> the stored CV bytes
     GET  /cv-intake/settings                          -> processing limits
     PUT  /cv-intake/settings                          -> { limits }   (System Admin only)

   WHY THIS PAGE CHANGED SHAPE.

   The panel this replaces was built around a recruiter selecting waiting
   attachments and approving them for parsing in batches of ten, twenty-five or
   fifty — with pause, resume and cancel, and "max batch" as a headline figure.
   That described a product the mailbox pipeline is not: `runMailboxSync`
   already validates each attachment, de-duplicates it, parses it and writes a
   PENDING `candidate_intake`, on arrival, without anyone approving anything.
   So the panel asked recruiters to authorise work that had already happened,
   and reported on a queue the real pipeline never fills.

   This page reports what the pipeline actually did. The sections are the three
   states a CV can really be in — waiting for a person, failed, or resolved.
   There is deliberately no separate "Review" tab: it would list exactly the
   same rows as Inbox, and a tab that duplicates another is a fake tab.

   WHAT HAS NOT CHANGED, AND MUST NOT.
   A CV arriving never creates a Candidate. Parsing is automatic; adding
   somebody to the Talent Pool stays a human decision, taken on the existing
   Candidate Review surface, and recorded as that person's. This page routes to
   that surface — it does not reimplement it.

   The batch machinery is NOT deleted. It still governs processing limits and
   remains useful for bulk upload and concurrency control, so it lives under
   Advanced, gated on system.manage, instead of dominating a recruiter's day. */
(function () {
  const h = React.createElement;
  const { useCallback, useEffect, useState } = React;

  const api = () => {
    if (!window.ARABTEC_API) throw new Error('ATS API is not ready.');
    return window.ARABTEC_API;
  };

  const can = (user, perm) => !!(user && Array.isArray(user.permissions) && user.permissions.includes(perm));

  /* The three states a delivered CV can really be in. Order is the order work
     moves through them, which is also the order a recruiter scans. */
  const SECTIONS = [
    { key: 'inbox', label: 'Inbox', hint: 'Parsed and waiting for your review' },
    { key: 'failed', label: 'Failed', hint: 'Could not be fetched, read or parsed' },
    { key: 'history', label: 'History', hint: 'Reviewed, imported, or skipped as a duplicate' },
  ];

  /* Connection states, phrased for a recruiter. The panel never shows tokens,
     scopes, client ids or anything else from the OAuth exchange — those belong
     under Administration, not in the middle of somebody's morning. */
  const CONNECTION = {
    CONNECTED: { label: 'Connected', tone: 'ok' },
    RECONNECT_REQUIRED: { label: 'Reconnect required', tone: 'warn' },
    DISCONNECTED: { label: 'Not connected', tone: 'bad' },
    ERROR: { label: 'Connection error', tone: 'bad' },
  };

  function when(value) {
    if (!value) return '—';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleString(undefined, {
      day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  }

  /* What happened to one delivered attachment, as one phrase. Reads the two
     tables together: the ingestion says whether the file arrived and parsed,
     the intake says whether a person has acted on it yet. */
  function outcome(row) {
    if (row.ingest_status === 'FAILED') return { label: 'Failed', tone: 'bad' };
    if (row.ingest_status === 'SKIPPED') return { label: 'Duplicate — skipped', tone: 'neutral' };
    if (row.ingest_status === 'PROCESSING') return { label: 'Parsing', tone: 'info' };
    switch (row.intake_status) {
      case 'PENDING': return { label: 'Awaiting review', tone: 'info' };
      case 'CONVERTED': return { label: 'Added to Talent Pool', tone: 'ok' };
      case 'REJECTED': return { label: 'Not taken forward', tone: 'neutral' };
      case 'SUPERSEDED': return { label: 'Superseded', tone: 'neutral' };
      default: return { label: 'Parsed', tone: 'info' };
    }
  }

  /* Tones map onto the canonical <Badge> variants rather than a local palette —
     the consolidation UI Coherence Phase 2A made for every other status pill.
     The local Pill this replaces emitted `badge-danger` for failures, a class
     the consolidated palette does not define, so a failed CV lost its red. */
  const TONE_VARIANT = { ok: 'success', warn: 'warning', bad: 'critical', info: 'info', neutral: 'soft' };

  function CvIntakePage({ user, PageHead, Empty, Skeleton, Icon, Badge }) {
    const [state, setState] = useState('inbox');
    const [data, setData] = useState(null);
    const [error, setError] = useState(null);
    const [busy, setBusy] = useState(false);
    const [notice, setNotice] = useState(null);
    const [advanced, setAdvanced] = useState(false);
    const [waiting, setWaiting] = useState(null);     // [{category,count,oldest,newest}]
    const [days, setDays] = useState(7);          // sensible for daily operations
    const [howMany, setHowMany] = useState(50);
    const [picked, setPicked] = useState(() => new Set());

    const mayAdmin = can(user, 'system.manage');
    const mayReview = can(user, 'candidate.view');
    const maySelect = can(user, 'cv_intake.approve_batch');

    const load = useCallback(async (next) => {
      const want = next || state;
      setBusy(true);
      try {
        const r = await api().get('/cv-intake/inbox?state=' + encodeURIComponent(want));
        setData(r);
        setError(null);
      } catch (e) {
        // Keep whatever is already on screen; a failed refresh must not blank
        // a list somebody is reading.
        setError(e.message || 'Could not read the CV inbox.');
      } finally {
        setBusy(false);
      }
    }, [state]);

    useEffect(() => { load(); }, [load]);

    const loadWaiting = useCallback(async () => {
      try { setWaiting((await api().get('/cv-intake/waiting')).groups || []); }
      catch { /* the inbox still works without the backlog view */ }
    }, []);
    useEffect(() => { if (maySelect) loadWaiting(); }, [loadWaiting, maySelect]);

    async function discover() {
      setBusy(true); setNotice(null); setError(null);
      try {
        const r = await api().post('/cv-intake/discover', { days: Number(days) });
        setNotice(`Found ${r.waiting || 0} CV${(r.waiting || 0) === 1 ? '' : 's'} in the last ${r.days} days. `
          + 'Nothing has been read yet — choose below what is worth reading.');
        await loadWaiting();
      } catch (e) {
        setError(e.message || 'Could not read the mailbox.');
      } finally { setBusy(false); }
    }

    const toggle = (category) => setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(category)) next.delete(category); else next.add(category);
      return next;
    });

    // What the recruiter is about to spend, before they spend it.
    const selectedCount = (waiting || [])
      .filter((g) => picked.has(g.category))
      .reduce((n, g) => n + Number(g.count || 0), 0);
    const willParse = Math.min(selectedCount, Number(howMany) || 0);

    async function parseSelected() {
      if (!picked.size) return;
      setBusy(true); setNotice(null); setError(null);
      try {
        const r = await api().post('/cv-intake/parse-waiting', {
          categories: [...picked], limit: Number(howMany),
        });
        setNotice(`Read ${r.parsed} CV${r.parsed === 1 ? '' : 's'}`
          + (r.skipped ? `, ${r.skipped} already on file` : '')
          + (r.failed ? `, ${r.failed} could not be read` : '')
          + '. They are now waiting for review.');
        setPicked(new Set());
        await Promise.all([loadWaiting(), load()]);
      } catch (e) {
        setError(e.message || 'Could not read the selection.');
      } finally { setBusy(false); }
    }

    async function scanNow() {
      setBusy(true); setNotice(null); setError(null);
      try {
        const r = await api().post('/integrations/microsoft/sync', {});
        setNotice(`Scan complete — ${r.imported} imported, ${r.skipped} skipped, ${r.failed} failed.`);
        await load();
      } catch (e) {
        setError(e.message || 'The scan could not be started.');
      } finally {
        setBusy(false);
      }
    }

    const conn = (data && data.connection) || {};
    const connMeta = CONNECTION[conn.status] || CONNECTION.DISCONNECTED;
    const counts = (data && data.counts) || {};
    const rows = (data && data.rows) || [];

    return h('div', null,
      h(PageHead, {
        crumb: 'Recruitment / CV Inbox',
        title: 'CV Inbox',
        sub: 'CVs emailed to the careers mailbox. Choose which are worth reading '
          + 'before any are parsed; adding someone to the Talent Pool stays your decision.',
      }),

      /* The operational header: the four facts somebody needs before they trust
         anything below it. */
      h('section', { className: 'card', style: { marginBottom: 16 } },
        h('div', { className: 'card-pad cvi-status' },
          h('div', { className: 'cvi-status-item' },
            h('span', { className: 'cvi-status-k' }, 'Mailbox'),
            h('strong', null, (data && data.mailbox) || '—')),
          h('div', { className: 'cvi-status-item' },
            h('span', { className: 'cvi-status-k' }, 'Microsoft 365'),
            h(Badge, { variant: TONE_VARIANT[connMeta.tone] || 'soft' }, connMeta.label)),
          h('div', { className: 'cvi-status-item' },
            h('span', { className: 'cvi-status-k' }, 'Last successful scan'),
            h('strong', null, when(conn.lastSuccessfulSyncAt))),
          h('div', { className: 'cvi-status-item' },
            h('span', { className: 'cvi-status-k' }, 'Parsing'),
            h('strong', null, 'On request, by selection')),
          mayAdmin && h('div', { className: 'cvi-status-actions' },
            h('button', {
              className: 'btn btn-secondary btn-sm',
              onClick: scanNow,
              disabled: busy || conn.status !== 'CONNECTED',
              title: conn.status === 'CONNECTED'
                ? 'Fetch anything that has arrived since the last scan'
                : 'Connect Microsoft 365 first, under Administration',
            }, busy ? 'Scanning…' : 'Scan inbox now')))),

      /* Waiting to parse — the decision surface. Counts come from subject and
         filename metadata the scan already has; no model call was made to
         produce them, which is the whole point of showing them first. */
      maySelect && h('section', { className: 'card', style: { marginBottom: 16 } },
        h('div', { className: 'card-head' },
          h('h3', null, 'Waiting to parse'),
          h('div', { className: 'cvi-range' },
            h('label', { className: 'cvi-range-label', htmlFor: 'cvi-days' }, 'Period'),
            h('select', {
              id: 'cvi-days', value: days, disabled: busy,
              onChange: (e) => setDays(Number(e.target.value)),
            },
            h('option', { value: 1 }, 'Last 24 hours'),
            h('option', { value: 7 }, 'Last 7 days'),
            h('option', { value: 30 }, 'Last 30 days'),
            h('option', { value: 90 }, 'Last 90 days')),
            h('button', {
              className: 'btn btn-secondary btn-sm', onClick: discover,
              disabled: busy || conn.status !== 'CONNECTED',
            }, busy ? 'Reading mailbox…' : 'Refresh from mailbox'))),
        h('div', { className: 'card-pad' },
          !waiting ? h('p', { className: 'muted', style: { margin: 0 } }, 'Loading…')
            : waiting.length === 0
              ? h('p', { className: 'muted', style: { margin: 0 } },
                'Nothing waiting. Choose a period and select Refresh from mailbox to see what has arrived. '
                + 'Reading the mailbox does not parse anything.')
              : h('div', null,
                h('ul', { className: 'cvi-groups' }, waiting.map((g) => h('li', { key: g.category },
                  h('label', { className: 'cvi-group' },
                    h('input', {
                      type: 'checkbox', checked: picked.has(g.category), disabled: busy,
                      onChange: () => toggle(g.category),
                    }),
                    h('span', { className: 'cvi-group-name' }, g.category),
                    h('span', { className: 'cvi-group-count' }, String(g.count)))))),
                h('div', { className: 'cvi-parsebar' },
                  h('span', { className: 'cvi-selected' },
                    picked.size === 0
                      ? 'Nothing selected'
                      : `${selectedCount} CV${selectedCount === 1 ? '' : 's'} selected`
                        + (selectedCount > willParse ? ` — will read the newest ${willParse}` : '')),
                  h('label', { className: 'cvi-range-label', htmlFor: 'cvi-cap' }, 'At most'),
                  h('select', {
                    id: 'cvi-cap', value: howMany, disabled: busy,
                    onChange: (e) => setHowMany(Number(e.target.value)),
                  },
                  h('option', { value: 25 }, '25'),
                  h('option', { value: 50 }, '50'),
                  h('option', { value: 100 }, '100'),
                  h('option', { value: 200 }, '200')),
                  h('button', {
                    className: 'btn', onClick: parseSelected,
                    disabled: busy || picked.size === 0,
                  }, busy ? 'Reading…' : 'Parse selected CVs'))))),

      conn.status !== 'CONNECTED' && h('div', { className: 'notice notice-warn', style: { marginBottom: 16, padding: '12px 16px' } },
        h('p', { style: { margin: 0 } },
          'The careers mailbox is not connected, so no new CVs are arriving. ',
          mayAdmin
            ? 'Reconnect it under Administration → Microsoft 365.'
            : 'Ask a system administrator to reconnect it.')),

      notice && h('div', { className: 'notice notice-success', style: { marginBottom: 16, padding: '12px 16px' } },
        h('p', { style: { margin: 0 } }, notice)),
      error && h('div', { className: 'refetch-error', role: 'status' },
        h('span', null, error),
        h('button', { className: 'btn btn-ghost btn-sm', onClick: () => load() }, 'Retry')),

      /* Sections. Counts come from the same query the rows do, so a tab never
         promises a number the list cannot show. */
      h('div', { className: 'seg-tabs cvi-tabs', role: 'tablist' },
        SECTIONS.map((s) => h('button', {
          key: s.key,
          role: 'tab',
          className: 'seg-tab' + (state === s.key ? ' active' : ''),
          'aria-selected': state === s.key,
          title: s.hint,
          onClick: () => { setState(s.key); setNotice(null); load(s.key); },
        }, s.label, h('span', { className: 'seg-count' }, String(counts[s.key] ?? 0)))),),

      !data ? h(Skeleton, { rows: 6 })
        : rows.length === 0
          ? h('div', { className: 'card' }, h(Empty, {
            art: state === 'failed' ? 'all-clear' : 'none-yet',
            title: state === 'inbox' ? 'Nothing waiting for review'
              : state === 'failed' ? 'No failures'
                : 'Nothing here yet',
            text: state === 'inbox'
              ? 'CVs emailed to the careers mailbox appear here once they have been read.'
              : state === 'failed'
                ? 'Attachments that cannot be fetched, read or parsed will be listed here with the reason.'
                : 'CVs you have reviewed, and duplicates that were skipped, will be listed here.',
          }))
          : h('div', { className: 'card flush' + (busy ? ' table-busy' : ''), 'aria-busy': busy },
            h('div', { className: 'table-wrap' },
              h('table', { className: 'table responsive-table' },
                h('thead', null, h('tr', null,
                  h('th', null, 'Attachment'),
                  h('th', null, 'Received'),
                  h('th', null, 'State'),
                  state === 'failed' && h('th', null, 'Reason'),
                  h('th', null, ''))),
                h('tbody', null, rows.map((r) => {
                  const o = outcome(r);
                  return h('tr', { key: r.id },
                    h('td', { 'data-label': 'Attachment' },
                      h('span', { className: 'cell-strong clamp-2', title: r.attachment_name || r.file_name || '' },
                        r.attachment_name || r.file_name || 'Unnamed attachment')),
                    h('td', { 'data-label': 'Received' },
                      h('span', { className: 'cell-sub-only' }, when(r.received_at || r.created_at))),
                    h('td', { 'data-label': 'State' }, h(Badge, { variant: TONE_VARIANT[o.tone] || 'soft' }, o.label)),
                    state === 'failed' && h('td', { 'data-label': 'Reason' },
                      h('span', { className: 'cell-sub clamp-2', title: r.reason || '' }, r.reason || '—')),
                    h('td', { 'data-label': '', style: { textAlign: 'end' } },
                      /* One action per row, and only where it is real: review
                         is the recruiter's job and needs candidate.view; a
                         failed row has nothing to review. */
                      r.intake_status === 'PENDING' && mayReview
                        ? h('button', {
                          className: 'btn btn-sm',
                          onClick: () => window.dispatchEvent(
                            new CustomEvent('ats:navigate', { detail: { route: 'candidateReview' } })),
                        }, 'Review')
                        : r.candidate_id
                          ? h('button', {
                            className: 'btn btn-ghost btn-sm',
                            onClick: () => window.dispatchEvent(
                              new CustomEvent('ats:open-candidate', { detail: { id: r.candidate_id } })),
                          }, 'Open candidate')
                          : h('span', { className: 'muted' }, '—')));
                }))))),

      /* Processing limits and the batch machinery. Kept, because they still
         govern concurrency and bulk upload — but out of the ordinary workflow,
         where they were asking recruiters to authorise AI spend per CV. */
      mayAdmin && h('section', { className: 'card', style: { marginTop: 16 } },
        h('div', { className: 'card-head' },
          h('h3', null, 'Advanced'),
          h('button', {
            className: 'btn btn-ghost btn-sm',
            onClick: () => setAdvanced((v) => !v),
            'aria-expanded': advanced,
          }, advanced ? 'Hide' : 'Show')),
        advanced && h('div', { className: 'card-pad' },
          h('p', { className: 'muted', style: { marginTop: 0 } },
            'Processing limits apply to bulk upload and to how much the mailbox '
            + 'scan will take on in one run. Mailbox CVs are parsed on arrival '
            + 'and do not wait for a batch to be approved.'),
          h('p', { className: 'muted', style: { marginBottom: 0 } },
            'Connection settings, tokens and scan scheduling live under '
            + 'Administration → Microsoft 365.'))));
  }

  window.ArabtecCvIntakePage = CvIntakePage;
})();
