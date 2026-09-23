// Isolated regression cases for the September on-premises findings.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
process.env.DATABASE_URL = `file:/tmp/ats-audit-${randomUUID()}.db`;
process.env.MICROSOFT_TOKEN_ENCRYPTION_KEY = 'a'.repeat(64);
process.env.SMTP_TRANSPORT = 'json';
const {ensureSchema}=await import('./src/lib/schema.js');
const {run,get,all,exec}=await import('./src/lib/db.js');
const {ROLES}=await import('./src/lib/permissions.js');
const {saveMailSettings}=await import('./src/lib/mail-settings.js');
const {classifyAttachment}=await import('./src/lib/microsoft/mailbox-sync.js');
const {claimAttachment,completeAttachment}=await import('./src/lib/microsoft/connection-store.js');
let failures=0;
function check(name,fn){try{fn();console.log('PASS',name)}catch(e){failures++;console.error('FAIL',name,e.message)}}
ensureSchema();
const marker='schema.backfill.cv_inbox_roles';
check('empty first boot must not consume the role backfill',()=>assert.equal(get('SELECT id FROM system_setting WHERE key=?',[marker]),undefined));
run('DELETE FROM system_setting WHERE key=?',[marker]);
for(const [code,name,description] of ROLES)run('INSERT INTO role (code,name,description) VALUES (?,?,?)',[code,name,description]);
exec(`CREATE TRIGGER fail_backfill BEFORE INSERT ON system_setting WHEN NEW.key='schema.backfill.cv_inbox_roles' BEGIN SELECT RAISE(ABORT, 'synthetic marker failure'); END;`);
ensureSchema();
check('failed backfill rolls back grants together with its marker',()=>assert.equal(get('SELECT COUNT(*) n FROM role_permission').n,0));
exec('DROP TRIGGER fail_backfill');
ensureSchema();
const grants=role=>all('SELECT p.code FROM role_permission rp JOIN role r ON r.id=rp.role_id JOIN permission p ON p.id=rp.permission_id WHERE r.code=? ORDER BY p.code',[role]).map(p=>p.code);
// Product owner, 14 Sep 2026: the whole CV Inbox for the whole HR function,
// `cv_intake.control` included. If that spending control should later sit
// higher than the recruiter's desk, it is revoked in Roles & Permissions — the
// revocation case immediately below is what proves such a decision sticks.
const FULL_INBOX=['cv_intake.approve_batch','cv_intake.control','cv_intake.import','cv_intake.preview','cv_intake.view'];
for(const role of ['recruiter','recruitment_manager','hr_manager','hr_director']) check(role+' holds the whole CV Inbox',()=>assert.deepEqual(grants(role),FULL_INBOX));
check('unrelated roles stay unchanged',()=>assert.deepEqual(grants('hiring_manager'),[]));
run("DELETE FROM role_permission WHERE role_id=(SELECT id FROM role WHERE code='recruiter') AND permission_id=(SELECT id FROM permission WHERE code='cv_intake.preview')");
ensureSchema();
check('later admin revocation survives a restart',()=>assert.ok(!grants('recruiter').includes('cv_intake.preview')));
check('SMTP submission rejects implicit TLS on port 587 before saving',()=>assert.throws(()=>saveMailSettings({provider:'smtp',host:'smtp.office365.com',port:587,encryption:'tls',user:'fixture@example.com',from:'fixture@example.com',password:'synthetic-password'}),/STARTTLS/));
for(const ext of ['jpg','jpeg','png'])check('photographed CV .'+ext+' enters discovery',()=>assert.equal(classifyAttachment({'@odata.type':'#microsoft.graph.fileAttachment',name:'CV.'+ext,size:1024,isInline:false}).accept,true));
check('inline signature images remain excluded',()=>assert.equal(classifyAttachment({'@odata.type':'#microsoft.graph.fileAttachment',name:'signature.png',isInline:true}).accept,false));
check('HEIC is not promised without a decoder',()=>assert.equal(classifyAttachment({'@odata.type':'#microsoft.graph.fileAttachment',name:'CV.heic',isInline:false}).accept,false));
const old={mailbox:'fixture@example.com',messageKey:'old-msg',attachmentKey:'old-file',messageId:'old-msg',attachmentId:'old-file',attachmentName:'cv.pdf'};
const claim=claimAttachment(old);assert.equal(claim.claimed,true);completeAttachment(claim.key,{status:'IMPORTED',intakeId:null});
const again=claimAttachment({...old,subject:'Civil Engineer',sender:'applicant@example.com',category:'Civil Engineer'});
check('rediscovery enriches historical metadata without reprocessing',()=>{assert.equal(again.claimed,false);const row=get('SELECT * FROM mailbox_ingestion WHERE dedup_key=?',[claim.key]);assert.equal(row.subject,'Civil Engineer');assert.equal(row.category,'Civil Engineer');assert.equal(row.status,'IMPORTED')});
const photo={...old,messageKey:'old-photo',messageId:'old-photo',attachmentName:'cv.jpg'};
const skipped=claimAttachment(photo);assert.equal(skipped.claimed,true);assert.notEqual(skipped.key,claim.key);completeAttachment(skipped.key,{status:'SKIPPED',reason:'unsupported file type .jpg'});
check('explicit discovery can recover formerly unsupported photos',()=>assert.equal(claimAttachment({...photo,retryUnsupported:true}).claimed,true));
const duplicate={...old,messageKey:'duplicate',messageId:'duplicate'};
const dup=claimAttachment(duplicate);assert.equal(dup.claimed,true);assert.notEqual(dup.key,skipped.key);completeAttachment(dup.key,{status:'SKIPPED',reason:'an identical CV is already awaiting review'});
check('discovery does not revive genuine duplicates',()=>assert.equal(claimAttachment({...duplicate,retryUnsupported:true}).claimed,false));
process.env.SEED_ADMIN_PASSWORD='Synthetic#Bootstrap1';
process.env.SEED_DEMO_DATA='false';
run('DELETE FROM system_setting WHERE key=?',[marker]);
run('DELETE FROM role_permission');
run('DELETE FROM role');
const {seed}=await import('./prisma/seed.js');
await seed({demo:false});
run("DELETE FROM role_permission WHERE role_id=(SELECT id FROM role WHERE code='recruiter') AND permission_id=(SELECT id FROM permission WHERE code='cv_intake.preview')");
ensureSchema();
check('first-install admin revocation survives the first restart',()=>assert.ok(!grants('recruiter').includes('cv_intake.preview')));
console.log('AUDIT REGRESSIONS:',failures,'failures');
process.exit(failures?1:0);
