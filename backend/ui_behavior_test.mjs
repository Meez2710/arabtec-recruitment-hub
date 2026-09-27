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
/* One reading of an org node for the canvas, the selected card and the phone
   drill-down. Shapes are the ones /api/org/chart returns for the seeded chart:
   units and projects arrive with status "filled" and no employee name, which
   the old inline test read as a vacancy — so the company itself said "Vacant". */
{
  const { isVacant, nodeName, nodeTitle, nodeMeta, avatarText } = get('window.ORG_CHART_NODE');
  const company = { nodeType: 'organizational_unit', status: 'filled', employeeName: '', positionTitle: 'Arabtec Egypt', department: 'Head Office', projectOrLocation: 'Head Office' };
  const project = { nodeType: 'project', status: 'filled', employeeName: '', positionTitle: 'Aliva', department: 'Projects', projectOrLocation: 'Aliva' };
  const seat = { nodeType: 'vacant_position', status: 'vacant', employeeName: '', positionTitle: 'Site Engineer', department: 'Projects', projectOrLocation: 'Aliva' };
  const person = { nodeType: 'employee_position', status: 'filled', employeeName: 'Ahmed Abuzeid', positionTitle: 'Project Manager', department: 'Projects', projectOrLocation: 'Aliva' };

  await check('an org unit or project is never labelled a vacancy', () => {
    for (const n of [company, project]) {
      assert.equal(isVacant(n), false, n.positionTitle);
      assert.notEqual(nodeTitle(n), 'Vacant', n.positionTitle);
      assert.notEqual(avatarText(n), 'V', n.positionTitle);
    }
    assert.equal(nodeName(company), 'Arabtec Egypt');
    assert.equal(nodeTitle(project), 'Project');
  });
  await check('an empty seat is still a vacancy, and a filled one shows the person', () => {
    assert.equal(isVacant(seat), true);
    assert.equal(nodeTitle(seat), 'Vacant');
    assert.equal(nodeName(seat), 'Site Engineer');
    assert.equal(nodeName(person), 'Ahmed Abuzeid');
    assert.equal(nodeTitle(person), 'Project Manager');
    assert.equal(avatarText(person), 'AA');
  });
  await check('the location line never repeats itself', () => {
    assert.equal(nodeMeta(company), 'Head Office', 'not "Head Office · Head Office"');
    assert.equal(nodeMeta(person), 'Projects · Aliva');
    assert.equal(nodeMeta({ nodeType: 'employee_position', department: '', projectOrLocation: '' }), '');
  });
}
/* Org chart framing, asserted on the real measured geometry rather than on the
   shape of the source. The regex guards in org_chart_test.mjs proved a
   `centerOn` formula existed; they could not prove the root ends up on screen,
   and an independent reviewer used exactly that gap to find a blocker
   (collapsing the root left the canvas panned 9228px away from the only card
   remaining). These call the module's own exported maths. */
{
  const { centerOffset, fitScale, ORG_MIN_SCALE } = get('window.ORG_CHART_MATH');
  // Measured live at 1440x900 with the seeded 113 positions.
  const EXPANDED = { wrapW: 1095, wrapH: 753, canvasW: 19552, canvasH: 753 };
  const COLLAPSED = { wrapW: 1095, wrapH: 753, canvasW: 1095, canvasH: 441 };
  // The tree is centred inside the canvas, so the root's midpoint IS the
  // canvas midpoint. On screen it lands at pan.x + canvasW*scale/2.
  const rootOnScreen = (box, scale) => {
    const pan = centerOffset({ ...box, scale });
    const rootCentre = pan.x + (box.canvasW * scale) / 2;
    return rootCentre > 0 && rootCentre < box.wrapW;
  };

  await check('a fully expanded chart still frames its root at scale 1', () => {
    assert.equal(centerOffset({ ...EXPANDED, scale: 1 }).x, -9228,
      'the measured pan for the seeded tree');
    assert.ok(rootOnScreen(EXPANDED, 1), 'the root sits inside the viewport, not 9670px away');
  });

  await check('collapsing to a single card re-frames instead of stranding it', () => {
    // The regression: the canvas shrank 19552 -> 1095 while the pan stayed at
    // -9228, putting the only remaining card completely off screen.
    const stalePan = centerOffset({ ...EXPANDED, scale: 1 }).x;
    const staleCentre = stalePan + (COLLAPSED.canvasW * 1) / 2;
    assert.ok(staleCentre < 0, 'keeping the old pan really does strand the card (the bug)');
    assert.ok(rootOnScreen(COLLAPSED, 1), 're-framing for the new width brings it back');
    assert.ok(centerOffset({ ...COLLAPSED, scale: 1 }).y > 0,
      'and a tree that now fits is centred vertically rather than pinned to the top');
  });

  await check('Fit resolves to a readable scale and frames the root', () => {
    const s = fitScale(EXPANDED);
    assert.equal(s, ORG_MIN_SCALE, 'a tree this wide lands on the readable floor, not an invisible one');
    assert.ok(rootOnScreen(EXPANDED, s), 'Fit puts the root on screen');
    // Fit must never be the old no-op.
    assert.notEqual(centerOffset({ ...EXPANDED, scale: s }).x, 0, 'Fit is not a reset to the origin');
  });

  await check('a tree that already fits is not scaled down by Fit', () => {
    assert.equal(fitScale(COLLAPSED), 1);
  });

  await check('framing degrades safely before the canvas has been measured', () => {
    // Field-wise: the helper is defined inside the vm realm, so its object
    // literal does not share this realm's Object prototype.
    const zero = centerOffset({ wrapW: 0, wrapH: 0, canvasW: 0, canvasH: 0, scale: 1 });
    assert.equal(zero.x, 0); assert.equal(zero.y, 0);
    assert.equal(fitScale({ wrapW: 0, wrapH: 0, canvasW: 0, canvasH: 0 }), 1);
  });
}

