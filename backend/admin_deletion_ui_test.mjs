// Render the actual JSX with deterministic hooks; no business data or browser session.
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const Babel = require('../frontend/public/vendor/babel.min.js');
const source = fs.readFileSync(new URL('../frontend/public/app.jsx', import.meta.url), 'utf8');
const selected = new Set(['isSystemAdmin', 'can', 'CandidatePrivacyTab', 'BrandingLogoPanel', 'CustomFieldsPanel', 'ControlCenterPage']);
const ast = Babel.transform(source, { presets:['react'], ast:true, code:false }).ast;
const functions = ast.program.body.filter(n => n.type === 'FunctionDeclaration' && selected.has(n.id.name));
const code = Babel.transformFromAst({type:'File',program:{type:'Program',sourceType:'script',body:functions}}, null, {presets:['react']}).code;
let user, overrides={}, hook=0;
const React = {
  createElement:(type, props, ...children)=>({type,props:props||{},children}),
  useState: initial => { const i=hook++; return [Object.hasOwn(overrides,i) ? overrides[i] : typeof initial==='function' ? initial() : initial, ()=>{}]; },
  useEffect:()=>{}, useMemo:f=>f(), useCallback:f=>f, useRef:v=>({current:v}),
};
const box = {React,...React, useToast:()=>()=>{}, useApp:()=>({user}), window:{}, document:{getElementById:()=>({})},
  hasWhiteTextContrast:()=>true, fmtDate:()=>'', fmtDateShort:()=>'', Info:'Info', Badge:'Badge', Logo:'Logo', PageHead:'PageHead',
  ButtonsPanel:'ButtonsPanel', ButtonControlsPanel:'ButtonControlsPanel', NotificationsPanel:'NotificationsPanel', FeaturesPanel:'FeaturesPanel', BuiltinFieldsPanel:'BuiltinFieldsPanel', KnowledgeLinesPanel:'KnowledgeLinesPanel'};
// Inactive component branches still reference their JSX type at render time.
for (const match of source.matchAll(/function ([A-Z]\w*)\(/g)) box[match[1]]=match[1];
vm.createContext(box);vm.runInContext(code,box);
const orgSource=fs.readFileSync(new URL('../frontend/public/org-structure.jsx',import.meta.url),'utf8');
vm.runInContext(Babel.transform(orgSource,{presets:['react']}).code,box);
let passed=0;
const nodes=[{id:1,parentId:null,positionTitle:'QA Position',employeeName:'QA',nodeType:'employee_position',status:'active'}];
function text(n) { return n==null || n===false ? '' : Array.isArray(n) ? n.map(text).join('') : typeof n==='object' ? text(n.children) : String(n); }
function flatten(n) { return n==null || n===false ? [] : Array.isArray(n) ? n.flatMap(flatten) : typeof n==='object' ? [n,...flatten(n.children)] : []; }
function render(fn,props,state={}) {hook=0;overrides=state;return fn(props);}
function check(name,condition) {if(!condition)throw Error(name);passed++;}
for(const role of ['recruiter','recruitment_manager','hr_director','ceo','hr_manager','hiring_manager','technical_interviewer','viewer','system_admin']) {
  user={roles:[role],permissions:['candidate.delete','request.delete','candidate.privacy','app.manage_ui','system.manage','org_chart.manage']};
  const admin=role==='system_admin';
  check(role+' permission gate',box.can(user,'candidate.delete')===admin);
  let tree=render(box.CandidatePrivacyTab,{c:{},onChanged:()=>{}});
  check(role+' erasure visibility',text(tree).includes('Erase personal data')===admin);
  check(role+' consent retained',text(tree).includes('Mark consent given'));
  tree=render(box.BrandingLogoPanel,{user,branding:{logo_stored_name:'qa.png'}});
  check(role+' logo remove visibility',flatten(tree).some(n=>n.type==='button'&&text(n)==='Remove')===admin);
  tree=render(box.CustomFieldsPanel,{user},{1:[{fieldKey:'qa',label:'QA',fieldType:'text'}]});
  check(role+' custom field delete visibility',flatten(tree).some(n=>n.type==='button'&&text(n)==='Delete')===admin);
  // Full org page is evaluated, including the role-derived canDelete prop.
  box.window.ArabtecUseIsPhone=()=>true;
  tree=render(box.window.ArabtecOrgStructurePage,{user},{0:nodes});
  const drill=flatten(tree).find(n=>typeof n.type==='function'&&n.type.name==='OrgDrill');
  check(role+' mobile chart present',!!drill);
  const drillTree=render(drill.type,drill.props);
  check(role+' chart delete visibility',flatten(drillTree).some(n=>n.type==='button'&&text(n)==='Delete')===admin);
  check(role+' chart editing retained',text(drillTree).includes('Edit'));
}
console.log(`RESULT ${passed} UI rendering assertions passed`);
