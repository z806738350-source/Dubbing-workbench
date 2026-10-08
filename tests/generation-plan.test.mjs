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
  let props={plan,chapter:{id:'chapter',projectId:'project',segments:[{id:'one',order:0,voiceId:'voice'},{id:'two',order:1,voiceId:'voice'}]},grantId:'grant',unknown:false,routeBlocked:false,retryUnknown:false,resumeRoute:false,busy:false,onGrant(){},onRetryUnknown(){},onResumeRoute(){},onGenerate:async()=>{},onRecheck:async()=>{},onEdit(){},onClose(){},...overrides};
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
  let release,rechecks=0,submissions=0,decision;
  const f=await setup({unknown:true,onGenerate:async(_grant,flags)=>{submissions++;decision=flags;throw Object.assign(new Error('内容已变化'),{status:409});},onRecheck:async()=>{rechecks++;await new Promise(resolve=>{release=resolve;});}});
  const initial=f.tree();assert.equal(button(initial,'开始生成'),undefined);assert.equal(nodes(initial).some(node=>node.type==='input'&&node.props.type==='checkbox'),false);assert.match(words(initial),/可能重复计费/);assert.equal(submissions,0);await press(initial,'重新发送 1 次并继续');assert.deepEqual(decision,{retryUnknown:true,resumeRoute:false});
  await press(f.tree(),'重新核对生成范围');const pending=f.tree();assert.equal(button(pending,'正在重新核对').props.disabled,true);assert.equal(button(pending,'开始生成'),undefined);assert.equal(rechecks,1);assert.equal(submissions,1);release();await new Promise(resolve=>setImmediate(resolve));
});

test('unknown与接口恢复在同一张卡一次提交，具体flags不依赖第二次点击或旧state',async()=>{
  const calls=[];const f=await setup({unknown:true,routeBlocked:true,retryUnknown:false,resumeRoute:false,onGenerate:async(...args)=>calls.push(args)}),tree=f.tree();
  assert.equal(nodes(tree).some(node=>node.type==='input'&&node.props.type==='checkbox'),false);assert.match(words(tree),/接口曾因权限或额度问题暂停/);await press(tree,'重新发送 1 次并继续（同时恢复接口）');assert.deepEqual(calls,[[undefined,{retryUnknown:true,resumeRoute:true}]]);
});

test('具体决定卡一击按当前范围提交，无次数或24小时授权；失败留在原卡不扩大范围',async()=>{
  const calls=[];const f=await setup({unknown:true,routeBlocked:true,onGenerate:async(...args)=>{calls.push(args);throw new Error('测试接口暂不可用');}});
  await press(f.tree(),'重新发送');const tree=f.tree();assert.equal(nodes(tree).some(node=>node.type==='TaskAuthorization'||node.type==='input'&&node.props.type==='number'),false);assert.doesNotMatch(words(tree),/24小时|请求上限|沿用已有明确上限/);assert.ok(button(tree,'重新发送'));assert.match(words(tree),/测试接口暂不可用/);
  assert.deepEqual(calls,[[undefined,{retryUnknown:true,resumeRoute:true}]]);
});

test('直接生成遇409初次打开失效卡，免费重核对后才允许当前范围的明确提交',async()=>{
  let submissions=0,rechecks=0;const f=await setup({invalidated:true,onGenerate:async()=>{submissions++;},onRecheck:async()=>{rechecks++;}});
  assert.equal(button(f.tree(),'开始生成'),undefined);assert.ok(button(f.tree(),'重新核对生成范围'));assert.match(words(f.tree()),/内容已变化，本次未发送/);
  await press(f.tree(),'重新核对生成范围');assert.equal(rechecks,1);assert.equal(submissions,0);await press(f.tree(),'开始生成');assert.equal(submissions,1);
});
test('rechecked all-reuse scope finishes with no paid start or authorization controls',async()=>{
  let submissions=0,closed=0;
  const f=await setup({onGenerate:async()=>{submissions++;throw Object.assign(new Error('内容已变化'),{status:409});},onRecheck:async()=>f.update({plan:{...f.plan,revision:2,arrangement:2,audioRequests:0,unitIds:[],units:f.plan.units.map(unit=>({...unit,reuse:true,audioId:'existing'}))}}),onClose:()=>{closed++;}});
  await press(f.tree(),'开始生成');await press(f.tree(),'重新核对生成范围');const tree=f.tree();assert.equal(button(tree,'开始生成'),undefined);assert.equal(nodes(tree).some(node=>node.type==='TaskAuthorization'),false);assert.match(words(tree),/无需发送新的配音请求/);assert.equal(submissions,1);await press(tree,'完成核对');assert.equal(closed,1);
});