/* ---------------------------------------------------------------------------
   Phone presentation: ONE shell, not two.

   `Shell` renders the phone chrome INSTEAD of the desktop chrome. These guards
   run the real component through the real hook driver, so they fail if anyone
   later "fixes" the breakpoint by hiding one presentation with CSS — which is
   the failure mode that matters: a hidden desktop shell leaves a second full
   set of buttons in the DOM, focusable by keyboard, with duplicate ids.
   ------------------------------------------------------------------------ */
{
  const PERMS = ['dashboard.view', 'candidate.view', 'request.view', 'interview.view',
    'offer.view', 'cv_intake.view', 'report.view'];
  const USER = { id: 7, fullName: 'Test Recruiter', roles: ['recruiter'], permissions: PERMS };
  const BRANDING = { app_name: 'Arabtec', company_name: 'Arabtec Construction' };

  // Count every API call the shell makes, so "crossing the breakpoint costs no
  // request" is measured, not assumed.
  const api = window.ARABTEC_API;
  const realGet = api.get;
  let apiCalls = [];
  api.get = (path) => { apiCalls.push(path); return Promise.resolve({}); };

  // A real matchMedia that actually notifies, so flipping the breakpoint on a
  // MOUNTED shell exercises the same path a browser takes when the window is
  // resized — not just a fresh mount at the other width.
  let phone = false;
  let listeners = [];
  window.matchMedia = (query) => ({
    media: query,
    get matches() { return phone; },
    addEventListener(_type, fn) { listeners.push(fn); },
    removeEventListener(_type, fn) { listeners = listeners.filter((l) => l !== fn); },
    addListener(fn) { listeners.push(fn); },
    removeListener(fn) { listeners = listeners.filter((l) => l !== fn); },
  });
  const setPhone = (value) => { phone = value; listeners.forEach((fn) => fn({ matches: value })); };

  const Shell = get('Shell');
  const MobileAppBar = get('MobileAppBar');
  const MobileDrawer = get('MobileDrawer');
  const MobileTabBar = get('MobileTabBar');
  const cls = (n) => String(n.props?.className || '');
  const has = (tree, pred) => nodes(tree).some(pred);
  const desktopChrome = (tree) => nodes(tree).filter((n) =>
    n.type === 'aside' || cls(n).split(/\s+/).includes('sidebar')
    || cls(n).split(/\s+/).includes('topbar') || cls(n).split(/\s+/).includes('mobile-nav')
    || cls(n).split(/\s+/).includes('more-sheet'));
  const phoneChrome = (tree) => nodes(tree).filter((n) =>
    n.type === MobileAppBar || n.type === MobileDrawer || n.type === MobileTabBar);

  await check('below the breakpoint the desktop chrome is not rendered at all — not merely hidden', () => {
    setPhone(true);
    const shell = mount(Shell, { user: USER, branding: BRANDING, onLogout() {}, refreshBranding() {} });
    const tree = shell.render();
    assert.deepEqual(desktopChrome(tree).map(cls), [],
      'the phone shell must not emit the sidebar, topbar, bottom nav or More sheet — a hidden copy is still focusable');
    assert.equal(phoneChrome(tree).length, 3, 'expected exactly the app bar, the drawer and the tab bar');
    assert.ok(has(tree, (n) => cls(n).split(/\s+/).includes('shell-phone')));
    shell.dispose();
  });

  await check('above the breakpoint the phone chrome is not rendered at all, and the desktop shell is untouched', () => {
    setPhone(false);
    const shell = mount(Shell, { user: USER, branding: BRANDING, onLogout() {}, refreshBranding() {} });
    const tree = shell.render();
    assert.deepEqual(phoneChrome(tree), [], 'no phone component may exist in a desktop DOM');
    const chrome = desktopChrome(tree).map(cls);
    assert.ok(chrome.some((c) => c.split(/\s+/).includes('sidebar')), 'desktop still renders its sidebar');
    assert.ok(chrome.some((c) => c.split(/\s+/).includes('topbar')), 'desktop still renders its topbar');
    // The old bottom bar and More sheet are gone from BOTH presentations: above
    // 900px they were display:none, below it the desktop branch never rendered.
    assert.ok(!chrome.some((c) => c.split(/\s+/).includes('mobile-nav') || c.split(/\s+/).includes('more-sheet')),
      'the retired mobile chrome must not come back — it is a second nav nobody can reach');
    shell.dispose();
  });

  await check('exactly one primary navigation exists in either presentation', () => {
    for (const isPhone of [true, false]) {
      setPhone(isPhone);
      const shell = mount(Shell, { user: USER, branding: BRANDING, onLogout() {}, refreshBranding() {} });
      const tree = shell.render();
      // `nodes()` does not expand a component, so count both forms: the desktop
      // path emits its sidebar <nav> directly, the phone path emits
      // <MobileTabBar>, which (asserted below) is itself exactly one <nav>.
      const navs = nodes(tree).filter((n) => n.type === 'nav' || n.type === MobileTabBar);
      assert.equal(navs.length, 1,
        `expected one navigation landmark at ${isPhone ? 'phone' : 'desktop'}, found ${navs.length} — a second one is a list that can disagree with the first`);
      shell.dispose();
    }
    const bar = mount(MobileTabBar, { items: get('NAV').filter((n) => n.key === 'dashboard'), route: 'dashboard', counts: {}, onGo() {}, onMore() {}, moreOpen: false });
    const rendered = bar.render();
    assert.equal(nodes(rendered).filter((n) => n.props?.['aria-label'] === 'Primary').length, 1,
      'the tab bar is itself exactly one primary navigation region');
    bar.dispose();
  });

  await check('the phone chrome is driven by the same permission-filtered nav, the same counts and the same user', () => {
    setPhone(true);
    const shell = mount(Shell, { user: USER, branding: BRANDING, onLogout() {}, refreshBranding() {} });
    const tree = shell.render();
    const drawer = nodes(tree).find((n) => n.type === MobileDrawer);
    const expected = get('NAV').filter((n) => n.section
      || (n.anyPerm ? n.anyPerm.some((p) => PERMS.includes(p)) : (!n.perm || PERMS.includes(n.perm))));
    assert.deepEqual(drawer.props.nav.map((n) => n.key || n.section), expected.map((n) => n.key || n.section),
      'the drawer must show the same list the desktop sidebar computes — not its own');
    assert.ok(!drawer.props.nav.some((n) => n.perm && !PERMS.includes(n.perm)),
      'a section this user cannot reach must never appear in the phone drawer');
    assert.equal(drawer.props.user, USER);
    const tabs = nodes(tree).find((n) => n.type === MobileTabBar);
    assert.ok(tabs.props.counts, 'the tab bar reads the same work counts, not a second fetch');
    assert.equal(tabs.props.counts, drawer.props.counts);
    shell.dispose();
  });

  await check('the phone chrome adds no request of its own and keeps the same route on the same page component', () => {
    setPhone(false);
    const shell = mount(Shell, { user: USER, branding: BRANDING, onLogout() {}, refreshBranding() {} });
    const desktop = shell.render();
    assert.equal(phoneChrome(desktop).length, 0, 'fixture sanity: the shell really did mount as desktop');
    const before = apiCalls.length;
    setPhone(true);
    const onPhone = shell.render();
    assert.equal(phoneChrome(onPhone).length, 3,
      'fixture sanity: the MOUNTED shell must actually switch to the phone presentation on a resize, not only on a fresh mount');
    // The SHELL's own data (work counts) must survive the switch untouched. The
    // page subtree does remount — the two chromes are different element trees —
    // which is measured in the browser, not here; what this guard pins is that
    // the chrome swap itself introduces no fetch.
    assert.equal(apiCalls.length, before,
      `the phone chrome must not refetch the shell's data; ${apiCalls.length - before} extra call(s) were made`);
    const mainOf = (tree) => nodes(tree).find((n) => n.props?.id === 'main-content');
    const pageOf = (tree) => nodes(mainOf(tree)).find((n) => n.props?.page === true).props.children;
    assert.equal(pageOf(onPhone).type, pageOf(desktop).type,
      'the same route must render the same page component in both presentations');
    shell.dispose();
  });

  await check('a phone tab navigates through the shell\'s own guarded go(), and the drawer opens only on request', () => {
    setPhone(true);
    const shell = mount(Shell, { user: USER, branding: BRANDING, onLogout() {}, refreshBranding() {} });
    let tree = shell.render();
    assert.equal(nodes(tree).find((n) => n.type === MobileDrawer).props.open, false,
      'the drawer starts closed, and MobileDrawer renders null while closed');
    const tabs = nodes(tree).find((n) => n.type === MobileTabBar);
    const target = tabs.props.items.find((n) => n.key !== 'dashboard');
    tabs.props.onGo(target.key);
    tree = shell.render();
    const main = nodes(tree).find((n) => n.props?.id === 'main-content');
    assert.ok(main, 'the page region survives navigation');
    assert.equal(nodes(tree).find((n) => n.type === MobileAppBar).props.title,
      get('NAV').find((n) => n.key === target.key).label,
      'the app bar title follows the real route');
    nodes(tree).find((n) => n.type === MobileTabBar).props.onMore();
    tree = shell.render();
    assert.equal(nodes(tree).find((n) => n.type === MobileDrawer).props.open, true,
      '"More" opens the one drawer rather than a second menu');
    shell.dispose();
  });

  await check('the closed drawer renders nothing, so nothing behind it is focusable', () => {
    const closed = mount(MobileDrawer, { open: false, onClose() {}, nav: [], route: 'dashboard', counts: {}, onGo() {}, user: USER, roleCode: 'recruiter', branding: BRANDING, onLogout() {}, onChangePassword() {} });
    assert.equal(closed.render(), null);
    closed.dispose();
  });

  api.get = realGet;
  delete window.matchMedia;
}

