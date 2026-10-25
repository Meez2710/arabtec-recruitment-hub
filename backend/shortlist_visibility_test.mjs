// AR-01 — candidate visibility follows assignment scope.
// A user without broad visibility (Technical Interviewer, Hiring Manager,
// Project Manager) may see only candidates on hiring requests they requested,
// own or created, or in interviews they organise or sit on — and, for those,
// only the request/application metadata that is itself in scope. HR,
// recruitment and full-view roles keep the whole Talent Pool. Real HTTP routes,
// disposable SQLite database.
import { suiteDatabaseUrl } from './test-support/suite-db.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'arabtec-shortlist-'));
process.env.DATABASE_URL = suiteDatabaseUrl('file:' + path.join(TMP, 'scope.db'));
process.env.UPLOAD_DIR = path.join(TMP, 'uploads');
process.env.PORT = process.env.CANDSCOPE_TEST_PORT || '4598';
process.env.SEED_DEMO_DATA ||= 'true';
process.env.SMTP_TRANSPORT = 'json';
const { ADMIN_BOOTSTRAP_PASSWORD } = await import('./test-support/admin-session.mjs');
process.env.SEED_ADMIN_PASSWORD ||= ADMIN_BOOTSTRAP_PASSWORD;
await import('./prisma/seed.js');
await import('./src/server.js');
const { waitForReady } = await import('./test-support/wait-ready.mjs');
const db = await import('./src/lib/db.js');
const { userContext } = await import('./src/lib/models.js');
const { createAnyhelpTools } = await import('./src/lib/ai/anyhelp.js');
const B = 'http://localhost:' + process.env.PORT;
await waitForReady(B);

