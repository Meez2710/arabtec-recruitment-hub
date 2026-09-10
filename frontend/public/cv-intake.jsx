/* Arabtec CV Intake — the control panel.
   Wired to the REAL routes on the cv-intake router (mounted at /api/cv-intake):
     GET  /cv-intake/summary                          -> counts by job category, duplicates, batch states, limits
     GET  /cv-intake/queue?category=&from=&to=        -> { total, items: [...] }
     GET  /cv-intake/items/:id/preview                -> the email behind one attachment
     GET  /cv-intake/items/:id/document               -> the stored CV bytes
     GET  /cv-intake/batches                          -> { batches: [...] }
     POST /cv-intake/batches                          -> 201 { batch }        (approve a batch)
     POST /cv-intake/batches/:id/pause|resume|cancel  -> { batch }
     POST /cv-intake/batches/:id/items/:itemId/import -> { batch }
     PUT  /cv-intake/settings                         -> { limits }           (System Admin only)

   FIVE PERMISSIONS, FIVE CONTROLS. Each action below is gated on the exact
   permission its route requires, so a user granted only `cv_intake.view` sees
   the queue with the Approve control absent rather than present-and-failing.
   The UI is a courtesy: every one of these is enforced again server-side, which
   is what a direct API call meets.

   NOTHING IS APPROVED AUTOMATICALLY. Attachments wait until a person selects
   them and approves a batch. That is the whole point of the panel — an email
   arriving is not a decision to spend model budget or to add someone to the
   talent pool. */