/* Data-quality labels go through the canonical <Badge>, and never in the red
   the product uses for Rejected: a candidate with a missing phone number has
   not been turned down. (Pattern audit: docs/audits/status-badges.md.) */
await check('quality labels render through the canonical Badge, never in the rejection red', () => {
  const QualityBadges = get('QualityBadges');
  const Badge = get('Badge');
  const all = ['needs-review', 'possible-duplicate', 'contact-missing',
    'incomplete-profile', 'low-confidence', 'unclassified'];
  const tree = mount(QualityBadges, { flags: all, note: 'n' }).render();
  const badges = nodes(tree).filter((n) => n.type === Badge);
  assert.equal(badges.length, all.length, 'every label is a canonical <Badge>, not a hand-rolled span');
  const variants = Object.fromEntries(badges.map((b) => [text(b), b.props.variant]));
  for (const [label, variant] of Object.entries(variants)) {
    assert.notEqual(variant, 'critical', `"${label}" must not use the red reserved for Rejected/Failed`);
  }
  assert.equal(variants['Contact Missing'], 'warning', 'actionable labels are amber');
  assert.equal(variants['Needs Review'], 'warning');
  assert.equal(variants['Unclassified'], 'soft', 'informational labels are grey');
  assert.equal(mount(QualityBadges, { flags: [] }).render(), null, 'no labels, no markup');
});


