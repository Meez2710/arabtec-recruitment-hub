// Single-record candidate deletion: authorization, cascade acknowledgement, audit
// and one-time Recruitment Manager grant. Uses only disposable synthetic data.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { suiteDatabaseUrl } from './test-support/suite-db.mjs';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arabtec-candidate-delete-'));
process.env.DATABASE_URL = suiteDatabaseUrl('file:' + path.join(tmp, 'candidate-delete.db'));
process.env.UPLOAD_DIR = path.join(tmp, 'uploads');
process.env.PORT = process.env.CAND_DELETE_TEST_PORT || '4548';
process.env.SEED_DEMO_DATA = 'true';
process.env.SMTP_TRANSPORT = 'json';
const { adminToken, ADMIN_BOOTSTRAP_PASSWORD } = await import('./test-support/admin-session.mjs');
process.env.SEED_ADMIN_PASSWORD ||= ADMIN_BOOTSTRAP_PASSWORD;
const { seed } = await import('./prisma/seed.js');
await seed({ demo: true });
await import('./src/server.js');
const { waitForReady } = await import('./test-support/wait-ready.mjs');
const B = 'http://127.0.0.1:' + process.env.PORT;
await waitForReady(B);
const db = await import('./src/lib/db.js');
const { ensureSchema } = await import('./src/lib/schema.js');

async function api(p,{method='GET',token,body}={}) {
 const r=await fetch(B+p,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:body===undefined?undefined:JSON.stringify(body)});
 let json;try{json=await r.json()}catch{}
 return {status:r.status,json};
}
async function login(email) {
 const r=await api('/api/auth/login',{method:'POST',body:{email,password:'Arabtec@123'}});
 assert.equal(r.status,200,email+' can log in');
 return r.json.token;
}
const admin=await adminToken(B);
const manager=await login('rec.manager@arabtec.com');
const hrManager=await login('hr.manager@arabtec.com');
const recruiter=await login('recruiter@arabtec.com');
const roleId=(code)=>db.get('SELECT id FROM role WHERE code=?',[code]).id;
const permId=(code)=>db.get('SELECT id FROM permission WHERE code=?',[code]).id;
const has=(role)=>!!db.get('SELECT 1 AS x FROM role_permission WHERE role_id=? AND permission_id=?',[roleId(role),permId('candidate.delete')]);

