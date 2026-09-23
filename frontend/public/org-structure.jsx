(function () {
  const { useState, useEffect, useMemo, useRef, useCallback } = React;

  function api() { return window.ARABTEC_API; }
  function canManageChart(user) {
    return !!(user && user.permissions && user.permissions.includes('org_chart.manage'));
  }
  function initials(name) {
    return (name || '?').split(' ').filter(Boolean).map((s) => s[0]).slice(0, 2).join('').toUpperCase();
  }

  const NODE_TYPES = [
    { id: 'employee_position', label: 'Employee' },
    { id: 'vacant_position', label: 'Vacant position' },
    { id: 'department', label: 'Department' },
    { id: 'project', label: 'Project' },
    { id: 'organizational_unit', label: 'Unit' },
  ];

  function typeLabel(t) {
    return (NODE_TYPES.find((x) => x.id === t) || {}).label || t;
  }

  /* One reading of a node for every view. A unit, department or project has
     no employee by definition — it is not a vacancy, and calling it one put
     "Vacant" on the company itself. */
  function isUnit(node) {
    return node.nodeType === 'organizational_unit' || node.nodeType === 'project' || node.nodeType === 'department';
  }
  function isVacant(node) {
    if (isUnit(node)) return false;
    return node.status === 'vacant' || node.nodeType === 'vacant_position' || !node.employeeName;
  }
  function nodeName(node) {
    if (isUnit(node) || isVacant(node)) return node.positionTitle || node.employeeName || typeLabel(node.nodeType);
    return node.employeeName;
  }
  function nodeTitle(node) {
    if (isUnit(node)) return typeLabel(node.nodeType);
    return isVacant(node) ? 'Vacant' : (node.positionTitle || typeLabel(node.nodeType));
  }
  function nodeMeta(node) {
    // Department and location are often the same words ("Head Office").
    const parts = [node.department, node.projectOrLocation].filter(Boolean)
      .filter((v, i, a) => a.findIndex((x) => x.trim().toLowerCase() === v.trim().toLowerCase()) === i);
    return parts.join(' · ');
  }
  function avatarText(node) {
    if (isVacant(node)) return 'V';
    return initials(isUnit(node) ? node.positionTitle : node.employeeName);
  }
  function avatarClass(node) {
    return 'org-av' + (isVacant(node) ? ' vacant' : '') + (isUnit(node) ? ' unit' : '');
  }
  window.ORG_CHART_NODE = { isUnit, isVacant, nodeName, nodeTitle, nodeMeta, avatarText };

  function injectStyles() {
    if (document.getElementById('org-structure-css')) return;
    const el = document.createElement('style');
    el.id = 'org-structure-css';
    el.textContent = `
      .org-toolbar-wrap { display:flex; flex-wrap:wrap; gap:8px; align-items:center; }
      .org-canvas-wrap {
        position:relative; overflow:hidden; background:var(--bg, #F4F5F7);
        border:1px solid var(--border); border-radius:var(--card-radius, 20px);
        min-height:520px; cursor:grab;
      }
      .org-canvas-wrap.is-panning { cursor:grabbing; }
      .org-canvas {
        transform-origin: 0 0; padding:28px 36px 48px;
        width:max-content; min-width:100%;
      }
      .org-tree, .org-tree ul { list-style:none; margin:0; padding:0; display:flex; justify-content:center; }
      .org-tree ul { padding-top:22px; }
      .org-tree li { position:relative; padding:22px 10px 0; text-align:center; }
      .org-tree li::before, .org-tree li::after {
        content:""; position:absolute; top:0; width:50%; height:22px; border-top:1px solid var(--border);
      }
      .org-tree li::before { right:50%; border-right:1px solid var(--border); }
      .org-tree li::after { left:50%; }
      .org-tree li:only-child::before, .org-tree li:only-child::after { display:none; }
      .org-tree li:only-child { padding-top:0; }
      .org-tree li:first-child::before, .org-tree li:last-child::after { border:0 none; }
      .org-tree li:last-child::before { border-right:1px solid var(--border); border-radius:0 8px 0 0; }
      .org-tree li:first-child::after { border-radius:8px 0 0 0; }
      .org-node { display:inline-flex; flex-direction:column; align-items:center; position:relative; z-index:1; }
      .org-card {
        width:210px; text-align:left; background:var(--surface, #fff);
        border:1px solid var(--border); border-radius:12px; padding:10px 12px;
        box-shadow:0 1px 2px rgba(26,26,26,.04); cursor:pointer;
      }
      .org-card:hover { border-color:var(--at-action, #008064); }
      .org-card.is-active { outline:2px solid var(--at-action, #008064); }
      .org-card.is-vacant { border-style:dashed; background:#fff; }
      .org-card.is-unit, .org-card.is-project, .org-card.is-department {
        background:var(--at-action-tint, rgba(0,128,100,.08));
      }
      .org-card.is-match { box-shadow:0 0 0 2px var(--at-action, #008064); }
      .org-card-top { display:flex; gap:8px; align-items:center; }
      .org-av {
        width:28px; height:28px; border-radius:50%; flex:none;
        display:grid; place-items:center; font-size:10px; font-weight:700;
        background:var(--at-action, #008064); color:#fff;
      }
      .org-av.unit { border-radius:8px; background:var(--at-action-tint, rgba(0,128,100,.08)); color:var(--at-action, #008064); }
      .org-av.vacant { background:transparent; color:var(--text-gray); border:1px dashed var(--border); }
      .org-name { font-size:13px; font-weight:700; color:var(--text-dark); line-height:1.25; }
      .org-title { font-size:12px; color:var(--text-gray); line-height:1.3; }
      .org-meta { font-size:11px; color:var(--text-gray); margin-top:4px; }
      /* Measured at 19px tall, the smallest control in the product and well
         under the 28px the rest of the UI holds for a clickable target. The
         label stays 11px — this buys the height back with padding, not by
         inflating the type. */
      .org-toggle {
        margin-top:6px; border:1px solid var(--border); background:#fff; border-radius:999px;
        font-size:11px; padding:0 10px; min-height:28px; cursor:pointer; color:var(--text-gray);
        display:inline-flex; align-items:center; justify-content:center;
      }
      .org-drop { outline:2px dashed var(--at-action, #008064); }
      .org-legend { display:flex; gap:12px; flex-wrap:wrap; font-size:12px; color:var(--text-gray); }
      /* Phone: a drill-down list, one position at a time. */
      .org-trail { display:flex; gap:4px; overflow-x:auto; scrollbar-width:none; margin:0 0 10px; padding-bottom:2px; }
      .org-trail::-webkit-scrollbar { display:none; }
      .org-trail button {
        flex:0 0 auto; min-height:36px; padding:0 12px; border-radius:999px; font-size:13px;
        border:1px solid var(--border); background:var(--surface, #fff); color:var(--text-gray); cursor:pointer;
      }
      .org-trail button[aria-current="true"] { color:var(--text-dark); font-weight:700; border-color:var(--at-action, #008064); }
      .org-focus { padding:16px; margin-bottom:12px; }
      .org-focus .org-av { width:44px; height:44px; font-size:15px; }
      .org-focus .org-name { font-size:17px; }
      .org-focus .org-title, .org-focus .org-meta { font-size:13px; }
      .org-focus-actions { display:grid; grid-template-columns:repeat(3, 1fr); gap:8px; margin-top:14px; }
      .org-focus-actions .btn { min-height:44px; width:100%; }
      .org-list { padding:0; overflow:hidden; }
      .org-list-head { padding:12px 16px; font-size:12px; font-weight:700; letter-spacing:.04em; text-transform:uppercase; color:var(--text-gray); border-bottom:1px solid var(--border); }
      .org-row {
        display:flex; gap:12px; align-items:center; width:100%; min-height:64px; padding:10px 16px;
        border:0; border-bottom:1px solid var(--border); background:transparent; text-align:start; cursor:pointer; font:inherit;
      }
      .org-row:last-child { border-bottom:0; }
      .org-row:active { background:var(--at-action-tint, rgba(0,128,100,.08)); }
      .org-row .org-av { width:36px; height:36px; font-size:13px; }
      .org-row-body { flex:1 1 auto; min-width:0; }
      .org-row .org-name { font-size:15px; }
      .org-row .org-title, .org-row .org-meta { font-size:13px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .org-row .org-meta { margin-top:2px; }
      .org-row-count { flex:none; font-size:13px; color:var(--text-gray); white-space:nowrap; }
      .org-row-empty { padding:20px 16px; color:var(--text-gray); font-size:14px; }
      .org-legend i { display:inline-block; width:10px; height:10px; border-radius:3px; margin-right:4px; vertical-align:middle; border:1px solid var(--border); }
    `;
    document.head.appendChild(el);
  }

  /* Framing maths, kept pure and exported so it can be asserted on real
     numbers instead of on the shape of the source. `transform-origin` is
     `0 0`, so a canvas of width `canvasW` drawn at `scale` occupies
     [0, canvasW*scale]; centring it is a translate of half the leftover. */
  const ORG_MIN_SCALE = 0.45;
  const ORG_MAX_SCALE = 1.8;
  function centerOffset({ wrapW, wrapH, canvasW, canvasH, scale }) {
    if (!wrapW || !wrapH || !canvasW || !canvasH) return { x: 0, y: 0 };
    return {
      x: Math.round((wrapW - canvasW * scale) / 2),
      // Centre vertically only once the tree fits; otherwise keep the root's
      // own row at the top, where you expect to start reading.
      y: canvasH * scale <= wrapH ? Math.round((wrapH - canvasH * scale) / 2) : 0,
    };
  }
  function fitScale({ wrapW, wrapH, canvasW, canvasH }) {
    if (!wrapW || !wrapH || !canvasW || !canvasH) return 1;
    return Math.min(ORG_MAX_SCALE, Math.max(ORG_MIN_SCALE, Math.min(1, wrapW / canvasW, wrapH / canvasH)));
  }
  window.ORG_CHART_MATH = { centerOffset, fitScale, ORG_MIN_SCALE, ORG_MAX_SCALE };

  function buildTree(nodes) {
    const byParent = new Map();
    for (const n of nodes) {
      const key = n.parentId == null ? 'root' : String(n.parentId);
      if (!byParent.has(key)) byParent.set(key, []);
      byParent.get(key).push(n);
    }
    for (const list of byParent.values()) list.sort((a, b) => (a.sortOrder - b.sortOrder) || (a.id - b.id));
    function kids(id) { return byParent.get(id == null ? 'root' : String(id)) || []; }
    return { kids, roots: kids(null) };
  }

  function descendantSet(nodes, id) {
    const byParent = new Map();
    for (const n of nodes) {
      const key = n.parentId == null ? 'root' : String(n.parentId);
      if (!byParent.has(key)) byParent.set(key, []);
      byParent.get(key).push(n.id);
    }
    const out = new Set();
    const q = [id];
    while (q.length) {
      const cur = q.shift();
      for (const child of (byParent.get(String(cur)) || [])) {
        if (!out.has(child)) { out.add(child); q.push(child); }
      }
    }
    return out;
  }

  function Modal({ title, children, onClose, footer, wide }) {
    return (
      <div className="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
        <div className="modal" style={wide ? { maxWidth: 640 } : null} role="dialog" aria-modal="true">
          <div className="modal-head"><h3>{title}</h3>
            <button type="button" className="icon-btn" aria-label="Close dialog" onClick={onClose}>✕</button></div>
          <div className="modal-body">{children}</div>
          {footer && <div className="modal-foot">{footer}</div>}
        </div>
      </div>
    );
  }

  function NodeForm({ node, nodes, parentId, onClose, onSave }) {
    const [f, setF] = useState(() => ({
      employeeName: node?.employeeName || '',
      positionTitle: node?.positionTitle || '',
      department: node?.department || '',
      projectOrLocation: node?.projectOrLocation || '',
      parentId: node ? (node.parentId == null ? '' : String(node.parentId)) : (parentId == null ? '' : String(parentId)),
      nodeType: node?.nodeType || (node?.employeeName ? 'employee_position' : 'employee_position'),
      status: node?.status || 'filled',
      notes: node?.notes || '',
    }));
    const [busy, setBusy] = useState(false);
    const [err, setErr] = useState(null);
    const set = (k, v) => setF((s) => ({ ...s, [k]: v }));
    const blocked = node ? descendantSet(nodes, node.id) : new Set();
    if (node) blocked.add(node.id);
    const reportsTo = nodes.filter((n) => !blocked.has(n.id));

    async function save() {
      setBusy(true); setErr(null);
      try {
        await onSave({
          ...f,
          parentId: f.parentId === '' ? null : Number(f.parentId),
          status: f.status,
        });
      } catch (e) { setErr(e.message || 'Could not save'); setBusy(false); }
    }

    return (
      <Modal title={node ? 'Edit position' : 'Add position'} onClose={onClose} wide
        footer={<><button className="btn btn-ghost" type="button" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn" type="button" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button></>}>
        {err && <div className="error-banner">{err}</div>}
        <div className="form-grid">
          <div className="field"><label>Employee name</label>
            <input value={f.employeeName} onChange={(e) => set('employeeName', e.target.value)} placeholder="Leave blank if vacant" /></div>
          <div className="field"><label>Position title</label>
            <input value={f.positionTitle} onChange={(e) => set('positionTitle', e.target.value)} placeholder="Project Manager" /></div>
          <div className="field"><label>Department / function</label>
            <input value={f.department} onChange={(e) => set('department', e.target.value)} /></div>
          <div className="field"><label>Project or location</label>
            <input value={f.projectOrLocation} onChange={(e) => set('projectOrLocation', e.target.value)} /></div>
          <div className="field"><label>Type</label>
            <select value={f.nodeType} onChange={(e) => set('nodeType', e.target.value)}>
              {NODE_TYPES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
            </select></div>
          <div className="field"><label>Status</label>
            <select value={f.status} onChange={(e) => set('status', e.target.value)}>
              <option value="filled">Filled</option>
              <option value="vacant">Vacant</option>
            </select></div>
          <div className="field full"><label>Reports to</label>
            <select value={f.parentId} onChange={(e) => set('parentId', e.target.value)}>
              <option value="">— Top level —</option>
              {reportsTo.map((n) => (
                <option key={n.id} value={n.id}>
                  {(n.employeeName || n.positionTitle || ('#' + n.id)) + (n.projectOrLocation ? ' · ' + n.projectOrLocation : '')}
                </option>
              ))}
            </select></div>
          <div className="field full"><label>Notes</label>
            <textarea rows="3" value={f.notes} onChange={(e) => set('notes', e.target.value)} /></div>
        </div>
      </Modal>
    );
  }

  function OrgCard({ node, active, match, canManage, collapsed, childCount, onToggle, onSelect, onDragStart, onDrop }) {
    const vacant = isVacant(node);
    const unitish = isUnit(node);
    const cls = 'org-card'
      + (active ? ' is-active' : '')
      + (vacant ? ' is-vacant' : '')
      + (unitish ? ' is-unit' : '')
      + (node.nodeType === 'project' ? ' is-project' : '')
      + (match ? ' is-match' : '');
    return (
      <div className="org-node"
        onDragOver={canManage ? (e) => { e.preventDefault(); e.currentTarget.classList.add('org-drop'); } : undefined}
        onDragLeave={canManage ? (e) => e.currentTarget.classList.remove('org-drop') : undefined}
        onDrop={canManage ? (e) => { e.preventDefault(); e.currentTarget.classList.remove('org-drop'); onDrop(node); } : undefined}>
        <div className={cls} draggable={canManage} onDragStart={(e) => onDragStart(e, node)} onClick={() => onSelect(node)}>
          <div className="org-card-top">
            <span className={avatarClass(node)}>{avatarText(node)}</span>
            <div>
              <div className="org-name">{nodeName(node)}</div>
              <div className="org-title">{nodeTitle(node)}</div>
            </div>
          </div>
          {nodeMeta(node) && <div className="org-meta">{nodeMeta(node)}</div>}
        </div>
        {childCount > 0 && (
          <button type="button" className="org-toggle" onClick={(e) => { e.stopPropagation(); onToggle(node.id); }}>
            {collapsed ? `Show ${childCount}` : 'Hide'}
          </button>
        )}
      </div>
    );
  }

  function Tree({ nodes, kids, roots, collapsed, selectedId, matches, canManage, onToggle, onSelect, onDragStart, onDrop }) {
    function renderList(list) {
      if (!list.length) return null;
      return (
        <ul>
          {list.map((node) => {
            const children = kids(node.id);
            const isCollapsed = collapsed.has(node.id);
            return (
              <li key={node.id}>
                <OrgCard
                  node={node}
                  active={selectedId === node.id}
                  match={matches.has(node.id)}
                  canManage={canManage}
                  collapsed={isCollapsed}
                  childCount={children.length}
                  onToggle={onToggle}
                  onSelect={onSelect}
                  onDragStart={onDragStart}
                  onDrop={onDrop}
                />
                {!isCollapsed && renderList(children)}
              </li>
            );
          })}
        </ul>
      );
    }
    return <div className="org-tree">{renderList(roots)}</div>;
  }


  /* The phone view of the chart. A 113-position tree lays out ~19,500px wide;
     no zoom level makes that readable in 390px, and one finger cannot both
     scroll the page and pan a canvas. So the phone walks the same tree one
     position at a time: who this is, the path above them, and their direct
     reports as rows you tap to go down. Same `visible` filter and `matches`
     search as the canvas — only the presentation differs. */
  // Only reached if app.jsx failed to load, in which case nothing renders anyway.
  function useNoPhone() { return false; }

  function OrgDrill({ nodes, kids, roots, matches, searching, focusId, onFocus, manage, onAdd, onEdit, onDelete }) {
    const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
    // A chart with one top position (the company) opens on it, not on a list of one.
    const current = focusId != null && byId.has(focusId) ? byId.get(focusId)
      : (roots.length === 1 ? roots[0] : null);
    const trail = [];
    for (let n = current; n; n = n.parentId != null ? byId.get(n.parentId) : null) trail.unshift(n);
    const rows = searching ? nodes.filter((n) => matches.has(n.id)) : (current ? kids(current.id) : roots);

    // A plain render function, not a nested component: a component declared
    // inside OrgDrill would be a new type every render and remount every row.
    function renderRow(node) {
      const count = kids(node.id).length;
      const meta = nodeMeta(node);
      return (
        <button key={node.id} type="button" className="org-row" onClick={() => onFocus(node.id)}>
          <span className={avatarClass(node)} aria-hidden="true">{avatarText(node)}</span>
          <span className="org-row-body">
            <span className="org-name" style={{ display: 'block' }}>{nodeName(node)}</span>
            <span className="org-title" style={{ display: 'block' }}>{nodeTitle(node)}</span>
            {meta && <span className="org-meta" style={{ display: 'block' }}>{meta}</span>}
          </span>
          {count > 0 && <span className="org-row-count">{count} ›</span>}
        </button>
      );
    }

    return (
      <div className="org-drill">
        {!searching && trail.length > 1 && (
          <nav className="org-trail" aria-label="Reporting line">
            {roots.length > 1 && <button type="button" onClick={() => onFocus(null)}>Top</button>}
            {trail.map((n, i) => (
              <button key={n.id} type="button" aria-current={i === trail.length - 1 ? 'true' : undefined}
                onClick={() => onFocus(n.id)}>{nodeName(n)}</button>
            ))}
          </nav>
        )}
        {!searching && current && (
          <div className="card org-focus">
            <div className="org-card-top" style={{ gap: 12 }}>
              <span className={avatarClass(current)} aria-hidden="true">{avatarText(current)}</span>
              <div style={{ minWidth: 0 }}>
                <div className="org-name">{nodeName(current)}</div>
                <div className="org-title">{nodeTitle(current)}</div>
                {nodeMeta(current) && <div className="org-meta">{nodeMeta(current)}</div>}
              </div>
            </div>
            {current.notes && <p style={{ margin: '12px 0 0', fontSize: 14 }}>{current.notes}</p>}
            {manage && (
              <div className="org-focus-actions">
                <button className="btn" type="button" onClick={() => onAdd(current.id)}>Add report</button>
                <button className="btn btn-secondary" type="button" onClick={() => onEdit(current)}>Edit</button>
                <button className="btn btn-danger" type="button" onClick={() => onDelete(current)}>Delete</button>
              </div>
            )}
          </div>
        )}
        <div className="card org-list">
          <div className="org-list-head">
            {searching ? `${rows.length} matching`
              : !current ? `Top positions · ${rows.length}`
              : isUnit(current) ? `In ${nodeName(current)} · ${rows.length}`
              : `Direct reports · ${rows.length}`}
          </div>
          {rows.length
            ? rows.map(renderRow)
            : <div className="org-row-empty">{searching ? 'No position matches that search.' : 'No one reports to this position yet.'}</div>}
        </div>
      </div>
    );
  }

  function OrgStructurePage({ user }) {
    injectStyles();
    const manage = canManageChart(user);
    const [nodes, setNodes] = useState(null);
    const [err, setErr] = useState(null);
    const [q, setQ] = useState('');
    const [filter, setFilter] = useState('all');
    const [collapsed, setCollapsed] = useState(() => new Set());
    const [selected, setSelected] = useState(null);
    const [form, setForm] = useState(null);
    const [confirmDel, setConfirmDel] = useState(null);
    const isPhone = (window.ArabtecUseIsPhone || useNoPhone)();
    const [focusId, setFocusId] = useState(null);
    const [toast, setToast] = useState(null);
    const [scale, setScale] = useState(1);
    const [pan, setPan] = useState({ x: 0, y: 0 });
    const wrapRef = useRef(null);
    const dragId = useRef(null);
    const panning = useRef(null);

    const show = (msg, type) => { setToast({ msg, type: type || 'success' }); setTimeout(() => setToast(null), 2800); };

    const load = useCallback(async () => {
      try {
        const r = await api().get('/org/chart');
        if (!Array.isArray(r?.nodes)) throw new Error('Organization Structure is temporarily unavailable. Please retry.');
        setNodes(r.nodes);
        setErr(null);
      } catch (e) { setErr(e.message || 'Could not load organization structure'); }
    }, []);
    useEffect(() => { load(); }, [load]);

    const projects = useMemo(() => {
      const list = (nodes || []).filter((n) => n.nodeType === 'project');
      const seen = new Set();
      return list.filter((n) => {
        const k = (n.positionTitle || '').toLowerCase();
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    }, [nodes]);

    const visible = useMemo(() => {
      if (!nodes) return [];
      if (filter === 'all') return nodes;
      if (filter === 'ho') {
        return nodes.filter((n) => /head office/i.test(n.projectOrLocation || '') || /head office/i.test(n.positionTitle || ''));
      }
      const projectNode = nodes.find((n) => n.nodeType === 'project' && n.positionTitle === filter);
      if (!projectNode) {
        return nodes.filter((n) => (n.projectOrLocation || '') === filter);
      }
      const under = descendantSet(nodes, projectNode.id);
      under.add(projectNode.id);
      return nodes.filter((n) => under.has(n.id) || ((n.projectOrLocation || '').includes(filter) && n.nodeType !== 'project'));
    }, [nodes, filter]);

    const tree = useMemo(() => buildTree(visible), [visible]);
    const matches = useMemo(() => {
      const term = q.trim().toLowerCase();
      if (!term) return new Set();
      return new Set((visible || []).filter((n) =>
        [n.employeeName, n.positionTitle, n.department, n.projectOrLocation].join(' ').toLowerCase().includes(term)
      ).map((n) => n.id));
    }, [visible, q]);

    /* `.org-canvas` is `width: max-content` and `.org-tree` centres itself
       inside it, so with the seeded 113 positions the canvas lays out 19552px
       wide and the root sits ~9670px in. Pan (0, 0) therefore shows the far
       LEFT edge of that canvas — an arbitrary handful of leaf nodes, with the
       root and 334 of 339 cards off-screen and no way to reach them: the wrap
       is `overflow: hidden` on both axes, so nothing scrolls, and `fit()` used
       to BE `setPan({ x: 0, y: 0 })`, which is exactly that broken state.
       Zoom-out only shrinks about `transform-origin: 0 0`, so it never brings
       the middle of the canvas into view either.

       Centre on the canvas's own midpoint instead. The tree is centred within
       the canvas, so this frames the root at any scale. */
    const centerOn = useCallback((nextScale) => {
      const wrap = wrapRef.current;
      const canvas = wrap && wrap.firstElementChild;
      if (!wrap || !canvas) { setScale(nextScale); setPan({ x: 0, y: 0 }); return; }
      // offsetWidth/Height are layout sizes — unaffected by the transform we are
      // about to set, which is what makes this safe to call repeatedly.
      const cw = canvas.offsetWidth;
      const ch = canvas.offsetHeight;
      const ww = wrap.clientWidth;
      const wh = wrap.clientHeight;
      setScale(nextScale);
      setPan(centerOffset({ wrapW: ww, wrapH: wh, canvasW: cw, canvasH: ch, scale: nextScale }));
    }, []);

    /* Re-frame whenever the rendered tree changes WIDTH.

       Keying this on `visible.length` was wrong: `visible` depends only on
       `nodes` and the project filter, while expanding or collapsing a node
       changes the `collapsed` Set instead. So the tree could be rebuilt at a
       completely different width without the effect ever firing. Collapsing
       the root shrank the canvas 19552px -> 1095px while the pan stayed at
       -9228px, which put the only remaining card off-screen and left the
       module blank; expanding from a collapsed state stranded every revealed
       child off to the left. Both are the same defect the initial framing was
       added to fix, just reached through the toolbar instead of on load.

       The canvas's own layout width is the honest signal — it changes for
       every one of those causes and for none of the others. A transform does
       not affect layout size, so re-centring cannot retrigger the observer.
       The first framing sets scale 1; later ones keep whatever scale the user
       is on, so re-framing never fights a deliberate zoom. */
    const scaleRef = useRef(1);
    useEffect(() => { scaleRef.current = scale; }, [scale]);

    const framedOnce = useRef(false);
    const hasTree = visible.length > 0;
    useEffect(() => {
      const wrap = wrapRef.current;
      const canvas = wrap && wrap.firstElementChild;
      if (!hasTree || !wrap || !canvas) return undefined;
      let lastWidth = 0;
      const reframe = () => {
        const w = canvas.offsetWidth;
        if (!w || w === lastWidth) return;
        lastWidth = w;
        centerOn(framedOnce.current ? scaleRef.current : 1);
        framedOnce.current = true;
      };
      const raf = requestAnimationFrame(reframe);
      if (typeof ResizeObserver === 'undefined') return () => cancelAnimationFrame(raf);
      const ro = new ResizeObserver(reframe);
      ro.observe(canvas);
      return () => { cancelAnimationFrame(raf); ro.disconnect(); };
    }, [hasTree, centerOn, isPhone]);

    /* Searching only added a highlight ring. On a canvas this wide the match is
       almost always off-screen, so typing a name looked like it found nothing.
       Bring the first match into view — a pure pan by the on-screen delta, so
       it is scale-agnostic and does not disturb the zoom the user chose. The
       tree's width does not change when a match is highlighted, so this never
       races the width-driven reframing above. */
    const matchCount = matches.size;
    useEffect(() => {
      if (!q.trim() || !matchCount) return undefined;
      const raf = requestAnimationFrame(() => {
        const wrap = wrapRef.current;
        const hit = wrap && wrap.querySelector('.org-card.is-match');
        if (!wrap || !hit) return;
        const wr = wrap.getBoundingClientRect();
        const hr = hit.getBoundingClientRect();
        const dx = (wr.left + wr.width / 2) - (hr.left + hr.width / 2);
        const dy = (wr.top + wr.height / 2) - (hr.top + hr.height / 2);
        if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
        setPan((prev) => ({ x: Math.round(prev.x + dx), y: Math.round(prev.y + dy) }));
      });
      return () => cancelAnimationFrame(raf);
    }, [q, matchCount]);

    function toggle(id) {
      setCollapsed((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id); else next.add(id);
        return next;
      });
    }
    function expandAll() { setCollapsed(new Set()); }
    function collapseAll() {
      setCollapsed(new Set((visible || []).filter((n) => tree.kids(n.id).length).map((n) => n.id)));
    }

    function onWheel(e) {
      e.preventDefault();
      const next = Math.min(1.8, Math.max(0.45, scale + (e.deltaY > 0 ? -0.08 : 0.08)));
      setScale(next);
    }
    function onMouseDown(e) {
      if (e.button !== 0) return;
      if (e.target.closest('.org-card') || e.target.closest('button') || e.target.closest('input') || e.target.closest('select')) return;
      panning.current = { x: e.clientX - pan.x, y: e.clientY - pan.y };
      e.currentTarget.classList.add('is-panning');
    }
    function onMouseMove(e) {
      if (!panning.current) return;
      setPan({ x: e.clientX - panning.current.x, y: e.clientY - panning.current.y });
    }
    function onMouseUp(e) {
      panning.current = null;
      e.currentTarget.classList.remove('is-panning');
    }
    function fit() {
      const wrap = wrapRef.current;
      const canvas = wrap && wrap.firstElementChild;
      if (!wrap || !canvas) { centerOn(1); return; }
      const cw = canvas.offsetWidth;
      const ch = canvas.offsetHeight;
      const ww = wrap.clientWidth;
      const wh = wrap.clientHeight;
      if (!cw || !ch || !ww || !wh) { centerOn(1); return; }
      // Same 0.45 floor the zoom buttons and the wheel already enforce — this
      // module's own definition of "still readable". A fully expanded chart is
      // wider than any floor can fit, so Fit means "as much as stays legible,
      // centred", not "shrink until it disappears".
      centerOn(fitScale({ wrapW: ww, wrapH: wh, canvasW: cw, canvasH: ch }));
    }

    async function saveNode(payload) {
      if (form && form.node) {
        await api().put('/org/chart/nodes/' + form.node.id, payload);
        show('Position updated');
      } else {
        await api().post('/org/chart/nodes', payload);
        show('Position added');
      }
      setForm(null);
      await load();
    }

    async function moveNode(id, parentId) {
      try {
        await api().post('/org/chart/nodes/' + id + '/move', { parentId });
        show('Reporting line updated');
        await load();
      } catch (e) { show(e.message || 'Move failed', 'error'); }
    }

    async function deleteNode(mode) {
      const n = confirmDel;
      try {
        const qs = mode === 'branch'
          ? '?mode=branch&confirm=true'
          : (n.reassignTo ? ('?mode=node&reassignTo=' + encodeURIComponent(n.reassignTo)) : '?mode=node');
        await api().del('/org/chart/nodes/' + n.node.id + qs);
        show(mode === 'branch' ? 'Branch removed' : 'Position removed');
        setConfirmDel(null); setSelected(null);
        await load();
      } catch (e) { show(e.message || 'Could not delete', 'error'); }
    }

    function onDragStart(e, node) {
      if (!manage) return;
      dragId.current = node.id;
      e.dataTransfer.setData('text/plain', String(node.id));
    }
    function onDrop(target) {
      const id = dragId.current;
      dragId.current = null;
      if (!manage || id == null || id === target.id) return;
      moveNode(id, target.id);
    }

    const selectedNode = selected && (nodes || []).find((n) => n.id === selected);

    return (
      <div>
        <div className="page-head">
          <div>
            <div className="breadcrumb">Workspace / Organization Structure</div>
            <h1 className="page-title">Organization Structure</h1>
            <p className="page-sub">Head Office, projects, departments and reporting lines. {
              manage ? 'You can add, edit and move positions.' : 'View only — editing is limited to organization administrators.'
            }</p>
          </div>
          <div className="page-head-actions">
            {manage && <button className="btn" type="button" onClick={() => setForm({ node: null, parentId: (isPhone ? focusId : selected) || null })}>Add position</button>}
          </div>
        </div>

        <div className="toolbar org-toolbar-wrap">
          <input placeholder="Search name, title, department…" value={q} onChange={(e) => setQ(e.target.value)} style={{ minWidth: 220 }} />
          <select value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="all">All</option>
            <option value="ho">Head Office</option>
            <option value="Projects">Projects</option>
            {projects.map((p) => <option key={p.id} value={p.positionTitle}>{p.positionTitle}</option>)}
          </select>
          {!isPhone && <>
            <button className="btn btn-sm btn-ghost" type="button" onClick={expandAll}>Expand</button>
            <button className="btn btn-sm btn-ghost" type="button" onClick={collapseAll}>Collapse</button>
            <button className="btn btn-sm btn-ghost" type="button" onClick={() => setScale((s) => Math.min(1.8, s + 0.1))}>Zoom in</button>
            <button className="btn btn-sm btn-ghost" type="button" onClick={() => setScale((s) => Math.max(0.45, s - 0.1))}>Zoom out</button>
            <button className="btn btn-sm btn-ghost" type="button" onClick={fit}>Fit</button>
          </>}
          <div className="spacer" />
          <span className="muted">{nodes ? nodes.length + ' positions' : 'Loading…'}</span>
        </div>

        {!isPhone && <div className="org-legend" style={{ margin: '0 0 10px' }}>
          <span><i style={{ background: 'var(--surface, #fff)' }} />Employee</span>
          <span><i style={{ background: '#fff', borderStyle: 'dashed' }} />Vacant</span>
          <span><i style={{ background: 'var(--at-action-tint, rgba(0,128,100,.08))' }} />Unit / project</span>
        </div>}

        {err && <div className="error-banner" role="alert">{err} <button className="btn btn-sm" type="button" onClick={load}>Retry</button></div>}
        {!nodes && err ? null : !nodes ? <div className="card card-pad">Loading organization structure…</div> : !visible.length ? (
          <div className="card"><div className="empty"><h3>{nodes.length ? "No matching positions" : "Work in progress"}</h3><p>{nodes.length ? "Try another project or Head Office filter." : "Your organization chart is being prepared. Positions will appear here when your administrator adds them."}</p></div></div>
        ) : isPhone ? (
          <OrgDrill
            nodes={visible}
            kids={tree.kids}
            roots={tree.roots}
            matches={matches}
            searching={!!q.trim()}
            focusId={focusId}
            onFocus={(id) => { setFocusId(id); setQ(''); window.scrollTo({ top: 0, behavior: 'smooth' }); }}
            manage={manage}
            onAdd={(parentId) => setForm({ node: null, parentId })}
            onEdit={(node) => setForm({ node })}
            onDelete={(node) => setConfirmDel({ node, reassignTo: '' })}
          />
        ) : (
          <div className="org-canvas-wrap" ref={wrapRef}
            onWheel={onWheel} onMouseDown={onMouseDown} onMouseMove={onMouseMove}
            onMouseUp={onMouseUp} onMouseLeave={onMouseUp}>
            <div className="org-canvas" style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})` }}>
              <Tree
                nodes={visible}
                kids={tree.kids}
                roots={tree.roots}
                collapsed={collapsed}
                selectedId={selected}
                matches={matches}
                canManage={manage}
                onToggle={toggle}
                onSelect={(n) => setSelected(n.id)}
                onDragStart={onDragStart}
                onDrop={onDrop}
              />
            </div>
          </div>
        )}

        {!isPhone && selectedNode && (
          <div className="card card-pad" style={{ marginTop: 12 }}>
            <div className="row-between">
              <div>
                <strong>{nodeName(selectedNode)}</strong>
                <div className="muted">{isUnit(selectedNode) ? nodeTitle(selectedNode)
                  : [selectedNode.employeeName && selectedNode.positionTitle, isVacant(selectedNode) ? 'Vacant' : 'Filled'].filter(Boolean).join(' · ')}</div>
                {nodeMeta(selectedNode) && <div className="muted">{nodeMeta(selectedNode)}</div>}
              </div>
              {manage && <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn btn-sm" type="button" onClick={() => setForm({ node: null, parentId: selectedNode.id })}>Add report</button>
                <button className="btn btn-sm btn-secondary" type="button" onClick={() => setForm({ node: selectedNode })}>Edit</button>
                <button className="btn btn-sm btn-danger" type="button" onClick={() => setConfirmDel({ node: selectedNode, reassignTo: '' })}>Delete</button>
              </div>}
            </div>
            {selectedNode.notes && <p style={{ marginBottom: 0 }}>{selectedNode.notes}</p>}
          </div>
        )}

        {form && <NodeForm node={form.node} nodes={nodes || []} parentId={form.parentId} onClose={() => setForm(null)} onSave={saveNode} />}

        {confirmDel && (
          <Modal title="Remove position" onClose={() => setConfirmDel(null)}
            footer={<><button className="btn btn-ghost" type="button" onClick={() => setConfirmDel(null)}>Cancel</button>
              <button className="btn btn-secondary" type="button" onClick={() => deleteNode('node')}>Remove this position</button>
              <button className="btn btn-danger" type="button" onClick={() => deleteNode('branch')}>Delete whole branch</button></>}>
            <p style={{ marginTop: 0 }}>Remove <strong>{confirmDel.node.employeeName || confirmDel.node.positionTitle}</strong>? A branch is never deleted silently — choose whether to remove only this box or everyone under it.</p>
            <div className="field">
              <label>If this position has reports, reassign them to</label>
              <select value={confirmDel.reassignTo} onChange={(e) => setConfirmDel((s) => ({ ...s, reassignTo: e.target.value }))}>
                <option value="">— required unless deleting the branch —</option>
                {(nodes || []).filter((n) => n.id !== confirmDel.node.id).map((n) => (
                  <option key={n.id} value={n.id}>{n.employeeName || n.positionTitle}</option>
                ))}
              </select>
            </div>
          </Modal>
        )}

        {toast && (
          <div role="status" style={{ position: 'fixed', bottom: isPhone ? 96 : 24, right: isPhone ? 16 : 24, left: isPhone ? 16 : 'auto', zIndex: 200,
            background: toast.type === 'error' ? 'var(--critical)' : 'var(--success)',
            color: '#fff', padding: '12px 18px', borderRadius: 8, fontSize: 13.5, fontWeight: 600 }}>
            {toast.msg}
          </div>
        )}
      </div>
    );
  }

  window.ArabtecOrgStructurePage = OrgStructurePage;
})();
