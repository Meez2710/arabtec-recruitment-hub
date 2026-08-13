/* Arabtec Candidate Intake Review
   Drop-in Babel/React component for the frozen pre-candidate intake API.
   Decisions remain local until one complete review map is submitted. */
(function () {
  const h = React.createElement;
  const { useCallback, useEffect, useMemo, useRef, useState } = React;
  const LABELS = {
    fullName: 'Full name', full_name: 'Full name', email: 'Email', phone: 'Phone',
    linkedinUrl: 'LinkedIn', linkedin: 'LinkedIn', nationality: 'Nationality', location: 'Location',
    currentCompany: 'Current company', current_company: 'Current company',
    currentPosition: 'Current position', current_position: 'Current position',
    yearsExperience: 'Years of experience', years_experience: 'Years of experience',
    graduationCertificate: 'Graduation certificate / degree', degree: 'Graduation certificate / degree',
    graduationUniversity: 'University', university: 'University', graduationYear: 'Graduation year', graduation_year: 'Graduation year',
    noticePeriod: 'Notice period', notice_period: 'Notice period', skills: 'Skills'
  };
  const FIELD_ORDER = ['fullName','email','phone','linkedinUrl','nationality','location','currentCompany','currentPosition','yearsExperience','graduationCertificate','graduationUniversity','graduationYear','noticePeriod','skills'];
  const api = () => {
    if (!window.ARABTEC_API) throw new Error('ATS API is not ready.');
    return window.ARABTEC_API;
  };
  const listOf = (r) => Array.isArray(r) ? r : (r && (r.intakes || r.items || r.results)) || [];
  const oneOf = (r) => (r && (r.intake || r.item)) || r || {};
  const clean = (v) => v == null || v === '' ? '—' : Array.isArray(v) ? v.join(', ') : typeof v === 'object' ? JSON.stringify(v) : String(v);
  const when = (v) => { const d = new Date(v); return v && !isNaN(d) ? d.toLocaleString() : '—'; };
  const initials = (v) => (v || '?').split(/\s+/).filter(Boolean).slice(0,2).map(x => x[0]).join('').toUpperCase();
  const labelFor = (key) => LABELS[key] || String(key).replace(/([a-z])([A-Z])/g,'$1 $2').replace(/_/g,' ').replace(/^./,c=>c.toUpperCase());
  const evidenceText = (e) => {
    if (!e) return 'No evidence supplied';
    if (typeof e === 'string') return e;
    return e.quote || e.text || e.snippet || e.rawText || e.value || [e.page != null ? `Page ${e.page}` : '', e.blockId ? `Block ${e.blockId}` : ''].filter(Boolean).join(' · ') || 'Evidence available';
  };
  function normaliseFields(intake) {
    const source = intake.reviewFields || intake.fields || intake.proposal?.fields || intake.parsed?.fields || intake.parsedDocument?.fields || {};
    let rows = Array.isArray(source) ? source.map((x,i) => ({ key: x.key || x.field || x.name || `field_${i}`, ...x }))
      : Object.entries(source).map(([key,v]) => v && typeof v === 'object' && !Array.isArray(v) ? ({ key, ...v }) : ({ key, value:v }));
    const byKey = new Map(rows.map(r => [r.key, r]));
    rows = [...FIELD_ORDER.filter(k => byKey.has(k)).map(k => byKey.get(k)), ...rows.filter(r => !FIELD_ORDER.includes(r.key))];
    return rows.map(r => ({
      key: r.key, label: r.label || labelFor(r.key),
      value: r.value ?? r.normalizedValue ?? r.normalized ?? r.parsedValue ?? r.rawValue ?? '',
      evidence: r.evidence || r.provenance || r.source, confidence: r.confidence,
      decision: String(r.decision || 'PENDING').toUpperCase()
    }));
  }
  function Banner({ tone='info', title, children }) {
    return h('div',{className:`intake-banner ${tone}`},h('strong',null,title),h('div',null,children));
  }
  function IntakeList({ items, active, onOpen, loading }) {
    if (loading) return h('div',{className:'intake-list-state'},'Loading pending CV reviews…');
    if (!items.length) return h('div',{className:'intake-list-state'},h('strong',null,'No pending reviews'),h('span',null,'New CV uploads will appear here before a candidate is created.'));
    return h('div',{className:'intake-list'},items.map(x => {
      const id = x.iid || x.id;
      const name = x.fullName || x.full_name || x.filename || x.fileName || `Intake ${id}`;
      return h('button',{key:id,className:'intake-list-row'+(String(active)===String(id)?' active':''),onClick:()=>onOpen(id)},
        h('span',{className:'intake-avatar'},initials(name)),
        h('span',{className:'intake-list-copy'},h('strong',null,name),h('small',null,(x.requestTitle || x.request?.title || 'Talent pool')+' · '+when(x.createdAt || x.created_at))),
        h('span',{className:'intake-state'},x.status || 'PENDING'));
    }));
  }
  function Evidence({ value }) {
    return h('div',{className:'evidence-cell'},h('div',{className:'evidence-quote'},'“'+evidenceText(value)+'”'),
      value && typeof value === 'object' && (value.page != null || value.blockId) ? h('small',null,[value.page != null ? `Page ${value.page}` : null,value.blockId ? `Block ${value.blockId}` : null].filter(Boolean).join(' · ')) : null);
  }
  function DuplicateNotice({ duplicate }) {
    const matches = duplicate?.matches || [];
    if (!matches.length) return null;
    const blocked = duplicate.blocked === true || matches.some(m => m.kind === 'exact');
    return h(Banner,{tone:blocked?'danger':'warning',title:blocked?'Exact duplicate identifier found':'Potential match — review only'},
      h('span',null,blocked ? 'Candidate creation is blocked unless an authorised override is confirmed. ' : 'Name-only matches do not block review. '),
      matches.map((m,i)=>h('span',{key:m.id||i,className:'duplicate-match'},`${m.candidateNo || m.id || 'Candidate'} · ${(m.matchedFields || []).join(', ') || m.kind}`)));
  }
  function ReviewTable({ fields, decisions, setDecision, edits, setEdit }) {
    return h('div',{className:'review-table-wrap'},h('table',{className:'review-table'},
      h('thead',null,h('tr',null,h('th',null,'Field'),h('th',null,'Parsed value'),h('th',null,'Evidence'),h('th',null,'Decision'))),
      h('tbody',null,fields.map(f => {
        const d = decisions[f.key] || 'PENDING';
        return h('tr',{key:f.key,className:'decision-'+d.toLowerCase()},
          h('td',null,h('strong',null,f.label),f.confidence!=null?h('small',null,`${Math.round(Number(f.confidence)*100)}% confidence`):null),
          h('td',null,d==='EDIT' ? h('input',{className:'review-edit',value:edits[f.key] ?? clean(f.value),onChange:e=>setEdit(f.key,e.target.value)}) : h('span',{className:'parsed-value'},clean(f.value))),
          h('td',null,h(Evidence,{value:f.evidence})),
          h('td',null,h('select',{className:'decision-select',value:d,onChange:e=>setDecision(f.key,e.target.value)},
            h('option',{value:'PENDING'},'Choose…'),h('option',{value:'ACCEPT'},'Accept'),h('option',{value:'EDIT'},'Edit'),h('option',{value:'REJECT'},'Reject'))));
      }))));
  }
  function IntakeDetail({ id, onDone, onBack }) {
    const [item,setItem]=useState(null), [fields,setFields]=useState([]), [decisions,setDecisions]=useState({}), [edits,setEdits]=useState({});
    const [busy,setBusy]=useState(false), [error,setError]=useState(''), [override,setOverride]=useState(false), [rejectOpen,setRejectOpen]=useState(false), [reason,setReason]=useState('');
    const savedRef=useRef({});
    const load=useCallback(async()=>{ setError(''); try { const x=oneOf(await api().get('/intakes/'+id)); const fs=normaliseFields(x); setItem(x); setFields(fs); const ds=Object.fromEntries(fs.map(f=>[f.key,f.decision==='PENDING'?'PENDING':f.decision])); setDecisions(ds); savedRef.current=ds; } catch(e){ setError(e.message); } },[id]);
    useEffect(()=>{load();},[load]);
    const pending=fields.filter(f=>(decisions[f.key]||'PENDING')==='PENDING').length;
    const duplicate=item?.duplicate || item?.duplicates || item?.duplicateCheck;
    const blocked=duplicate?.blocked===true;
    const setDecision=(k,v)=>setDecisions(s=>({...s,[k]:v}));
    const setEdit=(k,v)=>setEdits(s=>({...s,[k]:v}));
    const payloadDecisions=useMemo(()=>Object.fromEntries(fields.map(f=>[f.key,{decision:decisions[f.key]||'PENDING',...(decisions[f.key]==='EDIT'?{value:edits[f.key] ?? clean(f.value)}:{})}])),[fields,decisions,edits]);
    async function submit(){ if(pending) return; setBusy(true);setError('');try{const r=await api().post(`/intakes/${id}/review`,{decisions:payloadDecisions,version:item.version,overrideDuplicate:blocked?override:false,ownerRecruiterId:item.ownerRecruiterId || undefined}); onDone(r);}catch(e){setError(e.message);if(e.data?.error==='stale'||e.status===409) setError('This intake changed on the server. Your local decisions are preserved; reload before retrying.');}finally{setBusy(false);} }
    async function reject(){if(!reason.trim())return;setBusy(true);setError('');try{await api().post(`/intakes/${id}/review`,{reject:true,reason:reason.trim()});onDone();}catch(e){setError(e.message);}finally{setBusy(false);} }
    if(error && !item) return h('div',{className:'intake-detail-state'},h(Banner,{tone:'danger',title:'Unable to load intake'},error),h('button',{className:'btn btn-secondary',onClick:onBack},'Back'));
    if(!item) return h('div',{className:'intake-detail-state'},'Loading extracted fields…');
    const title=item.fullName || item.full_name || fields.find(f=>['fullName','full_name'].includes(f.key))?.value || item.filename || 'Candidate intake';
    return h('div',{className:'intake-review-detail'},
      h('div',{className:'intake-review-head'},h('div',null,h('button',{className:'intake-back',onClick:onBack},'← Candidate Review'),h('h1',null,title),h('p',null,`${item.filename || item.fileName || 'CV document'} · ${item.request?.title || item.requestTitle || 'Talent pool'} · Version ${item.version ?? '—'}`)),
        h('div',{className:'intake-head-actions'},h('button',{className:'btn btn-secondary',onClick:()=>api().download(`/intakes/${id}/document`)},'View CV'),h('button',{className:'btn btn-danger',onClick:()=>setRejectOpen(true)},'Reject intake'))),
      error?h(Banner,{tone:'danger',title:'Review not submitted'},error):null,
      h(DuplicateNotice,{duplicate}),
      h('div',{className:'review-summary'},h('div',null,h('strong',null,fields.length),h('span',null,'reviewable fields')),h('div',null,h('strong',null,pending),h('span',null,'decisions remaining')),h('div',null,h('strong',null,item.status||'PENDING'),h('span',null,'intake status'))),
      h('div',{className:'review-panel'},h('div',{className:'review-panel-head'},h('div',null,h('h2',null,'Parsed CV review'),h('p',null,'Approve, edit or reject every field. Nothing is persisted to the candidate database until final submission.')),h('button',{className:'btn btn-secondary',onClick:()=>setDecisions(Object.fromEntries(fields.map(f=>[f.key,'ACCEPT'])))},'Accept all')),
        h(ReviewTable,{fields,decisions,setDecision,edits,setEdit})),
      blocked?h('label',{className:'override-check'},h('input',{type:'checkbox',checked:override,onChange:e=>setOverride(e.target.checked)}),h('span',null,h('strong',null,'Authorised duplicate override'),h('small',null,'I verified the exact identifiers and confirm this should create a separate candidate.'))):null,
      h('div',{className:'review-submit'},h('span',null,pending?`${pending} fields still need a decision`:'Complete decision map ready'),h('button',{className:'btn btn-success',disabled:busy||pending>0||(blocked&&!override),onClick:submit},busy?'Submitting…':'Approve & create candidate')),
      rejectOpen?h('div',{className:'intake-modal-backdrop'},h('div',{className:'intake-modal'},h('h3',null,'Reject this intake?'),h('p',null,'The CV remains auditable but no candidate or application is created.'),h('textarea',{value:reason,onChange:e=>setReason(e.target.value),placeholder:'Required reason'}),h('div',null,h('button',{className:'btn btn-secondary',onClick:()=>setRejectOpen(false)},'Cancel'),h('button',{className:'btn btn-danger-solid',disabled:busy||!reason.trim(),onClick:reject},'Reject intake')))):null);
  }
  function CandidateIntakeReviewPage({ user }) {
    const [items,setItems]=useState([]),[loading,setLoading]=useState(true),[active,setActive]=useState(null),[error,setError]=useState(''),[uploading,setUploading]=useState(false);
    const fileRef=useRef(null);
    const load=useCallback(async()=>{setLoading(true);setError('');try{const xs=listOf(await api().get('/intakes'));setItems(xs.filter(x=>!x.status||String(x.status).toUpperCase()==='PENDING'));}catch(e){setError(e.message);}finally{setLoading(false);}},[]);
    useEffect(()=>{load();},[load]);
    async function uploadCv(e){
      const file=e.target.files && e.target.files[0]; e.target.value=''; if(!file) return;
      setUploading(true); setError('');
      try{
        const r=await api().upload('/parse-cv',file,{});
        const nextId=r.iid || r.intakeId || r.intake?.iid || r.intake?.id || r.id;
        await load(); if(nextId) setActive(nextId);
      }catch(err){ setError(err.message || 'CV upload failed'); }
      finally{ setUploading(false); }
    }
    if(active) return h(IntakeDetail,{id:active,onBack:()=>setActive(null),onDone:()=>{setActive(null);load();}});
    return h('div',null,h('div',{className:'page-head intake-page-head'},h('div',{className:'page-head-main'},h('div',{className:'breadcrumb'},'Recruitment / Candidate Review'),h('h1',{className:'page-title'},'Candidate Intake Review'),h('p',{className:'page-sub'},'Human approval gate between CV parsing and candidate creation.')),
      h('div',{className:'page-head-actions'},h('span',{className:'status-chip pending'},`${items.length} pending`),h('input',{ref:fileRef,type:'file',accept:'.pdf,.doc,.docx,.png,.jpg,.jpeg,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,image/png,image/jpeg',style:{display:'none'},onChange:uploadCv}),h('button',{className:'btn btn-secondary',disabled:uploading,onClick:()=>fileRef.current&&fileRef.current.click()},uploading?'Uploading…':'Upload CV'),h('button',{className:'btn btn-success',disabled:uploading,onClick:load},'Refresh'))),
      h(Banner,{tone:'info',title:'Workflow control'},'Upload creates a pending intake only. Candidate and application records are created after complete human review.'),
      error?h(Banner,{tone:'danger',title:'Unable to load intakes'},error):null,
      h('div',{className:'card intake-queue'},h('div',{className:'card-head'},h('h3',null,'Pending CVs'),h('span',{className:'muted'},'No automatic persistence')),h(IntakeList,{items,active,onOpen:setActive,loading})));
  }
  window.ArabtecCandidateIntakeReviewPage = CandidateIntakeReviewPage;
})();