try {
 assert.equal(has('system_admin'),true,'admin has deletion grant');
 assert.equal(has('recruitment_manager'),true,'manager has deletion grant after fresh seed');
 assert.equal(has('hr_manager'),false,'HR manager must not receive deletion');
 assert.equal(has('recruiter'),false,'recruiter must not receive deletion');
 
 let idSeq=0;
 async function add() {
  idSeq++;
  const r=await api('/api/candidates',{method:'POST',token:recruiter,body:{fullName:'Synthetic Deletion Probe '+idSeq,email:'delete.probe.'+idSeq+'@example.invalid'}});
  assert.equal(r.status,201,JSON.stringify(r.json));
  return r.json.candidate.id;
 }
 const victim=await add();
 const survivor=await add();
 for (const [role,token] of [['recruiter',recruiter],['hr_manager',hrManager]]) {
  assert.equal((await api('/api/candidates/'+victim+'/delete-impact',{token})).status,403,role+' cannot preview deletion');
  assert.equal((await api('/api/candidates/'+victim,{token,method:'DELETE',body:{reason:'test'}})).status,403,role+' cannot delete');
 }
 assert.equal((await api('/api/candidates/'+victim+'/delete-impact',{token:admin})).status,200,'administrator previews impact');
 assert.equal((await api('/api/candidates/'+victim+'/delete-impact',{token:manager})).status,200,'recruitment manager previews impact');
 assert.equal((await api('/api/candidates/'+victim,{token:manager,method:'DELETE',body:{}})).status,400,'deletion requires reason');
 const noLinks=await api('/api/candidates/'+victim,{token:manager,method:'DELETE',body:{reason:'Synthetic test candidate'}});
 assert.equal(noLinks.status,200,'recruitment manager deletes unlinked candidate');
 assert.equal(db.get('SELECT id FROM candidate WHERE id=?',[victim]),undefined,'deleted candidate row gone');
 assert.equal((await api('/api/candidates/'+victim,{token:admin})).status,403,'scope guard does not expose removed candidate');
 assert.equal((await api('/api/candidates/'+survivor,{token:admin})).status,200,'unrelated candidate survives');
 const aud=db.get("SELECT action, comments FROM audit_log WHERE action='candidate.deleted' AND entity_id=?",[String(victim)]);
 assert.equal(aud?.comments,'Synthetic test candidate','deletion retains audit reason');
 
 const linked=await add();
 const meta=await api('/api/requests/meta/form',{token:hrManager});
 const request=await api('/api/requests',{method:'POST',token:hrManager,body:{title:'Synthetic deletion request',justification:'new_hire',projectId:meta.json.projects[0].id,departmentId:meta.json.departments[0].id,location:'Cairo',headcount:2,priority:'high'}});
 assert.equal(request.status,201,JSON.stringify(request.json));
 const reqId=request.json.request.id;
 const app=await api('/api/applications',{method:'POST',token:recruiter,body:{candidateId:linked,requestId:reqId,initialStatus:'sourced'}});
 assert.equal(app.status,201,JSON.stringify(app.json));
 const impact=await api('/api/candidates/'+linked+'/delete-impact',{token:manager});
 assert.equal(impact.status,200);
 assert.equal(impact.json.cascaded.applications,1,'candidate deletion previews linked application');
 assert.equal((await api('/api/candidates/'+linked,{token:manager,method:'DELETE',body:{reason:'Synthetic test candidate'}})).status,409,'must acknowledge deleting applications');
 const yes=await api('/api/candidates/'+linked,{token:manager,method:'DELETE',body:{reason:'Synthetic linked candidate deletion',acknowledgeCascade:true}});
 assert.equal(yes.status,200,JSON.stringify(yes.json));
 assert.equal((await api('/api/candidates/'+survivor,{token:admin})).status,200,'unrelated candidate still survives');
 assert.equal((await api('/api/requests/'+reqId,{token:admin})).status,200,'hiring request survives candidate deletion');
 
 // Runtime policy must work for an already-seeded database without repeatedly
 // overriding an administrator's subsequent Roles & Permissions revocation.
 assert.ok(db.get("SELECT 1 FROM system_setting WHERE key='policy_candidate_delete_v1'"),'initial migration marker exists');
 db.run("DELETE FROM system_setting WHERE key='policy_candidate_delete_v1'");
 db.run('DELETE FROM role_permission WHERE role_id=? AND permission_id=?',[roleId('recruitment_manager'),permId('candidate.delete')]);
 ensureSchema();
 assert.equal(has('recruitment_manager'),true,'one-time existing database grant applied');
 db.run('DELETE FROM role_permission WHERE role_id=? AND permission_id=?',[roleId('recruitment_manager'),permId('candidate.delete')]);
 ensureSchema();
 assert.equal(has('recruitment_manager'),false,'revocation survives next restart');
 // Even if someone grants delete to another role, the endpoint refuses
 // because only system admin and Recruitment Manager are allowed.
 db.run('INSERT OR IGNORE INTO role_permission (role_id,permission_id) VALUES (?,?)',[roleId('recruiter'),permId('candidate.delete')]);
 const another=await add();
 assert.equal((await api('/api/candidates/'+another+'/delete-impact',{token:recruiter})).status,403,'other roles cannot preview even if granted');
 assert.equal((await api('/api/candidates/'+another,{token:recruiter,method:'DELETE',body:{reason:'test'}})).status,403,'other roles cannot delete even if granted');
 console.log('PASS: candidate deletion, restricted roles, explicit cascades and existing-db permission migration');
} catch (err) {
 console.error('FAIL: Candidate deletion test:', err);
 process.exitCode = 1;
} finally {
 try{fs.rmSync(tmp,{recursive:true,force:true})}catch{}
 process.exit(process.exitCode || 0);
}