/* M1 — honest loading and recovery (issue #34, PR #35). A failed read is a
   failed read: it is reported in place with a retry, it never becomes an
   empty list that reads as "nothing pending", and a retry never discards
   rows that did load. */
{
  const api = window.ARABTEC_API; const realGet = api.get;
  const deferred = () => { let resolve, reject; const promise = new Promise((res, rej) => { resolve = res; reject = rej; }); return { promise, resolve, reject }; };
  const RECRUITER = { id: 7, fullName: 'Rana Recruiter', roles: ['recruiter'], permissions: ['dashboard.view', 'request.view_own', 'interview.view_assigned'] };
  const DASH = { myWork: { myPendingOfferApprovals: 0 }, offersByStatus: [], aging: {}, kpis: {} };
  const now = new Date(Date.now() + 60000).toISOString(); // still today, still ahead of render time
  const REQUESTS = { requests: [{ id: 11, ticketNo: 'REQ-2026-0011', title: 'Site Engineer', status: 'sourcing', ownerId: 7, requesterId: 2, headcount: 1, priority: 'normal', health: { level: 'green', daysOpen: 3 }, pipeline: { total: 2 } }] };
  const INTERVIEWS = { interviews: [
    { id: 21, interviewNo: 'INT-21', status: 'completed', overallOutcome: null, scheduledAt: now, candidate: { fullName: 'Feedback Pending' }, request: { title: 'Site Engineer' } },
    { id: 22, interviewNo: 'INT-22', status: 'scheduled', scheduledAt: now, interviewType: 'hr', candidate: { fullName: 'Today Candidate' }, request: { title: 'Site Engineer' } },
  ] };
  const routes = (map) => { api.get = async (path) => { const key = path.startsWith('/requests') ? 'requests' : path.startsWith('/interviews') ? 'interviews' : path; const r = map[key]; if (r instanceof Error) throw r; return r; }; };
  const Dashboard = get('Dashboard'), KpiCard = get('KpiCard'), LoadError = get('LoadError'), RefetchError = get('RefetchError'), Empty = get('Empty');
  const SectionUnavailable = get("typeof SectionUnavailable === 'function' ? SectionUnavailable : () => null");
  const kpi = (tree, label) => nodes(persona(tree)).find((n) => n.type === KpiCard && n.props.label === label);
  const allClear = (tree) => nodes(persona(tree)).some((n) => n.type === Empty && n.props.art === 'all-clear');
  // The driver renders one component; child components stay as elements. Copy
  // therefore lives in props (Empty.text, ActionItem.title…), and the in-card
  // section state is expanded by calling it with the props it was given.
  const RecruiterDashboard = get('RecruiterDashboard');
  const persona = (tree) => tree && tree.type === RecruiterDashboard ? RecruiterDashboard(tree.props) : tree;
  const expand = (tree) => { const t = persona(tree); return [t, ...nodes(t).filter((n) => n.type === SectionUnavailable).map((n) => SectionUnavailable(n.props)).filter(Boolean)]; };
  const RoleRow = get('RoleRow');
  const view = (tree) => expand(tree).map((t) => text(t) + nodes(t).flatMap((n) => [...Object.values(n.props || {}).filter((v) => typeof v === 'string'), n.type === RoleRow ? n.props.r.title : '']).join('\n')).join('\n');
  // The primary retry is the page-level notice's; a section that has nothing
  // to show carries a light one as its <Empty> action. The driver's nodes()
  // walks children only, so both are read from props.
  const retry = (tree) => {
    const all = expand(tree).flatMap((t) => nodes(t));
    const notice = all.find((n) => n.type === RefetchError && n.props.onRetry);
    if (notice) return { props: { onClick: notice.props.onRetry } };
    return all.map((n) => n.type === Empty ? n.props.action : null).find((b) => b && text(b) === 'Retry');
  };
  const sectionMarked = (tree, what) => expand(tree).flatMap((t) => nodes(t)).some((n) => n.type === Empty && n.props.title === `${what} did not load`);
  const mountDash = async () => { const page = mount(Dashboard, { user: RECRUITER, onNavigate() {}, dash: DASH }); page.render(); await flush(); return page; };

  await check('dashboard: requests fail, interviews load — the failure is named in place, interviews stay usable, no "all clear"', async () => {
    routes({ requests: new Error('Requests service unavailable'), interviews: INTERVIEWS });
    const page = await mountDash(); let tree = page.render();
    assert.notEqual(tree.type, LoadError, 'one failed list must not take the whole page when the other loaded');
    const t = view(tree);
    assert.ok(t.includes('Could not load hiring requests'), 'the page names the failed list under its title');
    assert.ok(t.includes('Requests service unavailable'), 'the server reason is shown, not a generic message');
    assert.ok(sectionMarked(tree, 'Hiring requests'), 'a section that depends only on requests marks itself as not loaded');
    assert.ok(t.includes('did not load, so this list may be incomplete'), 'a mixed list that still has rows carries a caveat');
    assert.ok(retry(tree), 'a retry is offered');
    assert.equal(allClear(tree), false, 'a queue that could not be read never claims "nothing is waiting on you"');
    assert.ok(!t.includes('No open hiring requests are assigned to you'), 'a failed read is not an empty roles list');
    assert.ok(t.includes('Feedback Pending') && t.includes('Today Candidate'), 'interviews that loaded are still rendered and actionable');
    assert.ok(kpi(tree, 'Assigned open roles').props.unavailable, 'a KPI built only from requests shows no number');
    assert.ok(kpi(tree, 'Overdue actions').props.unavailable, 'a KPI needing both lists shows no number when one failed');
    assert.equal(kpi(tree, 'Interviews this week').props.unavailable, null, 'a KPI built only from interviews still counts');
    assert.equal(kpi(tree, 'Interviews this week').props.value, 1);
    // Retry re-reads and the section fills in without touching what loaded.
    routes({ requests: REQUESTS, interviews: INTERVIEWS });
    retry(tree).props.onClick(); await flush(); tree = page.render();
    assert.ok(view(tree).includes('Site Engineer') && !view(tree).includes('Could not load'), 'retry recovers the failed section');
    assert.ok(view(tree).includes('Today Candidate'), 'retry keeps the interviews that were already on screen');
    assert.equal(kpi(tree, 'Assigned open roles').props.value, 1);
    page.dispose();
  });

  await check('dashboard: interviews fail, requests load — roles render, the interview-dependent figures are withheld', async () => {
    routes({ requests: REQUESTS, interviews: new Error('Interview calendar timed out') });
    const page = await mountDash(); const tree = page.render();
    assert.notEqual(tree.type, LoadError);
    const t = view(tree);
    assert.ok(t.includes('Could not load interviews') && t.includes('Interview calendar timed out'));
    assert.ok(sectionMarked(tree, 'Interviews'), 'a queue with nothing else to show marks itself as not loaded');
    assert.ok(t.includes('Site Engineer'), 'the roles that loaded are shown');
    assert.equal(allClear(tree), false);
    assert.ok(kpi(tree, 'Interviews this week').props.unavailable);
    assert.ok(kpi(tree, 'Overdue actions').props.unavailable);
    assert.equal(kpi(tree, 'Assigned open roles').props.unavailable, null);
    assert.equal(kpi(tree, 'Assigned open roles').props.value, 1);
    page.dispose();
  });

  await check('dashboard: both lists failing takes the page with one retry; a genuinely empty result is still "all clear"', async () => {
    routes({ requests: new Error('down'), interviews: new Error('down') });
    let page = await mountDash(); let tree = page.render();
    assert.equal(tree.type, 'div'); assert.ok(nodes(tree).some((n) => n.type === LoadError), 'nothing usable loaded → page-level error');
    page.dispose();
    routes({ requests: { requests: [] }, interviews: { interviews: [] } });
    page = await mountDash(); tree = page.render();
    assert.equal(allClear(tree), true, 'an empty list that actually loaded is a real "nothing pending"');
    assert.equal(retry(tree), undefined);
    page.dispose();
  });

  await check('dashboard: a failed refresh keeps the loaded rows, marks them stale, and a superseded reload cannot overwrite a newer one', async () => {
    routes({ requests: REQUESTS, interviews: INTERVIEWS });
    const page = await mountDash(); let tree = page.render();
    assert.ok(view(tree).includes('Site Engineer'));
    routes({ requests: new Error('Refresh failed'), interviews: INTERVIEWS });
    tree.props.data.reload(); await flush(); tree = page.render();
    assert.ok(view(tree).includes('Site Engineer'), 'rows already on screen survive a failed refresh');
    const stale = nodes(persona(tree)).find((n) => n.type === RefetchError);
    assert.ok(stale && stale.props.text.includes('Could not refresh hiring requests'), 'the page says the rows may not be current');
    assert.equal(kpi(tree, 'Assigned open roles').props.value, 1, 'stale figures are shown as figures, not blanked');
    // Two overlapping reloads: the first answers last, with a failure, and must be ignored.
    const first = deferred(), second = deferred();
    let calls = 0; api.get = (path) => path.startsWith('/interviews') ? Promise.resolve(INTERVIEWS) : (++calls === 1 ? first.promise : second.promise);
    tree.props.data.reload(); tree.props.data.reload();
    second.resolve({ requests: [{ ...REQUESTS.requests[0], title: 'Newer answer' }] }); await flush(); tree = page.render();
    assert.ok(view(tree).includes('Newer answer') && !nodes(persona(tree)).some((n) => n.type === RefetchError));
    first.reject(new Error('late failure')); await flush(); tree = page.render();
    assert.ok(view(tree).includes('Newer answer') && !nodes(persona(tree)).some((n) => n.type === RefetchError), 'the late response from the superseded reload changed nothing');
    page.dispose();
  });

  const CandidateProfile = get('CandidateProfile');
  const candidate = (id, name) => ({ candidate: { id, fullName: name, candidateNo: 'C-' + id, applications: [], interviews: [], offers: [], tags: [], history: [] } });
  const profileProps = (id) => ({ id, user: { id: 1, permissions: [] }, btns: { edit_candidate: { visible: true } }, onBack() {}, onNavigate() {} });

  await check('candidate profile: a failed first load shows a retry (never an endless skeleton) and retry recovers', async () => {
    api.get = async () => { throw new Error('Candidate service unavailable'); };
    const page = mount(CandidateProfile, profileProps(1)); page.render(); await flush(); let tree = page.render();
    const err = nodes(tree).find((n) => n.type === LoadError);
    assert.ok(err, 'a failed first load is an explicit error state');
    assert.equal(err.props.text, 'Candidate service unavailable');
    assert.ok(nodes(tree).some((n) => n.props?.className === 'breadcrumb'), 'the way back is still offered');
    api.get = async () => candidate(1, 'Candidate One');
    await err.props.onRetry(); tree = page.render();
    assert.ok(text(tree).includes('Candidate One'));
    // A refresh that fails keeps the profile and says so, rather than blanking it.
    api.get = async () => { throw new Error('Refresh failed'); };
    button(tree, 'Edit').props.onClick(); tree = page.render();
    nodes(tree).find((n) => n.type === get('CandidateForm')).props.onSaved(); await flush(); tree = page.render();
    assert.ok(text(tree).includes('Candidate One'), 'the loaded profile survives a failed refresh');
    assert.ok(nodes(tree).some((n) => n.type === RefetchError));
    page.dispose();
  });

  await check('candidate profile: opening A then B shows B, even when A answers last', async () => {
    const a = deferred(), b = deferred();
    api.get = (path) => path.endsWith('/1') ? a.promise : b.promise;
    const page = mount(CandidateProfile, profileProps(1)); page.render();
    let tree = page.render(profileProps(2));
    assert.equal(nodes(tree).some((n) => n.type === get('Skeleton')), true, 'switching records shows a loading state, not the previous candidate');
    b.resolve(candidate(2, 'Candidate B')); await flush(); tree = page.render();
    assert.ok(text(tree).includes('Candidate B'));
    a.resolve(candidate(1, 'Candidate A')); await flush(); tree = page.render();
    assert.ok(text(tree).includes('Candidate B') && !text(tree).includes('Candidate A'), 'the late response for A never replaces B');
    page.dispose();
  });

  const AssessmentPanel = get('AssessmentPanel');
  const META = { scoreGuide: { 1: 'Poor', 5: 'Strong' }, behavioralCriteria: [{ key: 'b1', label: 'Openness' }], technicalCriteria: [{ key: 't1', label: 'Design' }], criticalFlags: [], decisions: [], fitLevels: [] };
  const BUNDLE = { assessment: { unlocked: true, hr: null, technical: null, finalDecision: null } };
  const assessRoutes = (meta, bundle) => { api.get = async (path) => { const r = path.endsWith('/meta') ? meta : bundle; if (r instanceof Error) throw r; return r; }; };

  await check('assessment panel: metadata, bundle and malformed-bundle failures each end in a retry, never a stuck skeleton', async () => {
    for (const [meta, bundle, expected] of [[new Error('Meta unavailable'), BUNDLE, 'Meta unavailable'], [META, new Error('Bundle unavailable'), 'Bundle unavailable'], [META, {}, 'no assessment']]) {
      assessRoutes(meta, bundle);
      const panel = mount(AssessmentPanel, { app: { id: 5 }, canFeedback: true }); panel.render(); await flush(); const tree = panel.render();
      assert.equal(nodes(tree).some((n) => n.type === get('Skeleton')), false, 'no skeleton after a settled failure');
      const err = nodes(tree).find((n) => n.type === LoadError);
      assert.ok(err && err.props.text.includes(expected), `explicit error for: ${expected}`);
      panel.dispose();
    }
    // Retry after a metadata failure renders the form with the approved criteria untouched.
    assessRoutes(new Error('Meta unavailable'), BUNDLE);
    const panel = mount(AssessmentPanel, { app: { id: 5 }, canFeedback: true }); panel.render(); await flush(); let tree = panel.render();
    assessRoutes(META, BUNDLE);
    await nodes(tree).find((n) => n.type === LoadError).props.onRetry(); tree = panel.render();
    const form = nodes(tree).find((n) => n.type === get('EvaluationForm'));
    assert.ok(form, 'retry recovers into the evaluation form');
    assert.deepEqual(form.props.meta.behavioralCriteria, META.behavioralCriteria, 'criteria come from the server metadata as-is');
    // A refresh that fails after a save keeps the form and reports it in place.
    assessRoutes(META, new Error('Refresh failed'));
    form.props.onSaved(); await flush(); tree = panel.render();
    assert.ok(nodes(tree).some((n) => n.type === get('EvaluationForm')), 'the loaded evaluation stays on screen');
    assert.ok(nodes(tree).some((n) => n.type === RefetchError), 'the failed refresh is visible');
    panel.dispose();
  });

  await check('assessment panel: a locked application says so even when the form metadata failed', async () => {
    assessRoutes(new Error('Meta unavailable'), { assessment: { unlocked: false } });
    const panel = mount(AssessmentPanel, { app: { id: 5 }, canFeedback: true }); panel.render(); await flush(); const tree = panel.render();
    assert.ok(view(tree).includes('unlocks once this candidate is moved to an interview stage'));
    assert.equal(nodes(tree).some((n) => n.type === LoadError), false, 'what did load is shown instead of an error the user cannot act on');
    panel.dispose();
  });

  api.get = realGet;
}


