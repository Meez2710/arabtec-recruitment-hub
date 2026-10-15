// Disposable database only. Run with Node 22; optional PG_ENGINE=pglite.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'ats-detach-'));
process.env.DATABASE_URL=`file:${tmp}/test.db`;
process.env.UPLOAD_DIR=`${tmp}/uploads`;
process.env.SEED_DEMO_DATA='false';
process.env.SEED_ADMIN_PASSWORD='TestSeed#123456';
process.env.PORT=process.env.DETACH_TEST_PORT || '4297';
process.env.SMTP_TRANSPORT='json';
await (await import('./prisma/seed.js')).seed({demo:false});
const {all,get,run,exec,tx,driverKind}=await import('./src/lib/db.js');
const {migrateRequestDetachment,REQUEST_LINK_TABLES:tables}=await import('./src/lib/request-detachment.js');
const sqlite=driverKind()==='sqlite';
let passed=0;
const check=(name,condition)=>{assert.ok(condition,name);passed++;console.log('PASS '+name);};
const same=(name,a,b)=>{assert.deepEqual(JSON.parse(JSON.stringify(a)),JSON.parse(JSON.stringify(b)),name);passed++;console.log('PASS '+name);};
const ins=(sql,p=[])=>Number(run(sql,p).lastInsertRowid);
const admin=get('SELECT * FROM users WHERE email=?',['admin@arabtec.com']);
const request=ins("INSERT INTO recruitment_request(ticket_no,title,status) VALUES ('DETACH-1','Request to remove','open')");
const other=ins("INSERT INTO recruitment_request(ticket_no,title,status) VALUES ('DETACH-2','Keep request','closed')");
const candidate=ins("INSERT INTO candidate(candidate_no,full_name) VALUES ('DETACH-C','Preserved Candidate')");
const application=ins("INSERT INTO application(application_no,candidate_id,request_id,status) VALUES ('DETACH-A',?,?,'shortlisted')",[candidate,request]);
const interview=ins("INSERT INTO interview(interview_no,candidate_id,application_id,request_id) VALUES ('DETACH-I',?,?,?)",[candidate,application,request]);
const offer=ins("INSERT INTO offer(offer_no,candidate_id,application_id,request_id) VALUES ('DETACH-O',?,?,?)",[candidate,application,request]);
ins('INSERT INTO requisition_seat(request_id,seat_no) VALUES (?,1)',[request]);
ins("INSERT INTO request_approval(request_id,level,name) VALUES (?,1,'Approval')",[request]);
ins("INSERT INTO request_activity(request_id,type,note) VALUES (?,'created','Preserve history')",[request]);
const post=ins("INSERT INTO ticket_post(request_id,body,candidate_id,application_id) VALUES (?,'Keep thread',?,?)",[request,candidate,application]);
ins("INSERT INTO ticket_post(request_id,parent_post_id,body) VALUES (?,?,'Keep reply')",[request,post]);
ins("INSERT INTO ticket_post(request_id,body) VALUES (?,'Other request untouched')",[other]);
ins("INSERT INTO application_stage_history(application_id,to_status) VALUES (?,'shortlisted')",[application]);
run('INSERT INTO interview_panel(interview_id,interviewer_id) VALUES (?,?)',[interview,admin.id]);
ins("INSERT INTO interview_feedback(interview_id,interviewer_id,comments) VALUES (?,?,'Keep feedback')",[interview,admin.id]);
ins("INSERT INTO interview_activity(interview_id,type,note) VALUES (?,'created','Keep interview history')",[interview]);
ins("INSERT INTO offer_activity(offer_id,type,note) VALUES (?,'created','Keep offer history')",[offer]);
ins("INSERT INTO offer_approval(offer_id,level,name) VALUES (?,1,'Keep offer approval')",[offer]);
// Recreate the installed pre-migration request FKs on populated tables.
if(sqlite){
  exec('PRAGMA foreign_keys=OFF');
  tx(()=>{for(const table of tables){
    let ddl=get("SELECT sql FROM sqlite_master WHERE name=?",[table]).sql;
    ddl=ddl.replace(/^CREATE TABLE\s+(?:"[^"]+"|\w+)/i,`CREATE TABLE ${table}__old`);
    ddl=ddl.replace(/(request_id\s+INTEGER)(\s+REFERENCES recruitment_request\(id\) ON DELETE) SET NULL/i,'$1 NOT NULL$2 CASCADE');
    const objects=all("SELECT sql FROM sqlite_master WHERE tbl_name=? AND type IN ('index','trigger') AND sql IS NOT NULL",[table]);
    exec(ddl);exec(`INSERT INTO ${table}__old SELECT * FROM ${table}`);exec(`DROP TABLE ${table}`);exec(`ALTER TABLE ${table}__old RENAME TO ${table}`);
    for(const o of objects)exec(o.sql);
  }});
  exec('PRAGMA foreign_keys=ON');
  exec('CREATE TABLE migration_probe (value TEXT)');
  exec("CREATE TRIGGER preserve_activity_trigger AFTER INSERT ON request_activity BEGIN INSERT INTO migration_probe(value) VALUES ('inserted'); END");
  run("UPDATE sqlite_sequence SET seq=700 WHERE name='request_activity'");
}else{
  for(const table of tables){
    const fk=get("SELECT conname FROM pg_constraint WHERE contype='f' AND confrelid='recruitment_request'::regclass AND conrelid=?::regclass",[table]);
    exec(`ALTER TABLE ${table} DROP CONSTRAINT "${fk.conname}"`);exec(`ALTER TABLE ${table} ALTER COLUMN request_id SET NOT NULL`);exec(`ALTER TABLE ${table} ADD CONSTRAINT "${fk.conname}" FOREIGN KEY(request_id) REFERENCES recruitment_request(id) ON DELETE CASCADE`);
  }
}
const kept=['candidate',...tables,'application_stage_history','interview_panel','interview_feedback','interview_activity','offer_activity','offer_approval'];
const snapshot=()=>Object.fromEntries(kept.map(t=>[t,all(`SELECT * FROM ${t} ORDER BY ${t==='interview_panel'?'interview_id':'id'}`)]));
const before=snapshot();
// Unknown dependency refuses the migration without touching data.
exec('CREATE TABLE unknown_request_link(id INTEGER PRIMARY KEY,request_id INTEGER REFERENCES recruitment_request(id) ON DELETE CASCADE)');
assert.throws(()=>migrateRequestDetachment(),/Unexpected request dependency/);passed++;
same('refused migration preserves all records',snapshot(),before);
exec('DROP TABLE unknown_request_link');
migrateRequestDetachment();
same('populated migration preserves every record and ID',snapshot(),before);
migrateRequestDetachment();same('migration is idempotent',snapshot(),before);
for(const table of tables){
  if(sqlite){check(table+' SET NULL',all(`PRAGMA foreign_key_list(${table})`).some(f=>f.table==='recruitment_request'&&f.on_delete==='SET NULL'));check(table+' nullable',!all(`PRAGMA table_info(${table})`).find(c=>c.name==='request_id').notnull);}
  else {check(table+' SET NULL',get("SELECT confdeltype FROM pg_constraint WHERE contype='f' AND confrelid='recruitment_request'::regclass AND conrelid=?::regclass",[table]).confdeltype==='n');check(table+' nullable',get("SELECT is_nullable FROM information_schema.columns WHERE table_name=? AND column_name='request_id'",[table]).is_nullable==='YES');}
}
if(sqlite){check('foreign keys restored',get('PRAGMA foreign_keys').foreign_keys===1);check('foreign key check clean',all('PRAGMA foreign_key_check').length===0);check('sequence high-water retained',get("SELECT seq FROM sqlite_sequence WHERE name='request_activity'").seq===700);check('trigger retained',!!get("SELECT name FROM sqlite_master WHERE type='trigger' AND name='preserve_activity_trigger'"));}
// Authenticated HTTP erasure and rollback of failed audit.
const {Sessions}=await import('./src/lib/models.js');const {signToken}=await import('./src/lib/auth.js');
const token=signToken({sub:admin.id});run('UPDATE users SET must_change_password=0 WHERE id=?',[admin.id]);Sessions.create({id:randomUUID(),userId:admin.id,token,expiresAt:new Date(Date.now()+3600000).toISOString()});
await import('./src/server.js');const base=`http://127.0.0.1:${process.env.PORT}`;
const {waitForReady}=await import('./test-support/wait-ready.mjs');await waitForReady(base);
const api=async(p,method='GET',body)=>{const r=await fetch(base+'/api'+p,{method,headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:body?JSON.stringify(body):undefined});return {status:r.status,json:await r.json()};};
try{
  const impact=await api(`/requests/${request}/delete-impact`);check('impact describes preservation',impact.status===200&&impact.json.mode==='request_only'&&impact.json.detached.applications===1);
  check('reason required',(await api(`/requests/${request}`,'DELETE',{})).status===400);
  // Rename only within the disposable DB to force strict audit failure on both engines.
  exec('ALTER TABLE audit_log RENAME TO audit_log_unavailable');
  check('audit failure rejects deletion',(await api(`/requests/${request}`,'DELETE',{reason:'Test failure'})).status===500);
  check('failed audit preserves request',!!get('SELECT id FROM recruitment_request WHERE id=?',[request]));
  same('failed audit preserves linked data',snapshot(),before);
  exec('ALTER TABLE audit_log_unavailable RENAME TO audit_log');
  const deleted=await api(`/requests/${request}`,'DELETE',{reason:'Synthetic request-only test'});
  check('admin deletes request only',deleted.status===200&&deleted.json.deleted&&deleted.json.mode==='request_only');
  check('request row permanently absent',!get('SELECT id FROM recruitment_request WHERE id=?',[request]));
  const expected=structuredClone(before);for(const table of tables)for(const row of expected[table])if(row.request_id===request)row.request_id=null;
  same('every child retained with only request_id detached',snapshot(),expected);
  check('other request retained',!!get('SELECT id FROM recruitment_request WHERE id=?',[other]));
  check('request absent from screens',(await api('/requests')).json.requests.every(r=>r.id!==request));
  for(const p of [`/candidates/${candidate}`,`/applications/${application}`,`/interviews/${interview}`,`/offers/${offer}`])check('detached detail accessible '+p,(await api(p)).status===200);
  const listing=await api('/applications?pageSize=100');check('detached application remains listed',listing.status===200&&JSON.stringify(listing.json).includes('DETACH-A'));
  check('repeat deletion gives 404',(await api(`/requests/${request}`,'DELETE',{reason:'Retry'})).status===404);
  check('audit retained',!!get("SELECT id FROM audit_log WHERE action='request.deleted' AND entity_id=?",[String(request)]));
  if(sqlite){check('final FK integrity',all('PRAGMA foreign_key_check').length===0);const id=ins("INSERT INTO request_activity(request_id,type) VALUES (?,'created')",[other]);check('sequence not reused',id>700);check('trigger still executes',get('SELECT COUNT(*) AS n FROM migration_probe').n===1);}
  console.log(`RESULT ${passed} passed; engine=${driverKind()}`);process.exit(0);
}catch(e){console.error(e);process.exit(1);}
