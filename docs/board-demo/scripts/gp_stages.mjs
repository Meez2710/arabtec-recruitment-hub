// Golden-path stages. Each runs as the role that does that step in real life.
export default {
  // 1. HR Manager: sign in, dashboard, raise a request and submit it.
  async request(h) {
    await h.loginUI('hr.manager@arabtec.com', { screenshot: '01-login' });
    await h.shot('02-dashboard');
    await h.open('requests');
    await h.click('Create Request');
    await h.type('Position', 'Site Planning Engineer (BOARD DEMO)', '.modal');
    await h.choose('Department', 'Planning', '.modal');
    await h.choose('Project / Site', '*first', '.modal');
    await h.choose('Priority', 'high', '.modal');
    await h.type('Key Responsibilities', 'Baseline and update the Primavera P6 programme; weekly progress reporting.', '.modal');
    await h.type('Key Requirements', 'B.Sc. Civil Engineering; 5+ years site planning; Primavera P6.', '.modal');
    await h.shot('03-request-form');
    await h.click('Create Request', '.modal');
    await h.c.sleep(1500);
    const list = await h.api('/api/requests?pageSize=50');
    const r = (list.json?.requests || []).find((x) => /Site Planning Engineer \(BOARD DEMO\)/.test(x.title || x.positionTitle || ''));
    if (!r) throw new Error('request not created: ' + JSON.stringify(list.json).slice(0, 200));
    h.st.requestId = r.id; h.st.ticketNo = r.ticketNo; h.step('created', { id: r.id, ticketNo: r.ticketNo, status: r.status });
    await h.open(`requests/${r.id}`);
    await h.shot('04-request-created');
  },
  // 2. HR Manager submits; HR Director approves; Recruitment Manager assigns.
  async approve(h) {
    await h.loginUI('hr.manager@arabtec.com');
    await h.open(`requests/${h.st.requestId}`);
    if (!h.st.submitted) { await h.click('Submit for approval'); h.st.submitted = true; h.save(); }
    await h.c.sleep(1200);
    h.step('after submit', { status: (await h.api(`/api/requests/${h.st.requestId}`)).json?.request?.status, toast: await h.toast() });
    await h.loginUI('hr.director@arabtec.com');
    await h.open(`requests/${h.st.requestId}`);
    await h.shot('05-director-review');
    await h.click('Approve');
    await h.c.sleep(800);
    // A confirmation dialog may ask for a comment; confirm it if present.
    const confirmBtn = await h.c.ev(`const m = document.querySelector('.modal'); return m ? [...m.querySelectorAll('button')].map(b => b.textContent.trim()) : null;`);
    h.step('approve dialog', { buttons: confirmBtn });
    if (confirmBtn) await h.click(confirmBtn.find((t) => /^Approve/.test(t)) || confirmBtn[confirmBtn.length - 1], '.modal');
    await h.c.sleep(1200);
    h.step('after approve', { status: (await h.api(`/api/requests/${h.st.requestId}`)).json?.request?.status });
  },
  async assign(h) {
    await h.loginUI('rec.manager@arabtec.com');
    await h.open(`requests/${h.st.requestId}`);
    await h.click('Assign recruiter');
    await h.c.sleep(600);
    await h.choose('Recruiter / Owner', 'Karim Adel', '.modal');
    const btns = await h.c.ev(`return [...document.querySelector('.modal').querySelectorAll('button')].map(b => b.textContent.trim());`);
    await h.click(btns.find((t) => /^Assign/.test(t)), '.modal');
    await h.c.sleep(1200);
    const r = (await h.api(`/api/requests/${h.st.requestId}`)).json?.request;
    h.step('after assign', { status: r?.status, owner: r?.owner?.name || r?.ownerName });
    await h.shot('06-request-assigned');
  },
  async probeCandidate(h) {
    await h.loginUI('recruiter@arabtec.com');
    await h.open('cvIntake'); await h.shot('07-cv-inbox');
    await h.open('candidates');
    await h.click('Add manually');
    await h.c.sleep(800);
    h.step('form', await h.c.ev(`const m = document.querySelector('.modal'); return { fields: [...m.querySelectorAll('.field')].map(f => (f.querySelector('label')?.textContent || '').trim() + ' <' + (f.querySelector('input,select,textarea')?.tagName || '') + '>'), buttons: [...m.querySelectorAll('button')].map(b => b.textContent.trim()) };`));
  },
  async candidate(h) {
    await h.loginUI('recruiter@arabtec.com');
    if (!h.st.candidateId) {
      await h.open('candidates');
      await h.click('Add manually');
      await h.type('Full Name', 'Omar Hassan (BOARD DEMO)', '.modal');
      await h.type('Email', 'omar.hassan.demo@example.com', '.modal');
      await h.type('Phone', '+201000009201', '.modal');
      await h.type('Location', 'Cairo', '.modal');
      await h.type('Current Company', 'Demo Contracting Co.', '.modal');
      await h.type('Current Position', 'Planning Engineer', '.modal');
      await h.type('Years of Experience', '7', '.modal');
      await h.shot('08-candidate-form');
      await h.click('Save', '.modal');
      await h.c.sleep(1500);
      const found = (await h.api('/api/candidates?q=Omar%20Hassan&pageSize=10')).json?.candidates || [];
      const cand = found.find((x) => /Omar Hassan \(BOARD DEMO\)/.test(x.fullName));
      if (!cand) throw new Error('candidate not created ' + JSON.stringify(found).slice(0, 200));
      h.st.candidateId = cand.id; h.save(); h.step('candidate created', { id: cand.id, no: cand.candidateNo });
    }
    await h.open(`candidates/${h.st.candidateId}`);
    await h.shot('09-candidate-profile');
    await h.open(`requests/${h.st.requestId}`);
    await h.click('Candidates');
    await h.click('Add Candidate');
    await h.c.sleep(800);
    h.step('link dialog', await h.c.ev(`const m = document.querySelector('.modal'); return m ? { fields: [...m.querySelectorAll('.field')].map(f => (f.querySelector('label')?.textContent || '').trim() + ' <' + (f.querySelector('input,select,textarea')?.tagName || '') + '> ' + (f.querySelector('select') ? [...f.querySelector('select').options].map(o => o.text).join('|').slice(0, 300) : '')), buttons: [...m.querySelectorAll('button')].map(b => b.textContent.trim()) } : null;`));
  },
  async link(h) {
    await h.loginUI('recruiter@arabtec.com');
    await h.open(`requests/${h.st.requestId}`);
    await h.click('Candidates');
    if (!h.st.applicationId) {
      await h.click('Add Candidate');
      await h.choose('Candidate', 'Omar Hassan (BOARD DEMO)', '.modal');
      await h.choose('Initial Status', 'Sourced', '.modal');
      await h.click('Link', '.modal');
      await h.c.sleep(1500);
      const apps = (await h.api(`/api/candidates/${h.st.candidateId}`)).json?.candidate?.applications || [];
      const a = apps.find((x) => x.requestId === h.st.requestId);
      if (!a) throw new Error('not linked ' + JSON.stringify(apps).slice(0, 200));
      h.st.applicationId = a.id; h.save(); h.step('linked', { applicationId: a.id, status: a.status });
    }
    await h.shot('10-pipeline-linked');
    h.step('pipeline controls', await h.c.ev(`return [...document.querySelectorAll('button,select')].filter(e => e.offsetParent !== null).map(e => e.tagName === 'SELECT' ? 'SELECT:' + (e.getAttribute('aria-label') || '') + ':' + [...e.options].map(o => o.text).join('|').slice(0, 200) : (e.getAttribute('aria-label') || e.textContent.trim())).filter(Boolean).slice(-40);`));
  },
  async probeMove(h) {
    await h.loginUI('recruiter@arabtec.com');
    await h.open(`requests/${h.st.requestId}`);
    await h.click('Candidates');
    await h.clickSel('[aria-label="Actions for Omar Hassan (BOARD DEMO)"]', 'actions menu');
    await h.c.sleep(500);
    h.step('menu', await h.c.ev(`return [...document.querySelectorAll('[role=menu] *, .menu button, .dropdown button, [role=menuitem]')].filter(e => e.offsetParent !== null).map(e => e.textContent.trim()).filter(Boolean).slice(0, 30);`));
    await h.shot('probe-menu');
  },
  async pipeline(h) {
    await h.loginUI('recruiter@arabtec.com');
    await h.open(`requests/${h.st.requestId}`);
    await h.click('Candidates');
    const menu = async (item) => {
      await h.clickSel('[aria-label="Actions for Omar Hassan (BOARD DEMO)"]', 'actions menu');
      await h.click(item, 'document', { tags: 'button,[role=menuitem]' });
      await h.c.sleep(700);
      const m = await h.c.ev(`const m = document.querySelector('.modal'); return m ? { text: m.textContent.slice(0, 200), buttons: [...m.querySelectorAll('button')].map(b => b.textContent.trim()) } : null;`);
      return m;
    };
    const status = async () => (await h.api(`/api/applications/${h.st.applicationId}`)).json?.application?.status;
    for (const [item, want] of [['Move to Screening', 'screening'], ['Move to Interview', 'interview']]) {
      if ((await status() || '').startsWith(want)) continue;
      const m = await menu(item);
      if (m) { h.step('move dialog', m); const ok = m.buttons.find((t) => /^(Move|Confirm|Save)/.test(t)); if (ok) await h.click(ok, '.modal'); }
      await h.c.sleep(1000);
      h.step(`after ${item}`, { status: await status() });
    }
    await h.shot('11-pipeline-interview');
    const m = await menu('Schedule Interview');
    h.step('schedule dialog', await h.c.ev(`const m = document.querySelector('.modal'); return m ? { fields: [...m.querySelectorAll('.field')].map(f => (f.querySelector('label')?.textContent || '').trim() + ' <' + (f.querySelector('input,select,textarea')?.type || '') + '> ' + (f.querySelector('select') ? [...f.querySelector('select').options].map(o => o.text).join('|').slice(0, 200) : '')), buttons: [...m.querySelectorAll('button')].map(b => b.textContent.trim()), checks: [...m.querySelectorAll('input[type=checkbox]')].map(c => c.closest('label')?.textContent.trim()).slice(0, 20) } : null;`));
  },
  async schedule(h) {
    await h.loginUI('recruiter@arabtec.com');
    if (!h.st.interviewId) {
      await h.open(`requests/${h.st.requestId}`);
      await h.click('Candidates');
      await h.clickSel('[aria-label="Actions for Omar Hassan (BOARD DEMO)"]', 'actions menu');
      await h.click('Schedule Interview', 'document', { tags: 'button,[role=menuitem]' });
      await h.c.sleep(800);
      await h.choose('Type', 'technical', '.modal');
      await h.choose('Mode', 'video', '.modal');
      // datetime-local takes a value, not keystrokes: set it the way React listens.
      await h.c.ev(`const i = document.querySelector('.modal input[type=datetime-local]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, '2026-10-05T10:00'); i.dispatchEvent(new Event('input', { bubbles: true })); return 1;`);
      h.step('set Date & Time = 2026-10-05 10:00 (local)');
      await h.type('Duration (min)', '60', '.modal');
      await h.type('Google Meet link', 'https://meet.google.com/board-demo-0001', '.modal');
      await h.click('Mona Sami', '.modal', { tags: 'span.tag-toggle' });
      await h.c.sleep(1200); // clash check runs
      await h.shot('12-schedule-dialog');
      await h.click('Schedule', '.modal');
      await h.c.sleep(1500);
      const ivs = (await h.api(`/api/interviews/application/${h.st.applicationId}`)).json?.interviews || [];
      if (!ivs.length) throw new Error('no interview created');
      h.st.interviewId = ivs[0].id; h.st.interviewNo = ivs[0].interviewNo; h.save();
      h.step('scheduled', { id: ivs[0].id, no: ivs[0].interviewNo, scheduledAt: ivs[0].scheduledAt, durationMin: ivs[0].durationMin, status: ivs[0].status });
    }
    await h.open('interviews');
    await h.c.sleep(800);
    await h.shot('13-interviews-calendar');
    await h.open(`interviews/${h.st.interviewId}`);
    await h.shot('14-interview-detail');
  },
  async assess(h) {
    await h.loginUI('interviewer@arabtec.com');
    await h.open(`interviews/${h.st.interviewId}`);
    await h.shot('15-interviewer-view');
    await h.click('Open assessment');
    await h.c.ev(`await until(() => document.querySelector('.assess-doc')); return 1;`);
    await h.c.sleep(600);
    const edit = await h.c.ev(`return !!document.querySelector('[aria-label="Edit technical evaluation"]');`);
    if (edit) await h.clickSel('[aria-label="Edit technical evaluation"]', 'Edit technical evaluation');
    const groups = await h.c.ev(`const sec = [...document.querySelectorAll('.assess-sec')].find(s => s.textContent.startsWith('Technical Assessment'));
      return [...sec.querySelectorAll('[role=radiogroup]')].map(g => g.getAttribute('aria-label')).filter(l => / score$/.test(l));`);
    h.step('technical criteria', { groups });
    for (const [i, g] of groups.entries()) {
      const pick = i === 0 ? '5 — Excellent' : i === 3 ? '3 — Average' : '4 — Proficient';
      await h.clickSel(`[role=radiogroup][aria-label="${g}"] [aria-label="${pick}"]`, `${g} = ${pick}`);
    }
    const crit0 = groups[0].replace(/ score$/, '');
    await h.clickSel(`textarea[aria-label="${crit0} notes"]`, `${crit0} notes`);
    await h.c.send('Input.insertText', { text: 'Clear baseline/update logic in Primavera P6; explained critical-path recovery on a past project.' });
    await h.c.ev(`const s = document.querySelector('select[aria-label="Technical recommendation"]'); const o = [...s.options].find(o => /^proceed$/i.test(o.value)) || [...s.options].find(o => o.value);
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, o.value); s.dispatchEvent(new Event('change', { bubbles: true })); return o.text;`).then((t) => h.step('Technical recommendation = ' + t));
    const just = await h.c.ev(`const t = [...document.querySelectorAll('textarea')].find(t => /technical/i.test(t.getAttribute('aria-label') || '') && /justification/i.test(t.getAttribute('aria-label') || '')); return t ? t.getAttribute('aria-label') : null;`);
    if (just) { await h.clickSel(`textarea[aria-label="${just}"]`, just); await h.c.send('Input.insertText', { text: 'Strong planning fundamentals; ready for a site role with light supervision.' }); }
    else h.step('no technical justification box visible');
    await h.shot('16-technical-draft');
    await h.clickSel('[aria-label="Submit technical evaluation"]', 'Submit technical evaluation');
    await h.c.sleep(1500);
    const b = (await h.api(`/api/assessments/application/${h.st.applicationId}`)).json?.assessment;
    h.step('after submit', { technical: b?.technical?.status, fit: b?.technical?.computedFit, salaryVisible: JSON.stringify(b || {}).includes('expectedSalary') });
    if (b?.technical?.status !== 'submitted') throw new Error('technical not submitted: ' + JSON.stringify(b?.technical).slice(0, 200));
    await h.shot('17-technical-submitted');
  },
  // Interviewer edits the submitted evaluation to add the justification (AR-02: stays submitted).
  async assess2(h) {
    await h.loginUI('interviewer@arabtec.com');
    await h.open(`interviews/${h.st.interviewId}`);
    await h.click('Open assessment');
    await h.c.ev(`await until(() => document.querySelector('.assess-doc')); return 1;`); await h.c.sleep(600);
    await h.clickSel('[aria-label="Edit technical evaluation"]', 'Edit technical evaluation');
    const jid = `assess-${h.st.applicationId}-technical-just`;
    await h.clickSel(`textarea#${jid}`, 'technical justification');
    await h.c.send('Input.insertText', { text: 'Strong planning fundamentals; ready for a site role with light supervision.' });
    await h.clickSel('[aria-label="Submit technical evaluation"]', 'Submit technical evaluation');
    await h.c.sleep(1500);
    const t = (await h.api(`/api/assessments/application/${h.st.applicationId}`)).json?.assessment?.technical;
    h.step('after edit', { status: t?.status, justification: t?.justification });
    if (t?.status !== 'submitted' || !t?.justification) throw new Error('edit not saved ' + JSON.stringify(t).slice(0, 200));
    await h.shot('17-technical-submitted');
  },
  // HR Manager: HR (behavioral) evaluation + final decision.
  async hr(h) {
    await h.loginUI('hr.manager@arabtec.com');
    await h.open(`interviews/${h.st.interviewId}`);
    await h.click('Open assessment');
    await h.c.ev(`await until(() => document.querySelector('.assess-doc')); return 1;`); await h.c.sleep(600);
    if (await h.c.ev(`return !!document.querySelector('[aria-label="Edit behavioral evaluation"]');`)) await h.clickSel('[aria-label="Edit behavioral evaluation"]', 'Edit behavioral evaluation');
    const groups = await h.c.ev(`const sec = [...document.querySelectorAll('.assess-sec')].find(s => s.textContent.startsWith('HR Assessment'));
      return [...sec.querySelectorAll('[role=radiogroup]')].map(g => g.getAttribute('aria-label')).filter(l => / score$/.test(l));`);
    h.step('behavioral criteria', { groups });
    for (const [i, g] of groups.entries()) await h.clickSel(`[role=radiogroup][aria-label="${g}"] [aria-label="${i === 1 ? '5 — Excellent' : '4 — Proficient'}"]`, `${g}`);
    await h.c.ev(`const s = document.querySelector('select[aria-label="Behavioral recommendation"]'); const o = [...s.options].find(o => /^proceed$/i.test(o.value)) || [...s.options].find(o => o.value);
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, o.value); s.dispatchEvent(new Event('change', { bubbles: true })); return o.text;`).then((t) => h.step('Behavioral recommendation = ' + t));
    await h.clickSel(`textarea#assess-${h.st.applicationId}-hr-just`, 'behavioral justification');
    await h.c.send('Input.insertText', { text: 'Calm, structured communicator; owns mistakes; strong team coordination.' });
    await h.shot('18-hr-draft');
    await h.clickSel('[aria-label="Submit behavioral evaluation"]', 'Submit behavioral evaluation');
    await h.c.sleep(1500);
    let b = (await h.api(`/api/assessments/application/${h.st.applicationId}`)).json?.assessment;
    h.step('after HR submit', { hr: b?.hr?.status, technical: b?.technical?.status, hrFit: b?.hr?.computedFit });
    if (b?.hr?.status !== 'submitted') throw new Error('hr not submitted ' + JSON.stringify(b?.hr).slice(0, 200));
    const choice = await h.c.ev(`const g = document.querySelector('[role=radiogroup][aria-label="Final decision"]'); return g ? [...g.querySelectorAll('label')].map(l => l.textContent.trim()) : null;`);
    h.step('final decision choices', { choice });
    const pick = choice.find((t) => /^Proceed/.test(t)) || choice[0];
    await h.click(pick, '.assess-doc', { tags: 'label' });
    await h.clickSel(`textarea#assess-${h.st.applicationId}-final-notes`, 'decision notes');
    await h.c.send('Input.insertText', { text: 'Panel agrees: proceed to offer.' });
    await h.click('Record Final Decision', '.assess-doc');
    await h.c.sleep(1500);
    b = (await h.api(`/api/assessments/application/${h.st.applicationId}`)).json?.assessment;
    h.step('after decision', { decision: b?.finalDecision?.decision, by: b?.finalDecision?.decidedByName });
    if (!b?.finalDecision?.decision) throw new Error('no final decision');
    await h.shot('19-final-decision');
  },
  async probeOffer(h) {
    await h.loginUI('hr.manager@arabtec.com');
    await h.open(`interviews/${h.st.interviewId}`);
    h.step('interview buttons', await h.c.ev(`return [...document.querySelectorAll('main button, .modal button, .drawer button')].filter(b => b.offsetParent !== null).map(b => b.getAttribute('aria-label') || b.textContent.trim()).filter(Boolean).slice(0, 30);`));
    await h.open(`requests/${h.st.requestId}`);
    await h.click('Candidates');
    await h.clickSel('[aria-label="Actions for Omar Hassan (BOARD DEMO)"]', 'actions menu');
    await h.click('Generate Offer', 'document', { tags: 'button,[role=menuitem]' });
    await h.c.sleep(900);
    h.step('offer form', await h.c.ev(`const m = document.querySelector('.modal'); return m ? { title: m.querySelector('h2,h3,.modal-title')?.textContent, fields: [...m.querySelectorAll('.field')].map(f => (f.querySelector('label')?.textContent || '').trim() + ' <' + (f.querySelector('input,select,textarea')?.type || '') + '>'), buttons: [...m.querySelectorAll('button')].map(b => b.textContent.trim()) } : null;`));
  },
  async offer(h) {
    const setDate = (label, v) => h.c.ev(`const f = [...document.querySelectorAll('.modal .field')].find(f => (f.querySelector('label')?.textContent || '').trim().replace(/ \\*$/, '') === ${JSON.stringify(label)}); const i = f.querySelector('input');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, ${JSON.stringify(v)}); i.dispatchEvent(new Event('input', { bubbles: true })); return i.value;`).then((x) => h.step(`set ${label} = ${x}`));
    const modalButtons = () => h.c.ev(`const m = document.querySelector('.modal'); return m ? [...m.querySelectorAll('button')].map(b => b.textContent.trim()).filter(Boolean) : null;`);
    await h.loginUI('hr.manager@arabtec.com');
    const iv = (await h.api(`/api/interviews/${h.st.interviewId}`)).json?.interview;
    if (iv?.status !== 'completed') {
      await h.open(`interviews/${h.st.interviewId}`);
      await h.click('Mark Completed');
      await h.c.sleep(700);
      const mb = await modalButtons(); h.step('complete dialog', { mb });
      if (mb) await h.click(mb.find((t) => /Complete|Confirm|Save|Mark/.test(t)) || mb[mb.length - 1], '.modal');
      await h.c.sleep(1200);
      h.step('interview status', { status: (await h.api(`/api/interviews/${h.st.interviewId}`)).json?.interview?.status });
    }
    if (!h.st.offerId) {
      await h.open(`requests/${h.st.requestId}`);
      await h.click('Candidates');
      await h.clickSel('[aria-label="Actions for Omar Hassan (BOARD DEMO)"]', 'actions menu');
      await h.click('Generate Offer', 'document', { tags: 'button,[role=menuitem]' });
      await h.c.sleep(900);
      await h.type('Salary Offered', '42000', '.modal');
      await setDate('Joining Date', '2026-11-01');
      await setDate('Offer expiry', '2026-10-20');
      await h.type('Benefits', 'Housing and transport allowance', '.modal');
      await h.type('Notes', 'BOARD DEMO offer — synthetic data.', '.modal');
      await h.shot('20-offer-form');
      await h.click('Create Offer', '.modal');
      await h.c.sleep(1500);
      const offers = (await h.api('/api/offers')).json?.offers || [];
      const o = offers.find((x) => x.applicationId === h.st.applicationId);
      if (!o) throw new Error('offer not created ' + JSON.stringify(offers).slice(0, 200));
      h.st.offerId = o.id; h.st.offerNo = o.offerNo; h.save(); h.step('offer created', { id: o.id, no: o.offerNo, status: o.status, salary: o.salaryOffered });
    }
    await h.open(`offers/${h.st.offerId}`);
    let o = (await h.api(`/api/offers/${h.st.offerId}`)).json?.offer;
    if (o?.status === 'draft') {
      await h.click('Submit for approval');
      await h.c.sleep(700); const mb = await modalButtons(); if (mb) { h.step('submit dialog', { mb }); await h.click(mb.find((t) => /Submit|Confirm/.test(t)) || mb[mb.length - 1], '.modal'); }
      await h.c.sleep(1200);
      o = (await h.api(`/api/offers/${h.st.offerId}`)).json?.offer; h.step('after offer submit', { status: o?.status });
    }
    await h.shot('21-offer-submitted');
    await h.loginUI('hr.director@arabtec.com');
    await h.open(`offers/${h.st.offerId}`);
    o = (await h.api(`/api/offers/${h.st.offerId}`)).json?.offer;
    if (/pending/.test(o?.status || '')) {
      await h.click('Approve');
      await h.c.sleep(700); const mb = await modalButtons(); if (mb) { h.step('approve dialog', { mb }); await h.click(mb.find((t) => /^Approve/.test(t)) || mb[mb.length - 1], '.modal'); }
      await h.c.sleep(1200);
      o = (await h.api(`/api/offers/${h.st.offerId}`)).json?.offer; h.step('after offer approve', { status: o?.status });
    }
    await h.shot('22-offer-approved');
    await h.loginUI('hr.manager@arabtec.com');
    await h.open('reports'); await h.c.sleep(1200); await h.shot('23-reports');
    await h.open('dashboard'); await h.c.sleep(1200); await h.shot('24-dashboard-after');
  },
  // Scheduler: intentional overlap is warned (not blocked); a double-click creates one interview; cancel works.
  async dupe(h) {
    await h.loginUI('recruiter@arabtec.com');
    const bgReq = ((await h.api('/api/requests?pageSize=50')).json?.requests || []).find((r) => /Quantity Surveyor \(BOARD DEMO\)/.test(r.title || ''));
    const youssef = ((await h.api('/api/candidates?q=Youssef&pageSize=10')).json?.candidates || [])[0];
    const appId = ((await h.api(`/api/candidates/${youssef.id}`)).json?.candidate?.applications || []).find((a) => a.requestId === bgReq.id)?.id;
    const count = async () => ((await h.api(`/api/interviews/application/${appId}`)).json?.interviews || []).length;
    const before = await count();
    await h.open(`requests/${bgReq.id}`);
    await h.click('Candidates');
    await h.clickSel('[aria-label="Actions for Youssef Kamal (BOARD DEMO)"]', 'actions menu');
    await h.click('Schedule Interview', 'document', { tags: 'button,[role=menuitem]' });
    await h.c.sleep(800);
    await h.choose('Type', 'technical', '.modal');
    await h.c.ev(`const i = document.querySelector('.modal input[type=datetime-local]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, '2026-10-05T10:30'); i.dispatchEvent(new Event('input', { bubbles: true })); return 1;`);
    await h.click('Mona Sami', '.modal', { tags: 'span.tag-toggle' });
    await h.c.sleep(1800); // clash lookup
    const warning = await h.c.ev(`return [...document.querySelectorAll('.modal .assess-warn, .modal [role=alert], .modal .warn, .modal .alert, .modal p, .modal div')].map(e => e.textContent.trim()).find(t => /overlap|already booked|clash|busy/i.test(t) && t.length < 400) || null;`);
    h.step('overlap warning shown', { warning });
    await h.shot('25-overlap-warning');
    const enabled = await h.c.ev(`return ![...document.querySelectorAll('.modal button')].find(b => b.textContent.trim() === 'Schedule').disabled;`);
    h.step('Schedule still enabled despite overlap', { enabled });
    // Double-click: two trusted clicks with no pause between them.
    const p = await h.center(`[...document.querySelectorAll('.modal button')].find(b => b.textContent.trim() === 'Schedule')`);
    for (const n of [1, 2]) for (const type of ['mousePressed', 'mouseReleased']) await h.c.send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', clickCount: n });
    await h.c.sleep(2000);
    const after = await count();
    h.step('double-click result', { before, after, created: after - before });
    if (after - before !== 1) throw new Error(`double-click created ${after - before} interviews`);
    const iv = ((await h.api(`/api/interviews/application/${appId}`)).json?.interviews || [])[0];
    await h.open(`interviews/${iv.id}`);
    await h.click('Cancel', 'main');
    await h.c.sleep(700);
    const mb = await h.c.ev(`const m = document.querySelector('.modal'); return m ? { text: m.textContent.slice(0, 200), buttons: [...m.querySelectorAll('button')].map(b => b.textContent.trim()).filter(Boolean), fields: [...m.querySelectorAll('.field label')].map(l => l.textContent.trim()) } : null;`);
    h.step('cancel dialog', mb);
    if (mb) {
      if (mb.fields.some((f) => /reason/i.test(f))) await h.type(mb.fields.find((f) => /reason/i.test(f)).replace(/ \*$/, ''), 'Demo: overlap test slot released', '.modal').catch(() => {});
      await h.click(mb.buttons.find((t) => /Cancel interview|Confirm|Yes/i.test(t)) || mb.buttons[mb.buttons.length - 1], '.modal');
    }
    await h.c.sleep(1200);
    h.step('after cancel', { status: (await h.api(`/api/interviews/${iv.id}`)).json?.interview?.status });
    await h.shot('26-interview-cancelled');
  },
};
