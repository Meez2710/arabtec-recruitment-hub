/* Arabtec Candidate Intake Review
   Drop-in Babel/React page for the pre-candidate intake API.

   Wired to the REAL routes on the candidates router (mounted at /api/candidates):
     POST /candidates/parse-cv                    -> { intake|null, file, report, reason? }
     GET  /candidates/intakes                     -> { intakes: [...] }   (PENDING only)
     GET  /candidates/intakes/:iid                -> { intake }
     GET  /candidates/intakes/:iid/document       -> the stored CV bytes
     POST /candidates/intakes/:iid/review         -> 201 { candidate, application, ... }

   The review contract is a COMPLETE BOOLEAN MAP: the backend rejects a review
   that omits any proposed field ('incomplete'), so decisions are collected
   locally and submitted once. There is deliberately no per-field save and no
   edit-the-value control — the API accepts accept/reject only, and offering an
   editor the backend cannot honour would be a lie in the UI. */
(function () {
  const h = React.createElement;
  const { useCallback, useEffect, useMemo, useRef, useState } = React;

  /* Labels for the fields the domain actually proposes (PROPOSABLE_FIELDS).
     `major` carries the degree subject the extractor reads out of a line like
     "Bachelor of Science in Mechanical Engineering"; there is no separate
     `degree` field on the proposal whitelist, so it is not invented here. */
  const LABELS = {
    fullName: 'Full name',
    email: 'Email',
    phone: 'Phone',
    linkedinUrl: 'LinkedIn',
    nationality: 'Nationality',
    location: 'Location',
    currentPosition: 'Current position',
    currentCompany: 'Current company',
    yearsExperience: 'Years of experience',
    noticePeriod: 'Notice period',
    major: 'Degree / field of study',
    university: 'University',
    graduationYear: 'Graduation year',
    certifications: 'Certifications',
    skills: 'Skills',
    languages: 'Languages',
  };
  const FIELD_ORDER = Object.keys(LABELS);

  const api = () => {
    if (!window.ARABTEC_API) throw new Error('ATS API is not ready.');
    return window.ARABTEC_API;
  };

  const labelFor = (key) => LABELS[key]
    || String(key).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

  const clean = (v) => (v === null || v === undefined || v === ''
    ? '—'
    : Array.isArray(v) ? v.join(', ') : String(v));

  const when = (v) => { const d = new Date(v); return v && !isNaN(d) ? d.toLocaleString() : '—'; };
  const initials = (v) => (v || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((x) => x[0]).join('').toUpperCase();

  /** Name shown for an intake before a candidate exists. Never a candidate no. */
  const intakeName = (intake) => {
    const named = (intake.fields || []).find((f) => f.field === 'fullName');
    return (named && named.value) || intake.fileName || `Intake ${intake.id}`;
  };

  /** Proposed fields in review order; unknown fields keep their own order after. */
  const orderFields = (fields) => {
    const list = Array.isArray(fields) ? fields : [];
    const known = FIELD_ORDER.filter((k) => list.some((f) => f.field === k))
      .map((k) => list.find((f) => f.field === k));
    return [...known, ...list.filter((f) => !FIELD_ORDER.includes(f.field))];
  };

  /* -------------------------------- pieces -------------------------------- */

  function Banner({ tone = 'info', title, children }) {
    return h('div', { className: `intake-banner ${tone}` }, h('strong', null, title), h('div', null, children));
  }

  /** Structured citation: the snippet, then where it came from in the document. */
  function Evidence({ field }) {
    const ref = field.evidenceRef || null;
    const where = ref
      ? [ref.page != null ? `Page ${ref.page}` : null,
        ref.section ? `Section ${ref.section}` : null,
        ref.blockId ? `Block ${ref.blockId}` : null].filter(Boolean).join(' · ')
      : '';
    return h('div', { className: 'evidence-cell' },
      h('div', { className: 'evidence-quote' },
        field.evidence ? `“${field.evidence}”` : 'No evidence supplied'),
      where ? h('small', null, where) : null);
  }

  /**
   * Identity conflict raised by the review endpoint (409, code 'duplicate').
   *
   * Only ever rendered from a real backend response — exact matches block, and
   * `overridable` decides whether an override is offered at all. Name-only
   * lookalikes never reach here; they come back on success as potentialMatches.
   */
  function BlockingDuplicate({ conflict }) {
    const matches = conflict.matches || [];
    return h(Banner, { tone: 'danger', title: 'Exact duplicate identifier found' },
      h('span', null, conflict.overridable
        ? 'Candidate creation is blocked unless an authorised override is confirmed. '
        : 'Candidate creation is blocked. '),
      matches.map((m, i) => h('span', { key: m.id || i, className: 'duplicate-match' },
        `${m.candidateNo || m.id || 'Candidate'} · ${(m.matchedFields || []).join(', ')}`)));
  }

  function PotentialMatches({ matches }) {
    if (!matches || !matches.length) return null;
    return h(Banner, { tone: 'warning', title: 'Potential match — review only' },
      h('span', null, 'Name-only matches do not block review. '),
      matches.map((m, i) => h('span', { key: m.id || i, className: 'duplicate-match' },
        `${m.candidateNo || m.id || 'Candidate'} · ${(m.matchedFields || ['fullName']).join(', ')}`)));
  }

  const PREVIEW_STATUS_LABEL = {
    verified: 'Verified', likely: 'Likely (AI only)', rejected: 'Rejected', not_stated: 'Not stated in CV',
  };

  /**
   * EVERY field the reader saw for this CV — not just the ones that made it
   * onto the accept/reject table below. A field that is simply absent from a
   * parse is indistinguishable from one the reader missed; this table exists
   * so that distinction is never silent. Read-only: nothing here can be
   * accepted or rejected — that stays exclusively the job of ReviewTable.
   */
  function ExtractionPreviewTable({ rows }) {
    if (!rows || !rows.length) return null;
    const sections = [];
    for (const r of rows) if (!sections.includes(r.section)) sections.push(r.section);
    return h('div', { className: 'preview-panel' },
      h('div', { className: 'review-panel-head' },
        h('div', null,
          h('h2', null, 'Full extraction preview'),
          h('p', null, 'Every field the reader looked for in this CV. Nothing here is editable or '
            + 'persisted — it exists so a missing field is never a silent gap.'))),
      h('div', { className: 'review-table-wrap' }, h('table', { className: 'review-table preview-table' },
        h('thead', null, h('tr', null, h('th', null, 'Field'), h('th', null, 'Value'), h('th', null, 'Status'))),
        h('tbody', null, sections.flatMap((section) => [
          h('tr', { key: `h-${section}`, className: 'preview-section-row' },
            h('td', { colSpan: 3 }, section)),
          ...rows.filter((r) => r.section === section).map((r) => h('tr', {
            key: r.field, className: `preview-status-row-${r.status}`,
          },
          h('td', null, r.label),
          h('td', null, r.value == null
            ? h('span', { className: 'muted' }, '—')
            : h('span', { className: 'parsed-value' }, r.value)),
          h('td', null,
            h('span', { className: `preview-status-badge preview-status-${r.status}` },
              PREVIEW_STATUS_LABEL[r.status] || r.status),
            r.reason ? h('small', null, r.reason) : null))),
        ])))));
  }

  function ReviewTable({ fields, decisions, setDecision }) {
    return h('div', { className: 'review-table-wrap' }, h('table', { className: 'review-table' },
      h('thead', null, h('tr', null,
        h('th', null, 'Field'), h('th', null, 'Parsed value'),
        h('th', null, 'Evidence'), h('th', null, 'Decision'))),
      h('tbody', null, fields.map((f) => {
        const d = decisions[f.field] || 'PENDING';
        return h('tr', { key: f.field, className: 'decision-' + d.toLowerCase() },
          h('td', null, h('strong', null, labelFor(f.field)),
            f.confidence != null ? h('small', null, `${Math.round(Number(f.confidence) * 100)}% parse confidence`) : null),
          h('td', null, h('span', { className: 'parsed-value' }, clean(f.value))),
          h('td', null, h(Evidence, { field: f })),
          h('td', null, h('select', {
            className: 'decision-select', value: d,
            'aria-label': `Decision for ${labelFor(f.field)}`,
            onChange: (e) => setDecision(f.field, e.target.value),
          },
          h('option', { value: 'PENDING' }, 'Choose…'),
          h('option', { value: 'ACCEPT' }, 'Accept'),
          h('option', { value: 'REJECT' }, 'Reject'))));
      }))));
  }

  /* -------------------------------- detail -------------------------------- */

  /**
   * How the text under review was obtained. OCR is a recognition, not a
   * reading, so a reviewer checking an evidence snippet against the original
   * needs to know when the words were recovered from pixels.
   */
  function DocumentSource({ provenance }) {
    if (!provenance) return null;
    const parts = [
      provenance.ocrApplied
        ? `Text recovered by OCR${provenance.ocrEngine ? ` (${provenance.ocrEngine})` : ''}`
        : 'Read from the document text layer',
      provenance.parser ? `parser ${provenance.parser}` : null,
      provenance.pageCount ? `${provenance.pageCount} page${provenance.pageCount === 1 ? '' : 's'}` : null,
      provenance.degradedPages && provenance.degradedPages.length
        ? `${provenance.degradedPages.length} degraded page(s)` : null,
    ].filter(Boolean);
    return h(Banner, {
      tone: provenance.ocrApplied ? 'warning' : 'info',
      title: provenance.ocrApplied ? 'Scanned document' : 'Document source',
    }, `${parts.join(' · ')}. Check each value against the original before accepting it.`);
  }

  function IntakeDetail({ id, onConverted, onBack, provenance, preview }) {
    const [intake, setIntake] = useState(null);
    const [decisions, setDecisions] = useState({});
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [conflict, setConflict] = useState(null);   // 409 duplicate payload
    const [override, setOverride] = useState(false);
    const [rejectOpen, setRejectOpen] = useState(false);
    const [reason, setReason] = useState('');

    const load = useCallback(async () => {
      setError('');
      try {
        const r = await api().get('/candidates/intakes/' + id);
        const x = r.intake;
        setIntake(x);
        // Only seed decisions that are still unset, so a reload after a stale
        // conflict never discards what the reviewer already chose.
        setDecisions((prev) => {
          const next = { ...prev };
          for (const f of x.fields || []) if (!next[f.field]) next[f.field] = 'PENDING';
          return next;
        });
      } catch (e) { setError(e.message); }
    }, [id]);
    useEffect(() => { load(); }, [load]);

    const fields = useMemo(() => orderFields(intake && intake.fields), [intake]);
    const pending = fields.filter((f) => (decisions[f.field] || 'PENDING') === 'PENDING').length;
    const acceptedCount = fields.filter((f) => decisions[f.field] === 'ACCEPT').length;

    const setDecision = (k, v) => setDecisions((s) => ({ ...s, [k]: v }));
    const setAll = (v) => setDecisions(Object.fromEntries(fields.map((f) => [f.field, v])));

    async function submit() {
      if (pending > 0) return;
      setBusy(true); setError('');
      try {
        // Complete boolean map — every proposed field, exactly once.
        const map = Object.fromEntries(fields.map((f) => [f.field, decisions[f.field] === 'ACCEPT']));
        const r = await api().post(`/candidates/intakes/${id}/review`, {
          decisions: map,
          version: intake.version,
          ...(conflict && override ? { overrideDuplicate: true } : {}),
        });
        setConflict(null);
        onConverted(r);
      } catch (e) {
        const d = e.data || {};
        if (d.code === 'duplicate') {
          // Local decisions are untouched; the reviewer decides on the conflict.
          setConflict({ matches: d.matches || [], blocked: d.blocked === true, overridable: d.overridable === true });
          setError('');
        } else if (d.code === 'stale') {
          // Reload to pick up the current version. `load()` merges rather than
          // resets, so every decision already made survives the refresh.
          await load();
          setError('This intake changed on the server. Your decisions were kept and the latest version has been loaded — submit again to apply them.');
        } else if (d.code === 'not-pending') {
          setError(`${e.message} Return to the queue and refresh.`);
        } else {
          setError(e.message);
        }
      } finally { setBusy(false); }
    }

    async function reject() {
      if (!reason.trim()) return;
      setBusy(true); setError('');
      try {
        await api().post(`/candidates/intakes/${id}/review`, { reject: true, reason: reason.trim() });
        setRejectOpen(false);
        onConverted(null);
      } catch (e) { setError(e.message); setRejectOpen(false); } finally { setBusy(false); }
    }

    if (error && !intake) {
      return h('div', { className: 'intake-list-state' },
        h(Banner, { tone: 'danger', title: 'Unable to load intake' }, error),
        h('button', { className: 'btn btn-secondary', onClick: onBack }, 'Back'));
    }
    if (!intake) return h('div', { className: 'intake-list-state' }, 'Loading extracted fields…');

    const blocked = !!(conflict && conflict.blocked);
    return h('div', null,
      h('div', { className: 'intake-review-head' },
        h('div', null,
          h('button', { className: 'intake-back', onClick: onBack }, '← Candidate Review'),
          h('h1', null, intakeName(intake)),
          h('p', null, [
            intake.fileName || 'CV document',
            intake.requestId ? `Request #${intake.requestId}` : 'Talent pool',
            `Intake ${intake.id} · version ${intake.version}`,
          ].join(' · '))),
        h('div', { className: 'intake-head-actions' },
          h('button', {
            className: 'btn btn-secondary',
            onClick: () => api().download(`/candidates/intakes/${id}/document`),
          }, 'View CV'),
          h('button', { className: 'btn btn-danger', onClick: () => setRejectOpen(true) }, 'Reject intake'))),

      error ? h(Banner, { tone: 'danger', title: 'Review not submitted' }, error) : null,
      h(DocumentSource, { provenance }),
      conflict ? h(BlockingDuplicate, { conflict }) : null,

      h('div', { className: 'review-summary' },
        h('div', null, h('strong', null, fields.length), h('span', null, 'reviewable fields')),
        h('div', null, h('strong', null, pending), h('span', null, 'decisions remaining')),
        h('div', null, h('strong', null, intake.status), h('span', null, 'intake status'))),

      h('div', { className: 'review-panel' },
        h('div', { className: 'review-panel-head' },
          h('div', null,
            h('h2', null, 'Parsed CV review'),
            h('p', null, 'Accept or reject every field. Nothing is written to the candidate database until this review is submitted.')),
          h('div', { className: 'intake-head-actions' },
            h('button', { className: 'btn btn-secondary', onClick: () => setAll('REJECT') }, 'Reject all'),
            h('button', { className: 'btn btn-secondary', onClick: () => setAll('ACCEPT') }, 'Accept all'))),
        h(ReviewTable, { fields, decisions, setDecision })),

      preview ? h(ExtractionPreviewTable, { rows: preview }) : null,

      blocked && conflict.overridable
        ? h('label', { className: 'override-check' },
          h('input', { type: 'checkbox', checked: override, onChange: (e) => setOverride(e.target.checked) }),
          h('span', null,
            h('strong', null, 'Authorised duplicate override'),
            h('small', null, 'I verified the matched identifiers and confirm this should create a separate candidate.')))
        : null,

      h('div', { className: 'review-submit' },
        h('span', null, pending > 0
          ? `${pending === 1 ? '1 field still needs' : `${pending} fields still need`} a decision`
          : acceptedCount === 0
            ? 'No field accepted — submitting will reject this intake and create no candidate'
            : `Ready — ${acceptedCount} field${acceptedCount === 1 ? '' : 's'} will be applied`),
        h('button', {
          className: 'btn btn-success',
          disabled: busy || pending > 0 || (blocked && conflict.overridable && !override) || (blocked && !conflict.overridable),
          onClick: submit,
        }, busy ? 'Submitting…' : (conflict ? 'Submit with override' : 'Approve & create candidate'))),

      rejectOpen
        ? h('div', { className: 'intake-modal-backdrop' }, h('div', { className: 'intake-modal' },
          h('h3', null, 'Reject this intake?'),
          h('p', null, 'The CV and its parse stay on record for audit. No candidate and no application are created.'),
          h('textarea', {
            value: reason, onChange: (e) => setReason(e.target.value),
            'aria-label': 'Reason for rejecting this intake', placeholder: 'Required reason',
          }),
          h('div', null,
            h('button', { className: 'btn btn-secondary', onClick: () => setRejectOpen(false) }, 'Cancel'),
            h('button', {
              className: 'btn btn-danger-solid', disabled: busy || !reason.trim(), onClick: reject,
            }, 'Reject intake'))))
        : null);
  }

  /* --------------------------------- page --------------------------------- */

  function CandidateIntakeReviewPage({ user }) {
    const [items, setItems] = useState([]);
    const [loading, setLoading] = useState(true);
    const [active, setActive] = useState(null);
    const [error, setError] = useState('');
    const [notice, setNotice] = useState(null);      // parse produced nothing
    const [result, setResult] = useState(null);      // last conversion
    const [uploading, setUploading] = useState(false);
    // Document-stage provenance for the intake just uploaded. Response-only —
    // the intake record itself stores no parser metadata.
    const [source, setSource] = useState(null);
    // Full extraction preview for the intake just uploaded — same reason as
    // `source`: computed at parse time, never persisted on the intake record.
    const [preview, setPreview] = useState(null);
    const fileRef = useRef(null);

    const load = useCallback(async () => {
      setLoading(true); setError('');
      try { setItems((await api().get('/candidates/intakes')).intakes || []); }
      catch (e) { setError(e.message); } finally { setLoading(false); }
    }, []);
    useEffect(() => { load(); }, [load]);

    async function uploadCv(e) {
      const file = e.target.files && e.target.files[0];
      e.target.value = '';
      if (!file) return;
      setUploading(true); setError(''); setNotice(null); setResult(null); setSource(null); setPreview(null);
      try {
        const r = await api().upload('/candidates/parse-cv', file);
        if (!r.intake) {
          // Nothing in the document could be supported by evidence — an empty
          // proposal is never raised, so say what happened and what to do.
          setNotice({
            tone: 'warning',
            title: 'No reviewable field could be read from this document',
            text: `${r.reason || 'The parser found no value supported by the document.'} `
              + (r.document && r.document.ocrApplied
                ? 'The page was recognised by OCR, but nothing it produced could be '
                  + 'supported as a candidate field — usually an unreadable scan. '
                  + 'Try a clearer copy, '
                : 'Upload a text-based PDF or DOCX, ')
              + 'or add the candidate manually.',
          });
          // Still worth showing: even when nothing cleared the evidence gate,
          // the full preview says what the reader saw and why each field was
          // rejected, rather than leaving the recruiter with only "nothing".
          if (r.preview && r.preview.length) setPreview({ rows: r.preview, intakeId: null });
          return;
        }
        setSource(r.document ? { ...r.document, intakeId: r.intake.id } : null);
        if (r.preview) setPreview({ rows: r.preview, intakeId: r.intake.id });
        await load();
        setActive(r.intake.id);
      } catch (err) {
        setError(err.message || 'CV upload failed');
      } finally { setUploading(false); }
    }

    if (active) {
      return h(IntakeDetail, {
        id: active,
        // Only the intake that was just uploaded carries known provenance; one
        // opened from the queue shows none rather than a guess.
        provenance: source && source.intakeId === active ? source : null,
        onBack: () => { setActive(null); load(); },
        onConverted: (r) => {
          setActive(null);
          setResult(r);
          load();
        },
      });
    }

    return h('div', null,
      h('div', { className: 'page-head intake-page-head' },
        h('div', { className: 'page-head-main' },
          h('div', { className: 'breadcrumb' }, 'Recruitment / Candidate Review'),
          h('h1', { className: 'page-title' }, 'Candidate Intake Review'),
          h('p', { className: 'page-sub' }, 'Human approval gate between CV parsing and candidate creation.')),
        h('div', { className: 'page-head-actions' },
          h('span', { className: 'status-chip pending' }, `${items.length} pending`),
          h('input', {
            ref: fileRef, type: 'file', style: { display: 'none' }, onChange: uploadCv,
            accept: '.pdf,.doc,.docx,.png,.jpg,.jpeg,.txt',
          }),
          h('button', {
            className: 'btn btn-secondary', disabled: uploading,
            onClick: () => fileRef.current && fileRef.current.click(),
          }, uploading ? 'Uploading…' : 'Upload CV'),
          h('button', { className: 'btn btn-success', disabled: uploading, onClick: load }, 'Refresh'))),

      h(Banner, { tone: 'info', title: 'Workflow control' },
        'Upload creates a pending intake only. The candidate and any application are created after a complete human review.'),

      notice ? h(Banner, { tone: notice.tone, title: notice.title }, notice.text) : null,
      error ? h(Banner, { tone: 'danger', title: 'Unable to load intakes' }, error) : null,

      result && result.candidate
        ? h('div', null,
          h(Banner, { tone: 'info', title: `Candidate created — ${result.candidate.candidateNo}` },
            `${result.applied.length} field${result.applied.length === 1 ? '' : 's'} applied`
            + `${result.rejected.length ? `, ${result.rejected.length} rejected` : ''}`
            + `${result.application ? `. Linked to application ${result.application.applicationNo}` : '. Not linked to a request'}.`),
          h(PotentialMatches, { matches: result.potentialMatches }))
        : null,

      h('div', { className: 'card intake-queue' },
        h('div', { className: 'card-head' },
          h('h3', null, 'Pending CVs'),
          h('span', { className: 'muted' }, 'No automatic persistence')),
        loading
          ? h('div', { className: 'intake-list-state' }, 'Loading pending CV reviews…')
          : !items.length
            ? h('div', { className: 'intake-list-state' },
              h('strong', null, 'No pending reviews'),
              h('span', null, 'New CV uploads appear here before a candidate is created.'))
            : h('div', { className: 'intake-list' }, items.map((x) => h('button', {
              key: x.id, className: 'intake-list-row', onClick: () => setActive(x.id),
            },
            h('span', { className: 'intake-avatar' }, initials(intakeName(x))),
            h('span', { className: 'intake-list-copy' },
              h('strong', null, intakeName(x)),
              h('small', null, `${x.requestId ? `Request #${x.requestId}` : 'Talent pool'} · ${x.fields.length} field${x.fields.length === 1 ? '' : 's'} · ${when(x.createdAt)}`)),
            h('span', { className: 'intake-state' }, x.status))))));
  }

  window.ArabtecCandidateIntakeReviewPage = CandidateIntakeReviewPage;
})();
