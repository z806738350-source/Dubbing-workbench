import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';

const source=readFileSync(new URL('../src/VoiceCreation.tsx',import.meta.url),'utf8');
const editor=source.slice(source.indexOf('function SessionEditor('),source.indexOf('function CandidateCard('));
const compiled=ts.transpileModule(editor+'\nexport {SessionEditor};',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,jsx:ts.JsxEmit.React}}).outputText;
const nodes=node=>!node||typeof node!=='object'?[]:[node,...(node.props?.children||[]).flat(Infinity).flatMap(nodes)];
const words=node=>typeof node==='string'||typeof node==='number'?String(node):node&&typeof node==='object'?(node.props?.children||[]).flat(Infinity).map(words).join(''):'';
const button=(tree,label)=>nodes(tree).find(node=>node.type==='button'&&words(node).includes(label));
const props={draftId:'new-role',enabled:true,configured:true,audioTools:true,routeBlocked:false,voices:[],projectId:'project',created(){},refresh:async()=>{}};
const job=(id,status,sessionId)=>({id,status,sessionId,createdAt:'2026-10-02T10:00:00Z'});
const session={id:'voice-session',revision:1,state:'active',description:'自拟声音描述',candidates:[]};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const check=(tree,label)=>nodes(nodes(tree).find(node=>node.type==='label'&&words(node).includes(label))).find(node=>node.type==='input');
let sequence=0;
async function setup(overrides={},operation=async()=>({outcome:'processing'})){
  let index=0;const hooks=[],sent=[],actions=[];
  const runtime={React:{Fragment:'Fragment',createElement:(type,props,...children)=>({type,props:{...props,children}})},Field:'Field',TaskAuthorization:'TaskAuthorization',ObjectDraftTools:'ObjectDraftTools',CandidateCard:'CandidateCard',labels:{queued:'排队中',running:'生成中',unknown:'结果不明，可能已计费'},sample:'自拟样文',
    useState:initial=>{const key=index++;if(!(key in hooks))hooks[key]=typeof initial==='function'?initial():initial;return [hooks[key],value=>{hooks[key]=typeof value==='function'?value(hooks[key]):value;}];},
    useRef:initial=>{const key=index++;return hooks[key]||={current:initial};},useEffect(){},
    useObjectDraft:()=>({draft:{description:'自拟声音描述'},composing:false,flush:async()=>({targetId:session.id,revision:1,dirty:false})}),
    action:async(...args)=>actions.push(args),submitOperation:async(...args)=>{sent.push(args);return operation(...args);},saveAction:async()=>session,
  };
  globalThis.voiceCreationRuntime=runtime;
  const header='const {React,Field,TaskAuthorization,ObjectDraftTools,CandidateCard,labels,sample,useState,useEffect,useRef,useObjectDraft,action,submitOperation,saveAction}=globalThis.voiceCreationRuntime;\n';
  const {SessionEditor}=await import('data:text/javascript;base64,'+Buffer.from(header+compiled+'\n// test '+sequence++).toString('base64'));
  const currentProps={...props,jobs:[],...overrides};
  return {props:currentProps,sent,actions,runtime,render:()=>{index=0;return SessionEditor(currentProps);}};
}

for(const status of ['unknown','running'])test(`unsaved description does not inherit unrelated chapter ${status} task or its stop action`,async()=>{
  const f=await setup({jobs:[job('chapter-job',status)]}),tree=f.render();
  assert.equal(nodes(tree).some(node=>node.type==='label'&&words(node).includes('上次结果不明')),false);
  assert.equal(button(tree,'停止后续请求'),undefined);assert.ok(button(tree,'生成一个候选'));
  assert.equal(nodes(tree).find(node=>node.type==='TaskAuthorization').props.disabled,false);
});
test('the actual voice session unknown still shows an unchecked explicit fee decision',async()=>{
  const f=await setup({session,jobs:[job('chapter-running','running'),job('candidate-unknown','unknown',session.id)]}),tree=f.render();
  const warning=nodes(tree).find(node=>node.type==='label'&&words(node).includes('上次结果不明'));assert.ok(warning);
  assert.equal(nodes(warning).find(node=>node.type==='input').props.checked,false);assert.equal(button(tree,'生成一个候选').props.disabled,true);assert.equal(button(tree,'停止后续请求'),undefined);
});
test('the stop action is scoped only to the current voice session running task',async()=>{
  let refreshed=0;const f=await setup({session,jobs:[job('other-running','running','another-session'),job('chapter-unknown','unknown'),job('own-running','running',session.id)],refresh:async()=>{refreshed++;}}),tree=f.render();
  assert.equal(nodes(tree).some(node=>node.type==='label'&&words(node).includes('上次结果不明')),false);assert.ok(button(tree,'生成中'));
  button(tree,'停止后续请求').props.onClick();await tick();
  assert.deepEqual(f.actions,[['job.stop',{id:'own-running'}]]);assert.equal(refreshed,1);
});

test('paused candidate keeps its grant but needs a separate explicit route decision for each attempt',async()=>{
  const f=await setup({session,routeBlocked:true});nodes(f.render()).find(node=>node.type==='TaskAuthorization').props.onReady('grant');
  let tree=f.render(),submit=button(tree,'生成一个候选');assert.equal(submit.props.disabled,true);assert.equal(check(tree,'恢复本次声音请求').props.checked,false);
  submit.props.onClick();await tick();assert.equal(f.sent.length,0,'The handler also protects a stale or forced click');
  check(f.render(),'恢复本次声音请求').props.onChange({target:{checked:true}});assert.equal(f.sent.length,0);
  submit=button(f.render(),'生成一个候选');assert.equal(submit.props.disabled,false);submit.props.onClick();await tick();
  assert.equal(f.sent.length,1);assert.equal(f.sent[0][1].resumeRoute,true);assert.equal(f.sent[0][1].grantId,'grant');assert.equal(f.sent[0][1].sessionId,session.id);assert.equal(f.sent[0][1].retryUnknown,undefined);
  tree=f.render();assert.equal(check(tree,'恢复本次声音请求').props.checked,false);assert.equal(button(tree,'生成一个候选').props.disabled,true);
  button(tree,'生成一个候选').props.onClick();await tick();assert.equal(f.sent.length,1);
});

test('candidate route recovery does not stand in for unknown retry, and failure clears its route decision',async()=>{
  const f=await setup({session,routeBlocked:true,jobs:[job('candidate-unknown','unknown',session.id)]},async()=>({error:'测试接口仍被暂停'}));nodes(f.render()).find(node=>node.type==='TaskAuthorization').props.onReady('grant');
  check(f.render(),'恢复本次声音请求').props.onChange({target:{checked:true}});assert.equal(button(f.render(),'生成一个候选').props.disabled,true);
  assert.equal(f.sent.length,0,'Checking route recovery does not submit the unchecked unknown request');
  check(f.render(),'恢复本次声音请求').props.onChange({target:{checked:true}});check(f.render(),'上次结果不明').props.onChange({target:{checked:true}});
  const submit=button(f.render(),'生成一个候选');assert.equal(submit.props.disabled,false);submit.props.onClick();await tick();
  assert.equal(f.sent.length,1);assert.equal(f.sent[0][1].resumeRoute,true);assert.equal(f.sent[0][1].retryUnknown,true);assert.equal(f.sent[0][1].grantId,'grant');
  assert.equal(check(f.render(),'恢复本次声音请求').props.checked,false);
  assert.equal(button(f.render(),'生成一个候选').props.disabled,true);assert.match(words(f.render()),/测试接口仍被暂停/);assert.equal(f.sent.length,1);
});
