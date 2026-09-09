import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('./src/lib/org-chart-seed.js',import.meta.url),'utf8')
  .replace(/^import .*;\n/gm,'').replace(/export /g,'');
let writes=0;
// `tx` and `driverKind` stand in for the real database surface: the bootstrap
// section runs in one transaction and takes an advisory lock on PostgreSQL only.
const context=vm.createContext({process:{env:{NODE_ENV:'production'}},get:()=>({c:0}),exec:()=>{},
  tx:(fn)=>fn(),driverKind:()=>'sqlite',
  OrganizationNodes:{count:()=>writes,create(){writes++;return {id:writes};}}});
vm.runInContext(source,context);
vm.runInContext('seedOrganizationChartIfEmpty()',context);
assert.equal(writes,0,'Production startup must not import bundled chart records');
context.process.env.NODE_ENV='test';
vm.runInContext('seedOrganizationChartIfEmpty()',context);
assert.ok(writes>0,'Development fixtures remain available');
console.log('Production seed guard passed');
