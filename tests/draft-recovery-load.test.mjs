import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import ts from 'typescript';
import {openStore} from '../server/store.mjs';
import {locateDraftChapters} from '../server/workspace.mjs';

test('200章恢复只定位请求的对象摘要，不读取整章正文与历史',t=>{
  const directory=mkdtempSync(join(tmpdir(),'draft-locate-')),store=openStore(directory);
  t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
  for(let i=0;i<200;i++)store.put('chapters',{id:'c'+i,projectId:'p',title:'第'+i+'章',source:'大段正文'.repeat(10000)},'p');
  store.put('segments',{id:'s',chapterId:'c198',roleId:'role',order:8,text:'只需用于定位的短台词'.repeat(100)},'c198');
  store.put('units',{id:'u',chapterId:'c198',kind:'group',state:'active',variants:{scene:{history:Array(100).fill('历史')}},members:['s']},'c198');
  store.put('events',{id:'e',unitId:'u',chapterId:'c198',description:'水滴音'.repeat(100)},'u');
  const summary=locateDraftChapters(store,['s','unit-v1/u/dry','sound-event-v1/e','unit-v1/new-c199','voice-session-v1/new-voice-context/s','voice-session-v1/new-voice-context','gone']);
  assert.equal(summary.length,2);assert.deepEqual(summary.map(c=>c.id),['c198','c199']);
  assert.equal(summary[0].segments.length,1);assert.equal(summary[0].segments[0].text.length,24);assert.equal(summary[0].events[0].description.length,24);
  assert.deepEqual(summary[0].units,[{id:'u',kind:'group',state:'active'}]);assert.ok(Buffer.byteLength(JSON.stringify(summary))<1000);
  assert.throws(()=>locateDraftChapters(store,Array(1001).fill('s')),/范围无效/);
  assert.throws(()=>locateDraftChapters(store,[null]),/范围无效/);
  assert.equal(store.get('chapters','c198').source,'大段正文'.repeat(10000));
});

const source=readFileSync(new URL('../src/WorkspaceExperience.tsx',import.meta.url),'utf8').replace(/^import .*;\n/gm,'');
const compiled=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,jsx:ts.JsxEmit.React}}).outputText;
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const nodes=node=>!node||typeof node!=='object'?[]:[node,...(node.props?.children||[]).flat(Infinity).flatMap(nodes)];
const words=node=>node==null||typeof node==='boolean'?'':typeof node==='object'?(node.props?.children||[]).flat(Infinity).map(words).join(''):String(node);
async function setup(drafts,read=async()=>[]){
  let index=0;const hooks=[],effects=[],requests=[],writes=[];
  const runtime={React:{createElement:(type,props,...children)=>({type,props:{...props,children}})},Dialog:'Dialog',Status:'Status',
    useState(value){const key=index++;if(!(key in hooks))hooks[key]=typeof value==='function'?value():value;return[hooks[key],next=>{writes.push(key);hooks[key]=typeof next==='function'?next(hooks[key]):next;}];},
    useRef(value){const key=index++;return hooks[key]||={current:value};},useEffect(fn){effects.push(fn);},listAllDrafts:async()=>drafts,
    api:async(...args)=>{requests.push(args);return read(...args);}};
  globalThis.recoveryRuntime=runtime;
  const header='const {React,Dialog,Status,useState,useRef,useEffect,listAllDrafts,api}=globalThis.recoveryRuntime;\n';
  const module=await import('data:text/javascript;base64,'+Buffer.from(header+compiled+'\n//'+crypto.randomUUID()).toString('base64'));
  const props={chapter:null,state:{chapters:Array.from({length:200},(_,i)=>({id:'c'+i})),projects:[],roles:[],voiceSessions:[]},onClose(){},onRecovered(){}};
  const render=()=>{index=0;return module.RecoveryCenter(props);};render();const cleanup=effects[0]();
  return{render,requests,writes,preview:value=>{index=100;return module.DraftPreview({value});},unmount:()=>cleanup?.()};
}
test('无草稿的200章恢复中心不请求任何章节',async()=>{
  const f=await setup([]);await tick();assert.equal(f.requests.length,0);assert.match(words(f.render()),/没有未保存的暂存/);f.unmount();
});
test('恢复中心只传兼容对象ID一次，关闭真实中止且迟到响应不更新状态',async()=>{
  let resolve;const drafts=[{id:'unit-v1/u/dry',entry:{key:'d1',compatible:true,status:'current',data:{draft:{value:{}},revision:1}}},{id:'foreign',entry:{key:'d2',compatible:false,status:'orphan',data:{draft:{},revision:1}}}];
  const f=await setup(drafts,()=>new Promise(done=>resolve=done));await tick();assert.equal(f.requests.length,1);assert.equal(f.requests[0][0],'/drafts/locate');assert.deepEqual(f.requests[0][1],{ids:['unit-v1/u/dry']});
  const signal=f.requests[0][3].signal;assert.equal(signal.aborted,false);f.unmount();assert.equal(signal.aborted,true);
  const count=f.writes.length;resolve([{id:'c1',projectId:'p',title:'迟到章',segments:[],units:[],events:[]}]);await tick();assert.equal(f.writes.length,count);
});
test('恢复预览仅在展开时序列化正文，关闭释放预览但原草稿仍可再次查看',async()=>{
  const f=await setup([]);let serialized=0;const value={text:'原始暂存'.repeat(10000),toJSON(){serialized++;return {text:this.text};}};
  let preview=f.preview(value);assert.equal(serialized,0);assert.equal(nodes(preview).some(n=>n.type==='pre'),false);
  preview.props.onToggle({currentTarget:{open:true}});preview=f.preview(value);assert.equal(serialized,1);assert.ok(words(preview).includes(value.text));
  preview.props.onToggle({currentTarget:{open:false}});preview=f.preview(value);assert.equal(serialized,1);assert.equal(nodes(preview).some(n=>n.type==='pre'),false);
  preview.props.onToggle({currentTarget:{open:true}});assert.ok(words(f.preview(value)).includes(value.text));assert.equal(serialized,2);f.unmount();
});
