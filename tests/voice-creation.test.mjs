import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';

const source=readFileSync(new URL('../src/VoiceCreation.tsx',import.meta.url),'utf8');
const editor=source.slice(source.indexOf('function SessionEditor('),source.indexOf('function CandidateCard('));
const runtime=`const React={Fragment:'Fragment',createElement:(type,props,...children)=>({type,props:{...props,children}})},Field='Field',TaskAuthorization='TaskAuthorization',ObjectDraftTools='ObjectDraftTools',CandidateCard='CandidateCard';
const labels={queued:'排队中',running:'生成中',unknown:'结果不明，可能已计费'},sample='自拟样文';
const useState=value=>[typeof value==='function'?value():value,()=>{}],useEffect=()=>{},useRef=value=>({current:value});
const useObjectDraft=()=>({draft:{description:'自拟声音描述'},composing:false}),action=(...args)=>globalThis.voiceCreationAction(...args);
export const render=props=>SessionEditor(props);`;
const compiled=ts.transpileModule(runtime+editor,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,jsx:ts.JsxEmit.React}}).outputText;
const {render}=await import('data:text/javascript;base64,'+Buffer.from(compiled).toString('base64'));
const nodes=node=>!node||typeof node!=='object'?[]:[node,...(node.props?.children||[]).flat(Infinity).flatMap(nodes)];
const words=node=>typeof node==='string'||typeof node==='number'?String(node):node&&typeof node==='object'?(node.props?.children||[]).flat(Infinity).map(words).join(''):'';
const button=(tree,label)=>nodes(tree).find(node=>node.type==='button'&&words(node).includes(label));
const props={draftId:'new-role',enabled:true,configured:true,audioTools:true,routeBlocked:false,voices:[],projectId:'project',created(){},refresh:async()=>{}};
const job=(id,status,sessionId)=>({id,status,sessionId,createdAt:'2026-10-02T10:00:00Z'});
const session={id:'voice-session',revision:1,state:'active',description:'自拟声音描述',candidates:[]};

for(const status of ['unknown','running'])test(`unsaved description does not inherit unrelated chapter ${status} task or its stop action`,()=>{
  const tree=render({...props,jobs:[job('chapter-job',status)]});
  assert.equal(nodes(tree).some(node=>node.type==='label'&&words(node).includes('上次结果不明')),false);
  assert.equal(button(tree,'停止后续请求'),undefined);assert.ok(button(tree,'生成一个候选'));
  assert.equal(nodes(tree).find(node=>node.type==='TaskAuthorization').props.disabled,false);
});
test('the actual voice session unknown still shows an unchecked explicit fee decision',()=>{
  const tree=render({...props,session,jobs:[job('chapter-running','running'),job('candidate-unknown','unknown',session.id)]});
  const warning=nodes(tree).find(node=>node.type==='label'&&words(node).includes('上次结果不明'));assert.ok(warning);
  assert.equal(nodes(warning).find(node=>node.type==='input').props.checked,false);assert.equal(button(tree,'生成一个候选').props.disabled,true);assert.equal(button(tree,'停止后续请求'),undefined);
});
test('the stop action is scoped only to the current voice session running task',async()=>{
  const calls=[];let refreshed=0;globalThis.voiceCreationAction=async(...args)=>{calls.push(args);};
  const tree=render({...props,session,jobs:[job('other-running','running','another-session'),job('chapter-unknown','unknown'),job('own-running','running',session.id)],refresh:async()=>{refreshed++;}});
  assert.equal(nodes(tree).some(node=>node.type==='label'&&words(node).includes('上次结果不明')),false);assert.ok(button(tree,'生成中'));
  button(tree,'停止后续请求').props.onClick();await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(calls,[['job.stop',{id:'own-running'}]]);assert.equal(refreshed,1);
});