/* Approval surfaces: the HR Director's queue opens the record that needs the
   decision, the interviewer's queue opens the interview, and the offer page
   offers Approve/Reject only to a user who holds the director permission. */
{
  const api = window.ARABTEC_API; const realGet = api.get;
  const ActionItem = get('ActionItem');
  await check('director and interviewer dashboards deep-link to the record needing a decision', () => {
    const calls = [];
    const director = { id: 2, roles: ['hr_director'], permissions: ['dashboard.view', 'request.view_all', 'request.approve', 'offer.approve'] };
    const data = { d: { kpis: {}, aging: {}, offersByStatus: [{ status: 'pending_approval', count: 1 }] }, requests: [{ id: 44, ticketNo: 'REQ-2026-0044', title: 'Site Engineer', status: 'pending_approval', headcount: 1 }], interviews: [], unavailable: {}, sectionErrors: {}, loaded: {}, reload() {} };
    const tree = get('DirectorDashboard')({ user: director, data, onNavigate: (...a) => calls.push(a) });
    const items = nodes(tree).filter((n) => n.type === ActionItem);
    items.find((n) => n.props.cta === 'Open request').props.onCta();
    assert.equal(window.__atsPendingRequestId, 44, 'the request awaiting approval is opened by id');
    items.find((n) => n.props.cta === 'Open offers').props.onCta();
    // Objects born inside the vm realm have a different prototype, so compare by shape.
    assert.equal(JSON.stringify(calls[calls.length - 1]), JSON.stringify(['offers', { status: 'pending_approval' }]), 'the offers queue is filtered to those held for a decision');
    const iv = get('InterviewerDashboard')({ user: { id: 9, roles: ['interviewer'], permissions: [] }, data: { interviews: [{ id: 77, interviewNo: 'INT-77', status: 'completed', overallOutcome: null, scheduledAt: new Date().toISOString(), candidate: { fullName: 'C' }, request: { title: 'R' } }], unavailable: {} }, onNavigate: (...a) => calls.push(a) });
    nodes(iv).find((n) => n.type === ActionItem && n.props.cta === 'Open interview').props.onCta();
    assert.equal(JSON.stringify(calls[calls.length - 1]), JSON.stringify(['interviews', { openId: 77 }]), 'the interview needing feedback is opened by id');
  });

  await check('offer page: one approval layer — submit on draft, approve/reject only for the director, send only once approved', async () => {
    const buttons = ['submit_offer', 'approve_offer', 'reject_offer_approval', 'send_offer'].map((buttonKey) => ({ buttonKey, visible: true }));
    const offerOf = (status, extra = {}) => ({ offer: { id: 3, offerNo: 'OFR-3', status, candidate: { fullName: 'Cand' }, request: {}, approvals: [{ level: 1, name: 'HR Director', role_code: 'offer.approve_director', decision: status === 'pending_approval' ? 'pending' : 'approved' }], ...extra } });
    const director = { id: 2, permissions: ['offer.view', 'offer.approve', 'offer.approve_director'] };
    const manager = { id: 3, permissions: ['offer.view', 'offer.approve', 'offer.send'] };
    const render = async (status, user) => {
      api.get = async (path) => path.endsWith('/resolved') ? { buttons } : offerOf(status);
      const page = mount(get('OfferDetail'), { id: 3, user, onBack() {} }); page.render(); await flush(); const tree = page.render(); page.dispose(); return tree;
    };
    // The page's controls live in PageHead's `actions` prop, not in its children.
    const actionBtn = (tree, label) => { const ph = nodes(tree).find((n) => n.type === get('PageHead')); return ph && button(ph.props.actions, label); };
    let tree = await render('draft', manager);
    assert.ok(actionBtn(tree, 'Submit for approval'), 'a draft is submitted from the page');
    assert.equal(actionBtn(tree, 'Send Offer'), undefined, 'a draft cannot be sent: the server would refuse it');
    tree = await render('pending_approval', director);
    assert.ok(actionBtn(tree, 'Approve') && actionBtn(tree, 'Reject'), 'the director decides');
    tree = await render('pending_approval', manager);
    assert.equal(actionBtn(tree, 'Approve'), undefined, 'an HR Manager holding offer.approve but not the director permission is not offered a button that would 403');
    assert.ok(nodes(tree).flatMap((n) => Object.values(n.props || {}).filter((v) => typeof v === 'string')).join('\n').includes('Waiting on HR Director approval'), 'the page says whose decision it waits on');
    tree = await render('approved', manager);
    assert.ok(actionBtn(tree, 'Send Offer'), 'an approved offer can be sent');
  });
  api.get = realGet;
}