let pass = 0, fail = 0;
const c = (n, ok, x = '') => { console.log((ok ? '  ✅ ' : '  ❌ ') + n + (ok ? '' : ' ' + x)); ok ? pass++ : fail++; };
async function api(p, { method = 'GET', token, body } = {}) {
  const r = await fetch(B + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch {}
  return { status: r.status, json: j, text };
}
const login = async (e) => (await api('/api/auth/login', { method: 'POST', body: { email: e, password: 'Arabtec@123' } })).json.token;


try {
  const { Candidates, Applications, StageHistory, Interviews, Posts } = await import('./src/lib/models.js');
  const { hasFullPipelineAccess, visibleStageHistory } = await import('./src/lib/pipeline-visibility.js');
  const { APP_PIPELINE } = await import('./src/lib/stages.js');
  const uid = (email) => db.get('SELECT id FROM users WHERE email=?', [email]).id;
  const hmId = uid('hiring.manager@arabtec.com'), monaId = uid('interviewer@arabtec.com'), recId = uid('recruiter@arabtec.com');
  const ins = (sql, params) => Number(db.run(sql, params).lastInsertRowid);
  const rid = ins("INSERT INTO recruitment_request(ticket_no,title,status,headcount,requester_id,owner_id,created_by) VALUES ('SL-REQ','Shortlist test','open',20,?,?,?)", [hmId,recId,hmId]);
  const other = ins("INSERT INTO recruitment_request(ticket_no,title,status,headcount,requester_id,owner_id,created_by) VALUES ('SL-OTHER','Other request','open',20,?,?,?)", [recId,recId,recId]);
  const fixture = (name,status,requestId=rid,released=false) => {
    const cand = Candidates.create({ candidateNo:Candidates.nextNo(),fullName:'SL '+name,createdBy:recId });
    db.run('INSERT INTO request_activity(request_id,type,note) VALUES (?,?,?)',[requestId,'candidate_linked','SL '+name+' linked']);
    const app = Applications.create({applicationNo:Applications.nextNo(),candidateId:cand.id,requestId,status,createdBy:recId});
    StageHistory.add(app.id,null,'sourced',{id:recId});
    if(released) StageHistory.add(app.id,'sourced','shortlisted',{id:recId});
    if(status!=='sourced' && status!=='shortlisted') StageHistory.add(app.id,released?'shortlisted':'sourced',status,{id:recId});
    const iv = Interviews.create({interviewNo:'SL-IV-'+app.id,applicationId:app.id,candidateId:cand.id,requestId,organizerId:monaId,interviewType:'technical',scheduledAt:'2026-11-15T10:00:00Z',createdBy:recId});
    db.run('INSERT INTO interview_panel(interview_id,interviewer_id) VALUES (?,?)',[iv.id,monaId]);
    Posts.system(requestId,'SL '+name,{applicationId:app.id,candidateId:cand.id,toStatus:status},{id:recId});
    return {cand,app,iv};
  };
  const sourced=fixture('PRIVATE sourced','sourced'), shortlisted=fixture('released shortlist','shortlisted',rid,true), screened=fixture('legacy screened','matched');
  const rejectedEarly=fixture('PRIVATE rejected','rejected'), rejectedLater=fixture('released rejected','rejected',rid,true), unrelated=fixture('other shortlist','shortlisted',other,true);
  const allFixtures=[sourced,shortlisted,screened,rejectedEarly,rejectedLater,unrelated];
  c('Shortlisted ordered between sourced and matched',APP_PIPELINE.indexOf('shortlisted')===APP_PIPELINE.indexOf('sourced')+1 && APP_PIPELINE.indexOf('matched')===APP_PIPELINE.indexOf('shortlisted')+1);
  for(const role of ['recruiter','recruitment_manager','hr_director','ceo','system_admin']) c(role+' full pipeline',hasFullPipelineAccess({roles:[role]}));
  for(const role of ['hiring_manager','technical_interviewer','viewer']) c(role+' restricted pipeline',!hasFullPipelineAccess({roles:[role],permissions:['request.view_all']}));
  c('hr_manager has the full pipeline (it links and moves candidates — audit F4, 25 Oct 2026)',hasFullPipelineAccess({roles:['hr_manager'],permissions:['request.view_all']}));
  const tokens={};
  for(const [key,email] of Object.entries({recruiter:'recruiter@arabtec.com',director:'hr.director@arabtec.com',manager:'rec.manager@arabtec.com',hm:'hiring.manager@arabtec.com',interviewer:'interviewer@arabtec.com',viewer:'viewer@arabtec.com',hr:'hr.manager@arabtec.com'})) tokens[key]=await login(email);
  // hr_manager left this list on 25 Oct 2026 (audit F4): it links and moves
  // candidates, so it is a full-pipeline role and may open sourced ones.
  for(const who of ['hm','interviewer','viewer']) {
    const token=tokens[who];
    for(const f of [sourced,rejectedEarly]) {
      const detail=await api('/api/candidates/'+f.cand.id,{token});
      c(who+' cannot open '+f.app.status,[403,404].includes(detail.status) && !detail.text.includes('PRIVATE'));
      c(who+' cannot open application '+f.app.status,[403,404].includes((await api('/api/applications/'+f.app.id,{token})).status));
      c(who+' cannot open linked interview '+f.app.status,[403,404].includes((await api('/api/interviews/'+f.iv.id,{token})).status));
      c(who+' cannot open assessment '+f.app.status,[403,404].includes((await api('/api/assessments/application/'+f.app.id,{token})).status));
    }
    for(const f of [shortlisted,screened,rejectedLater]) c(who+' sees '+f.app.status,(await api('/api/candidates/'+f.cand.id,{token})).status===200);
    const list=await api('/api/applications?pageSize=100',{token});
    c(who+' application list excludes sourcing',list.status===200 && !list.text.includes('PRIVATE'));
    const board=await api('/api/applications/request/'+rid,{token});
    c(who+' request board excludes sourcing',board.status===200 && !board.text.includes('PRIVATE') && !board.json.statuses?.includes('sourced'));
    const requestDetail=await api('/api/requests/'+rid,{token});
    c(who+' request activity excludes private linkage',[200,403,404].includes(requestDetail.status) && !requestDetail.text.includes('PRIVATE'));
    const thread=await api('/api/thread/request/'+rid,{token});
    c(who+' thread excludes unreleased candidates',thread.status===200 && !thread.text.includes('PRIVATE'));
    const detail=await api('/api/applications/'+shortlisted.app.id,{token});
    c(who+' history begins at shortlist',detail.status===200 && detail.json.history.length===1 && detail.json.history[0].to_status==='shortlisted' && detail.json.history[0].from_status===null);
  }
  c('Hiring manager cannot see another request shortlist',[403,404].includes((await api('/api/candidates/'+unrelated.cand.id,{token:tokens.hm})).status));
  // Exercise the actual linking default, including deliberately enabled stakeholder notifications.
  db.run("UPDATE notification_config SET enabled=1,in_app=1,email=0,recipients=? WHERE event_key='candidate.application_received'",[JSON.stringify(['requester','hiring_manager','panel','approvers'])]);
  const noticesBefore=db.get('SELECT COUNT(*) AS n FROM notification').n;
  const privateCand=Candidates.create({candidateNo:Candidates.nextNo(),fullName:'PRIVATE newly linked',createdBy:recId});
  const linked=await api('/api/applications',{method:'POST',token:tokens.recruiter,body:{candidateId:privateCand.id,requestId:rid}});
  c('Linking defaults to private Sourcing',linked.status===201 && linked.json.application.status==='sourced',linked.text);
  c('Private linking sends no stakeholder notifications',db.get('SELECT COUNT(*) AS n FROM notification').n===noticesBefore);
  c('Hiring manager cannot open newly linked candidate',[403,404].includes((await api('/api/candidates/'+privateCand.id,{token:tokens.hm})).status));
  c('Actual linking is absent from stakeholder activity',!(await api('/api/requests/'+rid,{token:tokens.hm})).text.includes('PRIVATE'));
  for(const who of ['recruiter','director','manager']) {
    for(const f of allFixtures) c(who+' sees '+f.cand.full_name,(await api('/api/candidates/'+f.cand.id,{token:tokens[who]})).status===200);
  }
  // CEO is an explicit role, not an alias for Viewer or System Admin.
  const ceoRole=db.get("SELECT id FROM role WHERE code='ceo'");
  c('CEO role is available',!!ceoRole);
  db.run('INSERT INTO user_role(user_id,role_id) VALUES (?,?)',[uid('viewer@arabtec.com'),ceoRole.id]);
  c('CEO sees sourced candidates through API',(await api('/api/candidates/'+sourced.cand.id,{token:tokens.viewer})).status===200);
  const moved=await api('/api/applications/'+sourced.app.id+'/move',{method:'POST',token:tokens.recruiter,body:{status:'shortlisted'}});
  c('Recruiter moves sourcing to shortlisted',moved.status===200 && moved.json.application.status==='shortlisted',moved.text);
  c('Shortlisted status persisted',Applications.byId(sourced.app.id).status==='shortlisted');
  c('Hiring manager sees candidate immediately after release',(await api('/api/candidates/'+sourced.cand.id,{token:tokens.hm})).status===200);
  const screening=await api('/api/applications/'+sourced.app.id+'/move',{method:'POST',token:tokens.recruiter,body:{status:'matched'}});
  c('Recruiter advances shortlisted to screening',screening.status===200 && Applications.byId(sourced.app.id).status==='matched');
  c('Full history preserved for recruitment',visibleStageHistory({roles:['recruiter']},StageHistory.forApplication(sourced.app.id)).some(h=>h.to_status==='sourced'));
} catch(e) {console.error(e);fail++;}
finally {console.log(`\n=== SHORTLIST VISIBILITY: ${pass} passed, ${fail} failed ===`);try{fs.rmSync(TMP,{recursive:true,force:true});}catch{}process.exit(fail?1:0);}