test('847字符单句和长组按整段提示，返回编辑不提交生成',async()=>{
  for(const grouped of [false,true]){
    let generated=0;const edited=[];
    const chapter={id:'chapter',projectId:'project',segments:grouped
      ? [{id:'one',order:0,text:'声'.repeat(200)},{id:'two',order:1,text:'音'.repeat(200)}]
      : [{id:'one',order:0,text:'字'.repeat(846)+'😀'}]};
    const f=await setup({chapter,onGenerate:async()=>{generated++;},onEdit:id=>edited.push(id)});
    if(grouped)f.update({plan:{...f.plan,memberIds:['one','two'],units:[{unitId:'group',members:['one','two'],mode:'dry',reuse:false,audioId:null}]}});
    const tree=f.tree(),note=nodes(tree).find(node=>node.props.role==='note');assert.ok(note);
    assert.match(words(note),grouped?/共 400 字符/:/共 847 字符/);assert.match(words(note),/字数不是精确时长预测/);
    if(grouped)assert.match(words(note),/一起演绎需先缩小整段范围/);
    await press(note,'返回编辑');assert.deepEqual(edited,['one']);assert.equal(generated,0);
  }
});

test('慢语速长段提前提示，普通350字符短段不警告',async()=>{
  const chapter={id:'chapter',projectId:'project',segments:[{id:'one',order:0,text:'声'.repeat(300),config:{speech_rate:-50}}]};
  const slow=await setup({chapter});assert.match(words(nodes(slow.tree()).find(node=>node.props.role==='note')),/共 300 字符/);
  const normal=await setup({chapter:{...chapter,segments:[{...chapter.segments[0],text:'声'.repeat(350),config:{speech_rate:0}}]}});
  assert.equal(nodes(normal.tree()).some(node=>node.props.role==='note'),false);assert.equal(button(normal.tree(),'返回编辑'),undefined);
});

test('长段已有声音直接复用，不显示时长警告或返回编辑动作',async()=>{
  let generated=0;
  const f=await setup({chapter:{id:'chapter',projectId:'project',segments:[{id:'one',order:0,text:'字'.repeat(847)}]},onGenerate:async()=>{generated++;}});
  f.update({plan:{...f.plan,audioRequests:0,unitIds:[],units:f.plan.units.map(unit=>({...unit,reuse:true,audioId:'existing'}))}});
  const tree=f.tree();assert.equal(nodes(tree).some(node=>node.props.role==='note'),false);assert.equal(button(tree,'返回编辑'),undefined);
  assert.equal(button(tree,'开始生成'),undefined);assert.equal(generated,0);
});

test('计划失效后隐藏旧长段提示，只保留免费重核对，不再返回旧编辑范围',async()=>{
  let generated=0,edited=0;
  const f=await setup({chapter:{id:'chapter',projectId:'project',segments:[{id:'one',order:0,text:'字'.repeat(847)}]},onGenerate:async()=>{generated++;throw Object.assign(new Error('内容已变化'),{status:409});},onEdit:()=>{edited++;}});
  assert.ok(button(f.tree(),'返回编辑'));await press(f.tree(),'开始生成');const tree=f.tree();
  assert.equal(nodes(tree).some(node=>node.props.role==='note'),false);assert.equal(button(tree,'返回编辑'),undefined);
  assert.ok(button(tree,'重新核对生成范围'));assert.equal(generated,1);assert.equal(edited,0);
});


test('生成确认范围内显示共用并发入口，纯复用与失效计划不显示',async()=>{
 const concurrency={type:'ConcurrencySettings',props:{children:['同时制作：3 段']}},f=await setup({concurrency,onGenerate:async()=>{throw Object.assign(Error('旧计划'),{status:409});}});
 assert.ok(nodes(f.tree()).includes(concurrency));await press(f.tree(),'开始生成');assert.ok(!nodes(f.tree()).includes(concurrency));
 const reused=await setup({concurrency});reused.update({plan:{...reused.plan,audioRequests:0}});assert.ok(!nodes(reused.tree()).includes(concurrency));
});