(function () {
  const h = React.createElement;
  const { useCallback, useEffect, useMemo, useState } = React;

  const api = () => {
    if (!window.ARABTEC_API) throw new Error('ATS API is not ready.');
    return window.ARABTEC_API;
  };

  const can = (user, perm) => !!(user && Array.isArray(user.permissions) && user.permissions.includes(perm));

  /* Batch states, in the order work moves through them. The label is what a
     recruiter reads; the tone drives the badge colour. */
  const STATE = {
    PENDING: { label: 'Pending', tone: 'neutral' },
    PROCESSING: { label: 'Processing', tone: 'info' },
    PAUSED: { label: 'Paused', tone: 'warn' },
    AWAITING_REVIEW: { label: 'Awaiting review', tone: 'info' },
    COMPLETED: { label: 'Completed', tone: 'ok' },
    FAILED: { label: 'Failed', tone: 'bad' },
    CANCELLED: { label: 'Cancelled', tone: 'neutral' },
  };
  const STATE_ORDER = ['PENDING', 'PROCESSING', 'PAUSED', 'AWAITING_REVIEW', 'COMPLETED', 'FAILED', 'CANCELLED'];

  const when = (iso) => {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  };

  const todayISO = () => new Date().toISOString().slice(0, 10);
  const daysAgoISO = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

  function Badge({ tone, children }) {
    return h('span', { className: `cvi-badge cvi-badge--${tone || 'neutral'}` }, children);
  }

  /* ------------------------------ the panel ------------------------------- */

  function CvIntakePage({ user, PageHead, Empty, Skeleton, Icon }) {
    const [summary, setSummary] = useState(null);
    const [queue, setQueue] = useState({ total: 0, items: [] });
    const [batches, setBatches] = useState([]);
    const [category, setCategory] = useState(null);
    const [from, setFrom] = useState(daysAgoISO(30));
    const [to, setTo] = useState(todayISO());
    const [selected, setSelected] = useState(() => new Set());
    const [preview, setPreview] = useState(null);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    const [notice, setNotice] = useState(null);

    const mayPreview = can(user, 'cv_intake.preview');
    const mayApprove = can(user, 'cv_intake.approve_batch');
    const mayControl = can(user, 'cv_intake.control');
    const mayImport = can(user, 'cv_intake.import');
    const mayAdmin = can(user, 'system.manage');

    const limits = summary?.limits || { maxBatchSize: 25, maxConcurrency: 2 };

    const load = useCallback(async () => {
      setError(null);
      try {
        const q = new URLSearchParams();
        if (from) q.set('from', from);
        if (to) q.set('to', to);
        const [s, b] = await Promise.all([
          api().get(`/cv-intake/summary?${q}`),
          api().get('/cv-intake/batches?limit=25'),
        ]);
        setSummary(s);
        setBatches(b.batches || []);
      } catch (e) {
        setError(e.message || 'Could not load the intake summary.');
      } finally {
        setLoading(false);
      }
    }, [from, to]);

    const loadQueue = useCallback(async () => {
      try {
        const q = new URLSearchParams();
        if (category) q.set('category', category);
        if (from) q.set('from', from);
        if (to) q.set('to', to);
        q.set('limit', '200');
        setQueue(await api().get(`/cv-intake/queue?${q}`));
      } catch (e) {
        setError(e.message || 'Could not load the intake queue.');
      }
    }, [category, from, to]);

    useEffect(() => { load(); }, [load]);
    useEffect(() => { loadQueue(); }, [loadQueue]);
    // Selecting across a category change would approve CVs the user is no
    // longer looking at. Clear it rather than carry it invisibly.
    useEffect(() => { setSelected(new Set()); }, [category, from, to]);

    const toggle = (id) => setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });

    /* "Choose a quantity within the administrator's limit" — the oldest N, so
       the choice is reproducible rather than whatever happens to be on screen. */
    const selectFirst = (n) => {
      const take = queue.items.slice(0, Math.min(n, limits.maxBatchSize));
      setSelected(new Set(take.map((i) => i.id)));
    };

    const approve = async () => {
      if (!selected.size) return;
      setBusy(true); setError(null); setNotice(null);
      try {
        const batch = await api().post('/cv-intake/batches', {
          ingestionIds: [...selected],
          category: category || null,
          requestedCount: selected.size,
        });
        setNotice(`Batch #${batch.id} approved — ${batch.totals.items} CV${batch.totals.items === 1 ? '' : 's'} queued for parsing.`);
        setSelected(new Set());
        await Promise.all([load(), loadQueue()]);
      } catch (e) {
        setError(e.message || 'The batch could not be approved.');
      } finally { setBusy(false); }
    };

    const control = async (id, action) => {
      setBusy(true); setError(null); setNotice(null);
      try {
        await api().post(`/cv-intake/batches/${id}/${action}`, {});
        setNotice(`Batch #${id} ${action}d.`);
        await load();
      } catch (e) {
        setError(e.message || `The batch could not be ${action}d.`);
      } finally { setBusy(false); }
    };

    const openPreview = async (id) => {
      if (!mayPreview) return;
      setPreview({ id, loading: true });
      try {
        setPreview({ id, loading: false, data: await api().get(`/cv-intake/items/${id}/preview`) });
      } catch (e) {
        setPreview({ id, loading: false, error: e.message || 'Could not load this item.' });
      }
    };

    const saveLimits = async (next) => {
      setBusy(true); setError(null);
      try {
        const r = await api().put('/cv-intake/settings', { limits: next });
        setSummary((s) => (s ? { ...s, limits: r.limits } : s));
        setNotice('Processing limits updated.');
      } catch (e) {
        setError(e.message || 'Could not save the limits.');
      } finally { setBusy(false); }
    };

    const counts = summary?.batches || {};
    const activeStates = STATE_ORDER.filter((k) => (counts[k] || 0) > 0);

    return h('div', { className: 'page cvi' },
      h(PageHead, {
        title: 'CV Intake',
        subtitle: 'Applications waiting in the careers mailbox. Nothing is parsed until someone approves a batch.',
      }),

      error ? h('div', { className: 'cvi-alert cvi-alert--bad' }, error) : null,
      notice ? h('div', { className: 'cvi-alert cvi-alert--ok' }, notice) : null,

      /* ------------------------------ filters ------------------------------ */
      h('div', { className: 'card cvi-filters' },
        h('label', null, h('span', null, 'From'),
          h('input', { type: 'date', value: from, max: to, onChange: (e) => setFrom(e.target.value) })),
        h('label', null, h('span', null, 'To'),
          h('input', { type: 'date', value: to, min: from, max: todayISO(), onChange: (e) => setTo(e.target.value) })),
        h('button', { className: 'btn btn-ghost', onClick: () => { setFrom(daysAgoISO(30)); setTo(todayISO()); } }, 'Last 30 days'),
        h('span', { className: 'cvi-spacer' }),
        h('button', { className: 'btn btn-secondary', onClick: () => { load(); loadQueue(); }, disabled: busy }, 'Refresh')),

      loading ? h(Skeleton, { shape: 'list' }) : h(React.Fragment, null,

        /* ---------------------------- headline ---------------------------- */
        h('div', { className: 'cvi-metrics' },
          h('div', { className: 'card cvi-metric' },
            h('strong', null, String(summary?.waiting ?? 0)),
            h('span', { className: 'cvi-eyebrow' }, 'Waiting')),
          h('div', { className: 'card cvi-metric' },
            h('strong', null, String(summary?.duplicates ?? 0)),
            h('span', { className: 'cvi-eyebrow' }, 'Duplicates')),
          h('div', { className: 'card cvi-metric' },
            h('strong', null, String(summary?.unclassified ?? 0)),
            h('span', { className: 'cvi-eyebrow' }, 'Unclassified')),
          h('div', { className: 'card cvi-metric' },
            h('strong', null, String(limits.maxBatchSize)),
            h('span', { className: 'cvi-eyebrow' }, 'Max batch'))),

        /* ------------------------- processing states ---------------------- */
        h('div', { className: 'card' },
          h('div', { className: 'card-head' }, h('h3', null, 'Processing')),
          activeStates.length
            ? h('div', { className: 'cvi-states' }, activeStates.map((k) =>
              h('span', { key: k, className: 'cvi-state' },
                h(Badge, { tone: STATE[k].tone }, STATE[k].label),
                h('strong', null, String(counts[k])))))
            : h('p', { className: 'muted' }, 'No batches yet. Select CVs below and approve one to begin.')),

        /* --------------------------- categories --------------------------- */
        h('div', { className: 'card' },
          h('div', { className: 'card-head' },
            h('h3', null, 'Job categories'),
            h('span', { className: 'muted' }, 'Read from the application subject line')),
          !summary?.categories?.length
            ? h(Empty, { art: 'all-clear', title: 'Nothing waiting', text: 'Applications appear here after the careers mailbox is scanned.' })
            : h('div', { className: 'cvi-cats' },
              h('button', {
                className: `cvi-cat ${category === null ? 'is-active' : ''}`,
                onClick: () => setCategory(null),
              }, h('strong', null, 'All'), h('span', null, String(summary.waiting))),
              summary.categories.map((c) => h('button', {
                key: c.category,
                className: `cvi-cat ${category === c.category ? 'is-active' : ''} ${c.category === 'Unclassified' ? 'cvi-cat--unclassified' : ''}`,
                onClick: () => setCategory(c.category),
              },
              h('strong', null, c.category),
              h('span', null, `${c.count}${c.duplicates ? ` · ${c.duplicates} dup` : ''}`))))),

        /* ----------------------------- the queue -------------------------- */
        h('div', { className: 'card' },
          h('div', { className: 'card-head' },
            h('h3', null, category ? `${category} — waiting` : 'All waiting CVs'),
            h('span', { className: 'muted' }, `${queue.total} item${queue.total === 1 ? '' : 's'}`)),

          mayApprove ? h('div', { className: 'cvi-batchbar' },
            h('span', { className: 'cvi-eyebrow' }, 'Approve a batch'),
            [10, 25, 50].filter((n) => n <= limits.maxBatchSize).map((n) =>
              h('button', { key: n, className: 'btn btn-ghost', onClick: () => selectFirst(n), disabled: busy },
                `Oldest ${n}`)),
            h('button', { className: 'btn btn-ghost', onClick: () => setSelected(new Set()), disabled: busy || !selected.size }, 'Clear'),
            h('span', { className: 'cvi-spacer' }),
            h('span', { className: `cvi-count ${selected.size > limits.maxBatchSize ? 'is-over' : ''}` },
              `${selected.size} selected · limit ${limits.maxBatchSize}`),
            h('button', {
              className: 'btn btn-primary',
              disabled: busy || !selected.size || selected.size > limits.maxBatchSize,
              onClick: approve,
            }, busy ? 'Working…' : `Approve ${selected.size || ''}`.trim())) : null,

          !queue.items.length
            ? h(Empty, { art: 'all-clear', title: 'Nothing waiting here', text: 'Try a wider date range, or another category.' })
            : h('div', { className: 'cvi-table-scroll' },
              h('table', { className: 'cvi-table' },
                h('thead', null, h('tr', null,
                  mayApprove ? h('th', { className: 'cvi-tick' }, '') : null,
                  h('th', null, 'Applicant'),
                  h('th', null, 'Position applied for'),
                  h('th', null, 'Attachment'),
                  h('th', null, 'Received'),
                  h('th', null, ''))),
                h('tbody', null, queue.items.map((item) => h('tr', {
                  key: item.id,
                  className: `${selected.has(item.id) ? 'is-selected' : ''} ${item.duplicate ? 'is-duplicate' : ''}`,
                },
                mayApprove ? h('td', { className: 'cvi-tick' }, h('input', {
                  type: 'checkbox', checked: selected.has(item.id),
                  onChange: () => toggle(item.id),
                  'aria-label': `Select ${item.sender || 'application'}`,
                })) : null,
                h('td', null,
                  h('strong', null, item.sender || '—'),
                  item.duplicate ? h(Badge, { tone: 'warn' }, 'Duplicate') : null),
                h('td', null, item.category === 'Unclassified'
                  ? h('em', { className: 'muted' }, 'Unclassified')
                  : (item.subject || item.category || '—')),
                h('td', { className: 'cvi-file' }, item.attachmentName || '—'),
                h('td', null, when(item.receivedAt)),
                h('td', { className: 'cvi-row-actions' }, mayPreview
                  ? h('button', { className: 'btn btn-ghost btn-sm', onClick: () => openPreview(item.id) }, 'Preview')
                  : null))))))),

        /* ---------------------------- batch list -------------------------- */
        h('div', { className: 'card' },
          h('div', { className: 'card-head' },
            h('h3', null, 'Approved batches'),
            h('span', { className: 'muted' }, 'Who approved what, and when')),
          !batches.length
            ? h('p', { className: 'muted' }, 'No batches approved yet.')
            : h('div', { className: 'cvi-table-scroll' },
              h('table', { className: 'cvi-table' },
                h('thead', null, h('tr', null,
                  h('th', null, 'Batch'), h('th', null, 'Category'), h('th', null, 'State'),
                  h('th', null, 'CVs'), h('th', null, 'Imported'), h('th', null, 'Approved'),
                  h('th', null, ''))),
                h('tbody', null, batches.map((b) => h('tr', { key: b.id },
                  h('td', null, `#${b.id}`),
                  h('td', null, b.category || h('em', { className: 'muted' }, 'Mixed')),
                  h('td', null, h(Badge, { tone: (STATE[b.status] || {}).tone }, (STATE[b.status] || {}).label || b.status)),
                  h('td', { className: 'cvi-num' }, String(b.totals.items)),
                  h('td', { className: 'cvi-num' }, String(b.totals.imported)),
                  h('td', null, when(b.approvedAt)),
                  h('td', { className: 'cvi-row-actions' }, mayControl ? h(React.Fragment, null,
                    ['PENDING', 'PROCESSING'].includes(b.status)
                      ? h('button', { className: 'btn btn-ghost btn-sm', disabled: busy, onClick: () => control(b.id, 'pause') }, 'Pause') : null,
                    b.status === 'PAUSED'
                      ? h('button', { className: 'btn btn-ghost btn-sm', disabled: busy, onClick: () => control(b.id, 'resume') }, 'Resume') : null,
                    ['PENDING', 'PROCESSING', 'PAUSED', 'AWAITING_REVIEW'].includes(b.status)
                      ? h('button', { className: 'btn btn-ghost btn-sm', disabled: busy, onClick: () => control(b.id, 'cancel') }, 'Cancel') : null) : null))))))),

        /* --------------------------- admin limits ------------------------- */
        mayAdmin ? h(LimitsCard, { limits, onSave: saveLimits, busy }) : null,

        /* Only a holder of cv_intake.import sees the route to the review
           screen, because approving a person into the talent pool is that
           permission and no other. */
        mayImport ? h('p', { className: 'muted cvi-footnote' },
          'Parsed CVs appear in Candidate Review for final approval. A candidate is created only when a person approves them there.') : null),

      preview ? h(PreviewDrawer, { preview, onClose: () => setPreview(null) }) : null);
  }

  /* --------------------------- admin-only limits --------------------------- */

  function LimitsCard({ limits, onSave, busy }) {
    const [batch, setBatch] = useState(limits.maxBatchSize);
    const [conc, setConc] = useState(limits.maxConcurrency);
    useEffect(() => { setBatch(limits.maxBatchSize); setConc(limits.maxConcurrency); }, [limits]);
    const dirty = batch !== limits.maxBatchSize || conc !== limits.maxConcurrency;
    return h('div', { className: 'card cvi-limits' },
      h('div', { className: 'card-head' },
        h('h3', null, 'Processing limits'),
        h('span', { className: 'muted' }, 'System Admin only')),
      h('p', { className: 'muted' },
        'The ceiling a manager may choose within. Raising it increases how many CVs one approval can send for parsing at once.'),
      h('div', { className: 'cvi-limit-row' },
        h('label', null, h('span', null, 'Maximum batch size'),
          h('input', { type: 'number', min: 1, max: 500, value: batch, onChange: (e) => setBatch(Number(e.target.value)) })),
        h('label', null, h('span', null, 'Maximum concurrency'),
          h('input', { type: 'number', min: 1, max: 16, value: conc, onChange: (e) => setConc(Number(e.target.value)) })),
        h('button', {
          className: 'btn btn-secondary', disabled: busy || !dirty,
          onClick: () => onSave({ maxBatchSize: batch, maxConcurrency: conc }),
        }, 'Save limits')));
  }

  /* ------------------------------- preview -------------------------------- */

  function PreviewDrawer({ preview, onClose }) {
    const d = preview.data;
    return h('div', { className: 'cvi-drawer-scrim', onClick: onClose },
      h('aside', { className: 'cvi-drawer', onClick: (e) => e.stopPropagation() },
        h('div', { className: 'cvi-drawer-head' },
          h('h3', null, 'Application'),
          h('button', { className: 'btn btn-ghost btn-sm', onClick: onClose }, 'Close')),
        preview.loading ? h('p', { className: 'muted' }, 'Loading…')
          : preview.error ? h('div', { className: 'cvi-alert cvi-alert--bad' }, preview.error)
            : h('dl', { className: 'cvi-dl' },
              h('dt', null, 'From'), h('dd', null, d.sender || '—'),
              h('dt', null, 'Subject'), h('dd', null, d.subject || '—'),
              h('dt', null, 'Category'), h('dd', null, d.category || '—'),
              h('dt', null, 'Received'), h('dd', null, when(d.receivedAt)),
              h('dt', null, 'Attachment'), h('dd', null, d.attachmentName || '—'),
              h('dt', null, 'CV'), h('dd', null, d.hasDocument
                ? h('a', {
                  href: `/api/cv-intake/items/${d.id}/document`,
                  target: '_blank', rel: 'noopener noreferrer',
                }, 'Open the original document')
                : h('em', { className: 'muted' }, 'Not stored')))));
  }

  window.ArabtecCvIntakePage = CvIntakePage;
})();
