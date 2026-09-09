// Execute production JSX with its vendored React/Babel. The small hook driver
// exercises actual event handlers and effects without a DOM/browser or network.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
const publicDir = fileURLToPath(new URL('../frontend/public/', import.meta.url));
const window = new EventTarget();
window.location = {hash:'', pathname:'/', search:'', reload(){}};
window.history = {replaceState(){window.location.hash='';}};
window.confirm = () => false;
const document = Object.assign(new EventTarget(), {getElementById:()=>({}), activeElement:null});
const ctx = vm.createContext({window, document, Event, CustomEvent, URLSearchParams, console,
  localStorage:{getItem:()=>null}, setTimeout, clearTimeout,
  ReactDOM:{createRoot:()=>({render(){}})},
  fetch(){throw new Error('UI behavior tests must not use the network');}});
ctx.self=ctx;
vm.runInContext(fs.readFileSync(publicDir+'vendor/react.production.min.js','utf8'),ctx);
vm.runInContext(fs.readFileSync(publicDir+'vendor/babel.min.js','utf8'),ctx);
for (const file of ['email-settings.jsx','org-structure.jsx','app.jsx']) {
  const source=fs.readFileSync(publicDir+file,'utf8');
  vm.runInContext(ctx.Babel.transform(source,{presets:['react']}).code,ctx,{filename:file});
}
const get = expression => vm.runInContext(expression,ctx);
const React = ctx.React;
let nextId=0;
function mount(Component, initialProps={}) {
  let slots=[], cursor=0, effects=[], props=initialProps;
  const same=(a,b)=>a&&b&&a.length===b.length&&a.every((x,i)=>Object.is(x,b[i]));
  const memo=(fn,deps)=>{const i=cursor++;if(!slots[i]||!same(slots[i].deps,deps)) slots[i]={value:fn(),deps};return slots[i].value;};
  const dispatcher={
    useState(initial){const i=cursor++;if(!(i in slots))slots[i]={value:typeof initial==='function'?initial():initial};return [slots[i].value,value=>{slots[i].value=typeof value==='function'?value(slots[i].value):value;}];},
    useRef(initial){return memo(()=>({current:initial}),[]);},
    useId(){return memo(()=>`test-${++nextId}`,[]);},
    useMemo:memo, useCallback:(fn,deps)=>memo(()=>fn,deps),
    useContext:context=>context._currentValue,
    useEffect(fn,deps){const i=cursor++;if(!slots[i]||!same(slots[i].deps,deps))effects.push(()=>{slots[i]?.cleanup?.();slots[i]={deps,cleanup:fn()};});},
  };
  return {
    render(next=props){props=next;cursor=0;effects=[];
      React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher.current=dispatcher;
      let tree;try{tree=Component(props);}finally{React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher.current=null;}
      effects.forEach(run=>run());return tree;},
    dispose(){slots.forEach(slot=>slot?.cleanup?.());},
  };
}
function nodes(tree) {
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  if (!tree||typeof tree!=='object')return [];
  return [tree,...nodes(tree.props?.children)];
}
function text(tree) {
  if (Array.isArray(tree))return tree.map(text).join('');
  if (tree==null||typeof tree==='boolean')return '';
  return typeof tree==='object'?text(tree.props?.children):String(tree);
}
const button=(tree,label)=>nodes(tree).find(n=>n.type==='button'&&text(n)===label);
const flush=()=>new Promise(resolve=>setImmediate(resolve));
let passed=0;
async function check(name,run){await run();passed++;console.log(`  ✓ ${name}`);}

