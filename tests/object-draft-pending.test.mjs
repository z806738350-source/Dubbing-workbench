import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';

const compile=file=>ts.transpileModule(readFileSync(new URL(file,import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,jsx:ts.JsxEmit.React}}).outputText;
const url=source=>'data:text/javascript;base64,'+Buffer.from(source+'\n//'+crypto.randomUUID()).toString('base64');
const tick=()=>new Promise(resolve=>setImmediate(resolve));

async function fixture(t) {
  const descriptors=['localStorage','sessionStorage','navigator','window','CustomEvent'].map(name=>[name,Object.getOwnPropertyDescriptor(globalThis,name)]),storage=new Map(),window=new EventTarget();
  const local={getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)};
  for(const [name,value]of [['localStorage',local],['sessionStorage',{getItem:()=>null,setItem(){}}],['navigator',{onLine:true,locks:{}}],['window',window],['CustomEvent',class extends Event{constructor(name,options){super(name);this.detail=options.detail;}}]])Object.defineProperty(globalThis,name,{configurable:true,value});
  t.mock.timers.enable({apis:['setTimeout']});
  const draftsUrl=url(compile('../src/drafts.ts')),drafts=await import(draftsUrl),autosaveUrl=url(compile('../src/autosave.ts').replace('"./api"',JSON.stringify(url('export async function api(){throw Error("测试不能访问API")}')))),autosave=await import(autosaveUrl);
  const hooks=[],effects=[];let cursor=0,effectCursor=0,changed=false,mounted=true,controller,resolve,reject;
  const waiting=new Promise((yes,no)=>{resolve=yes;reject=no;}),saves=[];
  const runtime={useState:initial=>{const index=cursor++;if(!(index in hooks))hooks[index]=typeof initial==='function'?initial():initial;return[hooks[index],next=>{if(!mounted)return;const value=typeof next==='function'?next(hooks[index]):next;if(!Object.is(value,hooks[index])){hooks[index]=value;changed=true;}}];},useRef:initial=>hooks[cursor++]||={current:initial},useEffect:(callback,deps)=>{const index=effectCursor++,old=effects[index];if(!old||deps.some((value,i)=>!Object.is(value,old.deps[i])))effects[index]={...old,deps,callback,run:true};}};
  globalThis.objectDraftPendingTest=runtime;
  const source=compile('../src/ObjectDraft.tsx').replace(/^import .* from "(?:react|\.\/components)";\n/gm,'').replace('"./drafts"',JSON.stringify(draftsUrl)).replace('"./autosave"',JSON.stringify(autosaveUrl));
  const {useObjectDraft}=await import(url('const {useState,useRef,useEffect}=globalThis.objectDraftPendingTest;\n'+source));
  const props={value:{text:'工作区正文',incoming:0},revision:1},options={scope:'chapter:fixture',dependencies:['segment:one'],delay:20,persist:async(value,base,context)=>{saves.push({value:structuredClone(value),base,context});return saves.length===1?waiting:{value,revision:base+1};}};
  const render=()=>{if(!mounted)return controller;for(let attempt=0;attempt<8;attempt++){changed=false;cursor=effectCursor=0;controller=useObjectDraft('segment','one',props.value,props.revision,options);for(const effect of effects)if(effect.run){effect.run=false;effect.cleanup?.();effect.cleanup=effect.callback();}if(!changed)return controller;}throw Error('测试hook未收敛');};
  const advance=async()=>{t.mock.timers.tick(21);await tick();render();};
  const unmount=()=>{mounted=false;effects.forEach(effect=>effect.cleanup?.());};
  render();
  t.after(async()=>{resolve({value:saves[0]?.value || props.value,revision:2});await autosave.activeDraftSave(controller.key)?.catch(()=>{});unmount();autosave.cancelDraftSave(controller.key);for(const [name,descriptor]of descriptors)if(descriptor)Object.defineProperty(globalThis,name,descriptor);else delete globalThis[name];delete globalThis.objectDraftPendingTest;});
  return{props,options,saves,drafts,autosave,hooks,render,advance,unmount,resolve,reject,get controller(){return controller;}};
}

test('保存挂起与持续新快照不会重复挂等待flush，期间续写最终自动保存',async t=>{
  const f=await fixture(t);f.controller.edit({text:'第一次提交'});f.render();await f.advance();assert.equal(f.saves.length,1);assert.equal(f.controller.saving,true);
  const pending=f.hooks.find(hook=>hook?.current instanceof Promise),original=pending.current;let waiters=0;
  pending.current={then:(yes,no)=>{waiters++;return original.then(yes,no);}};
  f.controller.edit({text:'等待时继续编辑'});f.render();
  for(let index=1;index<=20;index++){f.props.value={...f.props.value,incoming:index};f.render();await f.advance();}
  assert.equal(f.saves.length,1);assert.equal(waiters,0,'保存期间不得为每次新快照创建等待flush闭包');assert.equal(f.controller.draft.text,'等待时继续编辑');
  f.resolve({value:f.saves[0].value,revision:2});await original;await tick();f.render();await f.advance();assert.equal(f.saves.length,2);assert.equal(f.saves[1].value.text,'等待时继续编辑');assert.equal(f.saves[1].base,2);assert.equal(f.controller.dirty,false);assert.equal(f.drafts.readDraft(f.controller.key),null);
});

test('未知保存回执与dirty卸载保持原操作和续写，恢复后继续保存而不丢数据',async t=>{
  const f=await fixture(t);f.controller.edit({text:'原请求'});f.render();await f.advance();f.controller.edit({text:'未确认后的续写'});f.render();
  const originalId=f.autosave.pendingSaveOperation(f.controller.key).id;f.reject(Object.assign(Error('回执未确认'),{retryClass:'check-existing-operation'}));await tick();f.render();f.unmount();
  assert.equal(f.autosave.hasLiveDraft(f.controller.key),true);assert.equal(f.autosave.pendingSaveOperation(f.controller.key).id,originalId);assert.equal(f.drafts.readDraft(f.controller.key).draft.value.text,'未确认后的续写');
  await f.autosave.flushRegisteredDraft(f.controller.key);assert.equal(f.saves[1].context.operationId,originalId);assert.equal(f.saves[1].context.replay,true);assert.equal(f.saves[1].value.text,'原请求');
  await f.advance();assert.equal(f.saves.at(-1).value.text,'未确认后的续写');assert.equal(f.drafts.readDraft(f.controller.key),null);assert.equal(f.autosave.hasLiveDraft(f.controller.key),false);
});