/* Polish pass: bulk move scope is honest, the candidate's current application
   is one line under the header, and the system admin can switch dashboards. */
{
  await check('bulk move summary: hidden rows are counted, only reachable stages are offered, only eligible rows move', () => {
    const summary = get('bulkSelectionSummary');
    const apps = [{ id: 1, status: 'matched' }, { id: 2, status: 'joined' }, { id: 3, status: 'sourced' }];
    const sum = summary({ selected: new Set([1, 2, 3]), apps, visibleApps: [apps[0], apps[2]], pending: new Set([3]), target: 'sourced' });
    assert.equal(sum.hidden.length, 1, 'the joined row is selected but hidden by the filters');
    assert.equal(sum.hidden[0].id, 2);
    assert.equal(sum.targets.includes('sourced'), false, 'a stage nobody can move to is not offered');
    const canMove = get('canPipelineMove');
    assert.ok(sum.targets.length > 0 && sum.targets.every((t) => [apps[0], apps[2]].some((a) => canMove(a.status, t))), 'every offered stage is reachable by at least one selected row');
    assert.equal(sum.target, sum.targets[0], 'an invalid destination falls back to the first reachable stage');
    const forward = sum.targets.find((t) => canMove('matched', t) && canMove('sourced', t));
    const later = summary({ selected: new Set([1, 2, 3]), apps, visibleApps: apps, pending: new Set([3]), target: forward });
    assert.equal(later.target, forward, 'a valid destination is kept');
    assert.equal(JSON.stringify(later.eligible.map((a) => a.id)), '[1]', 'the pending row and the locked row are excluded from the move');
    const none = summary({ selected: new Set([2]), apps, visibleApps: apps, pending: new Set(), target: 'offer' });
    assert.equal(none.targets.length, 0); assert.equal(none.target, ''); assert.equal(none.eligible.length, 0);
  });

  await check('candidate header names the current application, never a disqualified one, and shows no dead link', () => {
    const ApplicationContext = get('ApplicationContext'), current = get('currentApplication');
    const active = { id: 5, requestId: 9, ticketNo: 'REQ-2026-0009', position: 'Site Engineer', status: 'interviewing', recruiter: { name: 'Karim' }, lastActivityAt: '2026-09-01' };
    const rejected = { id: 4, requestId: 8, ticketNo: 'REQ-2026-0008', position: 'Old role', status: 'rejected' };
    assert.equal(current([rejected, active]).id, 5, 'history is never promoted to current');
    assert.equal(current([rejected]), null);
    const strings = (tree) => nodes(tree).flatMap((n) => Object.values(n.props || {}).filter((v) => typeof v === 'string')).join('\n') + text(tree);
    let tree = ApplicationContext({ application: active, count: 2, onOpenRequest: () => {} });
    assert.ok(strings(tree).includes('Site Engineer') && nodes(tree).some((n) => n.type === get('AppStatusBadge') && n.props.status === 'interviewing'));
    assert.ok(button(tree, 'Open request'), 'the request link is offered when the caller authorised it');
    tree = ApplicationContext({ application: active, count: 2, onOpenRequest: null });
    assert.equal(button(tree, 'Open request'), undefined, 'no link without authorisation');
    tree = ApplicationContext({ application: null, count: 1 });
    assert.ok(text(tree).includes('No active application'));
    tree = ApplicationContext({ application: null, count: 0 });
    assert.ok(text(tree).includes('Not linked'));
  });

  await check('system admin: director view by default, with tabs into every role\'s dashboard', async () => {
    const api = window.ARABTEC_API; const realGet = api.get;
    api.get = async (path) => path.startsWith('/requests') ? { requests: [] } : path.startsWith('/interviews') ? { interviews: [] } : { kpis: {}, aging: {}, offersByStatus: [], myWork: {} };
    const admin = { id: 1, roles: ['system_admin'], permissions: ['dashboard.view', 'request.view_all', 'interview.view_all'] };
    const page = mount(get('Dashboard'), { user: admin, onNavigate() {}, dash: { kpis: {}, aging: {}, offersByStatus: [], myWork: {} } });
    page.render(); await flush(); let tree = page.render();
    assert.equal(tree.type, get('DirectorDashboard'), 'the big picture is the default');
    const tabs = nodes(tree.props.notice).filter((n) => n.props?.role === 'tab');
    assert.deepEqual(tabs.map((t) => text(t)), ['Director', 'Executive', 'Recruitment manager', 'Recruiter', 'Interviewer']);
    tabs.find((t) => text(t) === 'Recruiter').props.onClick(); page.render(); await flush(); tree = page.render();
    assert.equal(tree.type, get('RecruiterDashboard'), 'the tab switches the composition');
    tabs.find((t) => text(t) === 'Interviewer').props.onClick(); page.render(); await flush(); tree = page.render();
    assert.equal(tree.type, get('InterviewerDashboard'));
    page.dispose();
    const recruiter = mount(get('Dashboard'), { user: { id: 7, roles: ['recruiter'], permissions: ['dashboard.view', 'request.view_own', 'interview.view_assigned'] }, onNavigate() {}, dash: { myWork: {}, offersByStatus: [] } });
    recruiter.render(); await flush(); tree = recruiter.render();
    assert.equal(nodes(tree.props.notice || []).some((n) => n.props?.role === 'tab'), false, 'a recruiter gets no view switcher');
    recruiter.dispose(); api.get = realGet;
  });
}

console.log(`\n=== UI BEHAVIOR: ${passed} passed ===\n`);