await check('all board transitions are forward-only; hired, joined and disqualified cards are locked',()=>{
  const order=get('APP_ORDER'), canMove=get('canPipelineMove');
  for(let i=0;i<order.length;i++)for(let j=0;j<order.length;j++)assert.equal(canMove(order[i],order[j]),j>i);
  for(const status of ['hired','joined','rejected','offer_declined','on_hold','unrecognized'])
    for(const target of [...order,'rejected','on_hold'])assert.equal(canMove(status,target),false);
  assert.equal(canMove('waiting_feedback','offer'),true);
  assert.equal(canMove('interview_technical','screening'),false);
});
await check('folded and unknown stages retain their specific status information',()=>{
  const stage=get('pipelineStage'), label=get('pipelineResidualLabel');
  assert.equal(stage('interview_technical'),'interview_hr');
  assert.equal(label('interview_technical'),'2nd Interview (Technical)');
  assert.equal(label('waiting_feedback'),'Waiting feedback');
  assert.equal(label('offer_sent'),'Offer sent');
  assert.equal(label('custom_stage'),'Custom stage');
  assert.equal(label('sourced'),'');
});
await check('card menu is a keyboard/touch alternative with only forward targets',()=>{
  let moved=null;
  const card=mount(get('PipelineCard'),{app:{id:1,status:'matched',candidate:{fullName:'Test Candidate'}},canMove:true,onView(){},onMove:s=>{moved=s;}});
  let tree=card.render();assert.equal(tree.props.draggable,true);
  nodes(tree).find(n=>n.props?.['aria-haspopup']==='menu').props.onClick();tree=card.render();
  assert.equal(button(tree,'Move to Sourced'),undefined);
  assert.equal(button(tree,'Move to Screening'),undefined);
  assert.ok(button(tree,'Move to Offer'));
  const menu=nodes(tree).find(n=>n.props?.role==='menu');
  let focused=-1;const targets=[0,1,2].map(i=>({focus(){focused=i;document.activeElement=this;}}));
  menu.ref.current={querySelectorAll:()=>targets,contains:()=>false};document.activeElement=targets[0];
  menu.props.onKeyDown({key:'ArrowDown',preventDefault(){}});assert.equal(focused,1);
  menu.props.onKeyDown({key:'End',preventDefault(){}});assert.equal(focused,2);
  menu.props.onKeyDown({key:'Home',preventDefault(){}});assert.equal(focused,0);
  button(tree,'Move to Offer').props.onClick();assert.equal(moved,'offer');
  assert.equal(nodes(card.render()).some(n=>n.props?.role==='menu'),false);card.dispose();
  for(const status of ['hired','joined','rejected']){
    const locked=mount(get('PipelineCard'),{app:{id:1,status},canMove:true,onView(){}});
    let t=locked.render();assert.equal(t.props.draggable,false);
    nodes(t).find(n=>n.props?.['aria-haspopup']==='menu').props.onClick();t=locked.render();
    assert.equal(nodes(t).filter(n=>n.props?.role==='menuitem').length,1);locked.dispose();
  }
  const pending=mount(get('PipelineCard'),{app:{id:1,status:'sourced'},canMove:true,pending:true});
  const t=pending.render();assert.equal(t.props.draggable,false);assert.ok(nodes(t).filter(n=>n.type==='button').every(n=>n.props.disabled));pending.dispose();
});
await check('list cards show a stage without requiring a board column header',()=>{
  const card=mount(get('PipelineCard'),{app:{id:1,status:'sourced'},wide:true});
  assert.ok(nodes(card.render()).some(n=>n.type===get('AppStatusBadge')&&n.props.status==='sourced'));card.dispose();
});
await check('drop handlers reject backward, hired, pending, foreign, and unauthorized drops',()=>{
  let calls=[];
  const apps=[{id:1,status:'matched'},{id:2,status:'joined'}];
  const props={stage:'offer',apps,pending:new Set(),canMove:true,onMove:(...args)=>calls.push(args)};
  const col=mount(get('PipelineColumn'),props);
  const drop=id=>({preventDefault(){},dataTransfer:{getData:()=>String(id)}});
  col.render().props.onDrop(drop(1));assert.deepEqual(calls,[[1,'offer']]);
  for(const [changes,id] of [[{stage:'sourced'},1],[{},2],[{pending:new Set([1])},1],[{},999],[{canMove:false},1]])col.render({...props,...changes}).props.onDrop(drop(id));
  assert.equal(calls.length,1);col.dispose();
});
await check('guarded writes map API stages and roll back only the failed card',async()=>{
  const api=window.ARABTEC_API;let calls=[],reject;
  api.post=(path,body)=>{calls.push({path,body});return new Promise((_,fail)=>{reject=fail;});};
  let list=[{id:1,status:'matched'},{id:2,status:'sourced'}], pending=new Set();
  const updateList=value=>{list=typeof value==='function'?value(list):value;};
  const updatePending=value=>{pending=typeof value==='function'?value(pending):value;};
  const move=get('moveApplication');
  await move({appId:1,status:'sourced',list,setList:updateList,pending,setPending:updatePending,toast(){}});assert.equal(calls.length,0);
  const result=move({appId:1,status:'offer',list,setList:updateList,pending,setPending:updatePending,toast(){}});
  assert.equal(calls[0].body.status,'issuing_offer');assert.equal(list[0].status,'issuing_offer');assert.ok(pending.has(1));
  list=list.map(a=>a.id===2?{...a,status:'matched'}:a);
  reject(new Error('Server refused move'));await result;
  assert.equal(list[0].status,'matched');assert.equal(list[1].status,'matched');assert.equal(pending.size,0);
});
await check('mobile navigation follows persona order and never adds an unauthorized item',()=>{
  const nav=get('NAV'), select=get('mobileNavItems');
  const interview=select(nav,'interviewer').map(n=>n.key);
  assert.equal(JSON.stringify(interview),JSON.stringify(['dashboard','interviews','requests','candidates']));
  const limited=select(nav.filter(n=>['dashboard','interviews','candidateReview'].includes(n.key)),'interviewer');
  assert.equal(JSON.stringify(limited.map(n=>n.key)),JSON.stringify(['dashboard','interviews']));
});
await check('dirty Roles edits survive cancelled role picks, internal navigation and page exit; save clears the guard',async()=>{
  const roles=[{id:1,name:'Role A',permissions:[]},{id:2,name:'Role B',permissions:[]}];
  window.ARABTEC_API.get=async path=>path==='/roles'?{roles}:{permissions:[{code:'candidate.view',description:'View candidates',resource:'candidate'}]};
  window.ARABTEC_API.put=async()=>({});
  const page=mount(get('RolesPage'),{user:{permissions:['role.manage']}});
  page.render();await flush();let tree=page.render();
  nodes(tree).find(n=>n.type==='input'&&n.props.type==='checkbox').props.onChange();tree=page.render();
  assert.ok(text(tree).includes('unsaved'));button(tree,'Role B').props.onClick();tree=page.render();
  assert.ok(text(tree).includes('Role A — 1 permissions'));assert.equal(get('confirmPageExit')(),false);
  const unload=new Event('beforeunload',{cancelable:true});window.dispatchEvent(unload);assert.ok(unload.defaultPrevented);
  await button(tree,'Save Changes').props.onClick();tree=page.render();assert.equal(button(tree,'Save Changes').props.disabled,true);assert.equal(get('confirmPageExit')(),true);page.dispose();
});
await check('hash links use the dirty guard once, route to email, and retain the permission gate',()=>{
  get('useWorkCounts = () => [{dash:null,intakes:null}]');
  const props={user:{id:1,fullName:'Test User',roles:['system_admin'],permissions:['system.manage']},branding:{}};
  const shell=mount(get('Shell'),props);shell.render();
  let prompts=0;const block=e=>{prompts++;e.preventDefault();};window.addEventListener('ats:before-navigate',block);
  window.location.hash='#email';window.dispatchEvent(new Event('hashchange'));
  assert.equal(prompts,1);assert.equal(nodes(shell.render()).some(n=>n.type===window.ArabtecEmailSettingsPage),false);
  window.removeEventListener('ats:before-navigate',block);window.location.hash='#email';window.dispatchEvent(new Event('hashchange'));
  assert.ok(nodes(shell.render()).some(n=>n.type===window.ArabtecEmailSettingsPage));shell.dispose();
  window.location.hash='#email';const denied=mount(get('Shell'),{...props,user:{...props.user,roles:['recruiter'],permissions:[]}});denied.render();
  const tree=denied.render();assert.equal(nodes(tree).some(n=>n.type===window.ArabtecEmailSettingsPage),false);
  assert.ok(nodes(tree).some(n=>n.type===get('Forbidden')&&n.props.what==='Email Settings'));denied.dispose();
});
await check('shared filter disclosure keeps the same controlled inputs and state when closed',()=>{
  let changed='';const input=React.createElement('input',{value:'Riyadh',onChange:e=>{changed=e.target.value;}});
  const toolbar=mount(get('FilterToolbar'),{children:input,activeCount:1});
  let tree=toolbar.render();const toggle=nodes(tree).find(n=>n.props?.['aria-controls']);
  assert.equal(toggle.props['aria-expanded'],false);toggle.props.onClick();tree=toolbar.render();
  const field=nodes(tree).find(n=>n.type==='input');assert.equal(field.props.value,'Riyadh');field.props.onChange({target:{value:'Dubai'}});assert.equal(changed,'Dubai');toolbar.dispose();
});
await check('request detail failure renders a retry and does not return markup from an effect',async()=>{
  window.ARABTEC_API.get=async()=>{throw new Error('Request could not be loaded');};
  const page=mount(get('RequestDetail'),{id:1,user:{permissions:[]},btns:{}});
  page.render();await flush();const tree=page.render();
  assert.equal(tree.type,get('LoadError'));assert.equal(tree.props.text,'Request could not be loaded');
  await tree.props.onRetry();page.render();page.dispose();
});
await check('email saves omit stored credentials and failed draft tests never save',async()=>{
  const fixture={settings:{provider:'smtp',host:'mail.example.test',port:587,encryption:'starttls',user:'test',from:'test@example.test',fromName:'Test',replyTo:'',passwordSet:true,passwordSetAt:null,encryptionReady:true},microsoft:{},delivery:{sentThisMonth:0},provider:'smtp'};
  let saves=[],tests=[];
  window.ARABTEC_API.get=async()=>fixture;
  window.ARABTEC_API.put=async(path,body)=>{saves.push({path,body});return {...fixture,settings:{...fixture.settings,...body}};};
  window.ARABTEC_API.post=async(path,body)=>{tests.push({path,body});throw new Error('SMTP 535 Authentication unsuccessful');};
  const page=mount(window.ArabtecEmailSettingsPage,{PageHead:get('PageHead'),Empty:get('Empty'),Skeleton:get('Skeleton'),Icon:get('Icon')});
  page.render();await flush();let tree=page.render();assert.equal(nodes(tree).some(n=>n.type==='input'&&n.props.type==='password'),false);
  nodes(tree).find(n=>n.props?.id==='email-fromName').props.onChange({target:{value:'New sender'}});tree=page.render();
  await nodes(tree).find(n=>n.type==='form').props.onSubmit({preventDefault(){}});tree=page.render();
  assert.equal(saves.length,1);assert.equal(Object.hasOwn(saves[0].body,'password'),false);
  button(tree,'Replace').props.onClick();tree=page.render();const password=nodes(tree).find(n=>n.type==='input'&&n.props.type==='password');assert.ok(password);
  password.props.onChange({target:{value:'synthetic-test-value'}});tree=page.render();
  await button(tree,'Test connection').props.onClick();tree=page.render();assert.equal(saves.length,1);assert.equal(tests[0].body.settings.password,'synthetic-test-value');
  assert.ok(text(tree).includes('SMTP 535 Authentication unsuccessful'));assert.equal(get('confirmPageExit')(),false);page.dispose();
});
await check('organization navigation renders its module and a missing-module preview',()=>{
  get('useWorkCounts = () => [{dash:null,intakes:null}]');
  const originalOrgPage=window.ArabtecOrgStructurePage;
  window.ArabtecOrgStructurePage=()=>null;
  const props={user:{id:1,fullName:'Test User',roles:['system_admin'],permissions:['system.manage']},branding:{}};
  window.location.hash='#orgStructure';const shell=mount(get('Shell'),props);shell.render();
  assert.ok(nodes(shell.render()).some(n=>n.type===window.ArabtecOrgStructurePage));
  delete window.ArabtecOrgStructurePage;
  assert.ok(nodes(shell.render()).some(n=>n.type===get('ModulePreview')));shell.dispose();window.ArabtecOrgStructurePage=originalOrgPage;
});
await check('offers empty, populated and invalid responses always produce visible states',async()=>{
  for (const response of [{offers:[]},{offers:[{id:1,offerNo:'O-1',status:'draft'}]},{}]) {
    window.offerResponse=response;get('api.get = async () => window.offerResponse');
    const page=mount(get('OffersPage'),{user:{permissions:['offer.view']}});page.render();await flush();
    const tree=page.render();
    if(!response.offers) assert.ok(nodes(tree).some(n=>n.type===get('LoadError')));
    else if(!response.offers.length) assert.ok(nodes(tree).some(n=>n.type===get('Empty')&&n.props.title==='No offers raised yet'));
    else assert.ok(text(tree).includes('O-1'));
    page.dispose();
  }
});
await check('organization empty and failed loads show actionable content without endless loading',async()=>{
  for (const response of [{nodes:[]},null]) {
    window.orgResponse=response;
    get("api.get = async () => { if (!window.orgResponse) throw new Error('Service unavailable'); return window.orgResponse; }");
    const page=mount(window.ArabtecOrgStructurePage,{user:{permissions:[]}});page.render();await flush();
    const tree=page.render();
    if(response) assert.ok(text(tree).includes('Work in progress'));
    else {assert.ok(button(tree,'Retry'));assert.ok(!text(tree).includes('Loading organization structure'));}
    page.dispose();
  }
});
console.log(`\n=== UI BEHAVIOR: ${passed} passed ===\n`);
