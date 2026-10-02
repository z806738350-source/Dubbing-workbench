import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';

const source=readFileSync(new URL('../src/WorkspaceExperience.tsx',import.meta.url),'utf8');
const component=source.slice(source.indexOf('export function GeneratePlan('),source.indexOf('export function QuickHelp('));
const runtime=`const React={Fragment:'Fragment',createElement:(type,props,...children)=>({type,props:{...props,children}})},Dialog='Dialog',TaskAuthorization='TaskAuthorization';
const state=[];let cursor=0;const useState=value=>{const index=cursor++;if(!(index in state))state[index]=value;return[state[index],value=>{state[index]=typeof value==='function'?value(state[index]):value;}];};
export const render=props=>{cursor=0;return GeneratePlan(props);};`;
const compiled=ts.transpileModule(runtime+component,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,jsx:ts.JsxEmit.React}}).outputText;
const nodes=node=>!node||typeof node!=='object'?[]:[node,...nodes(node.props?.footer),...(node.props?.children||[]).flat(Infinity).flatMap(nodes)];
const words=node=>typeof node==='string'||typeof node==='number'?String(node):node&&typeof node==='object'?(node.props?.children||[]).flat(Infinity).map(words).join(''):'';
const button=(tree,label)=>nodes(tree).find(node=>node.type==='button'&&words(node).includes(label));
async function press(tree,label){const target=button(tree,label);assert.ok(target,label);assert.equal(!!target.props.disabled,false);target.props.onClick();await new Promise(resolve=>setImmediate(resolve));}
async function setup(overrides={}){
  const {render}=await import('data:text/javascript;base64,'+Buffer.from(compiled+'\n//'+crypto.randomUUID()).toString('base64'));
  const plan={chapterId:'chapter',revision:1,arrangement:1,unitIds:['one'],memberIds:['one'],units:[{unitId:'one',members:['one'],mode:'dry',reuse:false,audioId:null}],textRequests:0,audioRequests:1};
  let props={plan,chapter:{id:'chapter',projectId:'project',segments:[{id:'one',order:0,voiceId:'voice'},{id:'two',order:1,voiceId:'voice'}]},grantId:'grant',unknown:false,routeBlocked:false,retryUnknown:false,resumeRoute:false,busy:false,onGrant(){},onRetryUnknown(){},onResumeRoute(){},onGenerate:async()=>{},onRecheck:async()=>{},onClose(){},...overrides};
  return {tree:()=>render(props),update:value=>{props={...props,...value};},plan};
}

test('409 replaces the old start action; free recheck shows changed scope and requires a second explicit generation',async()=>{
  let submissions=0,rechecks=0,paid=0;
  const f=await setup({onGenerate:async()=>{submissions++;if(submissions===1)throw Object.assign(new Error('编排已变化'),{status:409});paid++;},onRecheck:async()=>{rechecks++;f.update({plan:{...f.plan,revision:2,arrangement:3,memberIds:['one','two'],units:[{unitId:'group',members:['one','two'],mode:'scene',reuse:false,audioId:null}]}});}});
  await press(f.tree(),'开始生成');let tree=f.tree();assert.match(words(tree),/内容已变化，本次未发送/);assert.equal(button(tree,'开始生成'),undefined);assert.equal(nodes(tree).some(node=>node.type==='TaskAuthorization'),false);assert.equal(submissions,1);assert.equal(paid,0);
  await press(tree,'重新核对生成范围');tree=f.tree();assert.equal(rechecks,1);assert.equal(submissions,1);assert.equal(paid,0);assert.match(words(tree),/已按当前内容重新核对/);assert.match(words(tree),/2 条台词/);assert.match(words(tree),/第 1、2 条 · 声音背景/);assert.ok(button(tree,'开始生成'));
  await press(tree,'开始生成');assert.equal(submissions,2);assert.equal(paid,1);
});
test('failed recheck keeps the old plan blocked and its error local without any new generation',async()=>{
  let submissions=0,rechecks=0;
  const f=await setup({onGenerate:async()=>{submissions++;throw Object.assign(new Error('内容已变化'),{status:409});},onRecheck:async()=>{rechecks++;throw new Error('连接未恢复，当前范围尚未重新核对');}});
  await press(f.tree(),'开始生成');await press(f.tree(),'重新核对生成范围');const tree=f.tree();assert.equal(submissions,1);assert.equal(rechecks,1);assert.equal(button(tree,'开始生成'),undefined);assert.ok(button(tree,'重新核对生成范围'));assert.match(words(tree),/连接未恢复，当前范围尚未重新核对/);
});
test('unknown remains an explicit fee decision and pending recheck cannot submit or recheck again',async()=>{
  let release,rechecks=0,submissions=0;
  const f=await setup({unknown:true,onGenerate:async()=>{submissions++;throw Object.assign(new Error('内容已变化'),{status:409});},onRecheck:async()=>{rechecks++;await new Promise(resolve=>{release=resolve;});}});
  assert.equal(button(f.tree(),'开始生成').props.disabled,true);f.update({retryUnknown:true});await press(f.tree(),'开始生成');
  await press(f.tree(),'重新核对生成范围');const pending=f.tree();assert.equal(button(pending,'正在重新核对').props.disabled,true);assert.equal(button(pending,'开始生成'),undefined);assert.equal(rechecks,1);assert.equal(submissions,1);release();await new Promise(resolve=>setImmediate(resolve));
});
test('rechecked all-reuse scope finishes with no paid start or authorization controls',async()=>{
  let submissions=0,closed=0;
  const f=await setup({onGenerate:async()=>{submissions++;throw Object.assign(new Error('内容已变化'),{status:409});},onRecheck:async()=>f.update({plan:{...f.plan,revision:2,arrangement:2,audioRequests:0,unitIds:[],units:f.plan.units.map(unit=>({...unit,reuse:true,audioId:'existing'}))}}),onClose:()=>{closed++;}});
  await press(f.tree(),'开始生成');await press(f.tree(),'重新核对生成范围');const tree=f.tree();assert.equal(button(tree,'开始生成'),undefined);assert.equal(nodes(tree).some(node=>node.type==='TaskAuthorization'),false);assert.match(words(tree),/无需发送新的配音请求/);assert.equal(submissions,1);await press(tree,'完成核对');assert.equal(closed,1);
});
