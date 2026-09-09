import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
const source=readFileSync(new URL('../deploy/on-prem/backup.sh',import.meta.url),'utf8');
for(const day of ['1','7']) test(`backup succeeds without prior weekly archives on day ${day}`,t=>{
 const root=mkdtempSync(path.join(tmpdir(),'ats-backup-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const dest=path.join(root,'backups'),uploads=path.join(root,'uploads'),bin=path.join(root,'bin');
 for(const dir of [dest,uploads,bin])mkdirSync(dir);
 writeFileSync(path.join(uploads,'cv.txt'),'synthetic');
 const env=path.join(root,'ats.env');writeFileSync(env,`DATABASE_URL=postgres://fixture\nUPLOAD_DIR=${uploads}\n`);
 writeFileSync(path.join(bin,'pg_dump'),'#!/bin/bash\nwhile [ "$#" -gt 0 ]; do if [ "$1" = "-f" ]; then shift; echo fixture > "$1"; exit; fi; shift; done\n',{mode:0o755});
 const script=path.join(root,'backup.sh');writeFileSync(script,source.replace('/etc/arabtec-ats/ats.env',env).replace('DEST=/var/backups/arabtec-ats',`DEST=${dest}`).replace('DOW="$(date +%u)"',`DOW=${day}`));
 const r=spawnSync('bash',[script],{encoding:'utf8',env:{...process.env,PATH:`${bin}:${process.env.PATH}`}});
 assert.equal(r.status,0,r.stdout+r.stderr);
 const files=readdirSync(dest);assert.equal(files.length,day==='7'?4:2);assert.ok(files.some(x=>x.startsWith('db-')));assert.ok(files.some(x=>x.startsWith('uploads-')));
});
