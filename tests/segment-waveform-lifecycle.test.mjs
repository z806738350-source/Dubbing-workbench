import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';

const source=readFileSync(new URL('../src/SegmentWaveform.tsx',import.meta.url),'utf8').replace(/^import .*;\n/gm,'');
const compiled=ts.transpileModule(source+'\nexport {WaveformEditor};',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,jsx:ts.JsxEmit.React}}).outputText;
const nodes=node=>!node||typeof node!=='object'?[]:[node,...(node.props?.children||[]).flat(Infinity).flatMap(nodes)];
const words=node=>node==null?'':typeof node==='object'?(node.props?.children||[]).flat(Infinity).map(words).join(''):String(node);
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const range=audioId=>({id:'range-'+audioId,projectId:'project',chapterId:'chapter',unitId:'unit',mode:'dry',audioId,sourceHash:'source-'+audioId,decodeProfile:'pcm-v1',sampleRate:48000,channels:1,sourceFrames:48000,startFrame:0,endFrame:48000,revision:0,lastOperationId:''});
function events(){const handlers=new Map();return {devicePixelRatio:1,addEventListener(type,fn){if(!handlers.has(type))handlers.set(type,new Set());handlers.get(type).add(fn);},removeEventListener(type,fn){handlers.get(type)?.delete(fn);},dispatch(type){for(const fn of handlers.get(type)||[])fn({type});},count:()=>[...handlers.values()].reduce((total,value)=>total+value.size,0)};}
function canvas(){const context={setTransform(){},clearRect(){},fillRect(){},strokeRect(){},beginPath(){},moveTo(){},lineTo(){},stroke(){}};return {width:0,height:0,clientWidth:200,getBoundingClientRect:()=>({width:200,height:72,left:0}),getContext:()=>context};}
async function setup({editor=false,read=async()=>({range:range('A'),editable:true})}={}){
  let index=0,effectIndex=0;const hooks=[],effects=[],queued=[],controllers=[],registered=[],reads=[],window=events(),local=new Map();
  const runtime={React:{Fragment:'Fragment',createElement:(type,props,...children)=>({type,props:{...props,children}})},window,localStorage:{getItem:key=>local.get(key)||null,setItem:(key,value)=>local.set(key,value)},sessionStorage:{getItem:()=> 'page'},
    useState(value){const key=index++;if(!(key in hooks))hooks[key]=typeof value==='function'?value():value;return [hooks[key],next=>hooks[key]=typeof next==='function'?next(hooks[key]):next];},useRef(value){const key=index++;return hooks[key]||={current:value};},
    useEffect(fn,deps){const key=effectIndex++,old=effects[key];if(!old||deps.some((value,i)=>!Object.is(value,old.deps[i])))queued.push(()=>{old?.cleanup?.();effects[key]={deps,cleanup:fn()};});},
    IntersectionObserver:class {constructor(callback){this.callback=callback;}observe(){this.callback([{isIntersecting:true}]);}disconnect(){}},ResizeObserver:class {constructor(callback){this.callback=callback;}observe(){this.callback();}disconnect(){}},
    api:async (path,_body,_method,options)=>{reads.push(path);return read(path,options);},draftWorkspace:()=> 'workspace',readDraft:()=>null,writeDraft(){},clearDraft(){},listDrafts:async()=>[],recoverDraft:async()=>{},discardDraft:async()=>{},
    registerDraftSave:(key,saver)=>{registered.push({key,saver});return()=>{};},
    createAudioRangeSave(options){let saved=options.range;const controller={options,key:'range/'+saved.audioId,connect(){},release(){controller.released=true;},snapshot:()=>({range:saved,savedRange:saved,status:'saved',dirty:false,error:''}),dirty:()=>false,start(){},flush:async()=>{},refresh(value){if(value.audioId===options.range.audioId)saved=value;},edit(){},choose(){},restoreDraft(){}};controllers.push(controller);return controller;},normalizeRange:value=>value,
    fetch:async url=>{const audioId=decodeURIComponent(url.split('/audios/')[1].split('/')[0]);return {ok:true,json:async()=>({audioId,sourceHash:'source-'+audioId,decodeProfile:'pcm-v1',startFrame:0,endFrame:48000,bucketFrames:48000,buckets:[{min:[-.25],max:[.5]}]})};},
  };
  globalThis.waveLifecycle=runtime;
  const header='const {React,window,localStorage,sessionStorage,useState,useRef,useEffect,IntersectionObserver,ResizeObserver,api,draftWorkspace,readDraft,writeDraft,clearDraft,listDrafts,recoverDraft,discardDraft,registerDraftSave,createAudioRangeSave,normalizeRange,fetch}=globalThis.waveLifecycle;\n';
  const module=await import('data:text/javascript;base64,'+Buffer.from(header+compiled+'\n//'+crypto.randomUUID()).toString('base64'));
  const f={props:{unitId:'unit',mode:'dry',audioId:'A',chapterId:'chapter',projectId:'project',workspaceId:'workspace',result:{range:range('A'),editable:true}},window,controllers,registered,reads,
    render(){index=effectIndex=0;const tree=(editor?module.WaveformEditor:module.default)(f.props);for(const node of nodes(tree))if(node.props?.ref&&node.props.ref.current===null)node.props.ref.current=canvas();for(const effect of queued.splice(0))effect();return tree;},unmount(){for(const effect of effects)effect?.cleanup?.();}};
  return f;
}

test('实际稳定controller在rerender后调用最新回调，目标仍固定原audio，unmount移除listener',async()=>{
  const old=[],latest=[],preview=[],saved=[];const f=await setup({editor:true});
  Object.assign(f.props,{onRangeChange:()=>old.push('old'),onSaved:()=>old.push('saved'),onPreview:()=>old.push('preview')});f.render();await tick();f.render();
  const controller=f.controllers[0];Object.assign(f.props,{onRangeChange:value=>latest.push(value.audioId),onSaved:value=>saved.push(value.audioId),onPreview:value=>preview.push(value.audioId)});const tree=f.render();
  controller.options.onChange({range:range('A'),savedRange:range('A'),status:'saved',dirty:false,error:''});controller.options.onSaved(range('A'));
  nodes(tree).find(node=>node.type==='button'&&words(node)==='试听保留部分').props.onClick();
  assert.deepEqual(old,[]);assert.deepEqual(latest,['A']);assert.deepEqual(saved,['A']);assert.deepEqual(preview,['A']);assert.equal(controller.options.range.audioId,'A');assert.equal(f.controllers.length,1);assert.ok(f.window.count()>0);
  f.unmount();assert.equal(f.window.count(),0);assert.equal(controller.released,true);controller.options.onChange({range:range('A'),status:'saved',dirty:false,error:''});assert.deepEqual(latest,['A']);
});

test('实际metadata监听器沿固定target重读，旧audio在途响应不会画到新audio或留旧listener',async()=>{
  let release;const requests=[];const window=events();const read=async path=>{requests.push(path);if(path.includes('audioId=A'))return new Promise(resolve=>release=()=>resolve({range:range('A'),editable:true}));return{range:range('B'),editable:true};};
  const old=await setup({read});old.render();old.render();await tick();assert.ok(release);assert.ok(old.window.count()>0);old.unmount();assert.equal(old.window.count(),0);
  const current=await setup({read});current.props.audioId='B';current.props.result={range:range('B'),editable:true};current.render();current.render();await tick();const before=current.render();
  assert.equal(nodes(before).find(node=>typeof node.type==='function'&&node.type.name==='WaveformEditor').props.audioId,'B');release();await tick();const after=current.render();assert.equal(nodes(after).find(node=>typeof node.type==='function'&&node.type.name==='WaveformEditor').props.result.range.audioId,'B');
  current.window.dispatch('online');await tick();assert.ok(requests.at(-1).includes('audioId=B'));current.unmount();assert.equal(current.window.count(),0);assert.equal(window.count(),0);
});

test('同一波形20次重连仅一在途与一次最新重读，旧范围不采用；卸载取消免费读取',async()=>{
  let release;const options=[];
  const f=await setup({read:async(_path,option)=>{options.push(option);return options.length===1?new Promise(resolve=>release=()=>resolve({range:{...range('A'),revision:1},editable:true})):{range:{...range('A'),revision:2},editable:true};}});
  f.render();f.render();await tick();
  for(let i=0;i<20;i++)f.window.dispatch('online');
  assert.equal(f.reads.length,1);release();await tick();await tick();
  const tree=f.render();assert.equal(f.reads.length,2);assert.equal(nodes(tree).find(node=>typeof node.type==='function'&&node.type.name==='WaveformEditor').props.result.range.revision,2);
  f.unmount();assert.ok(options.every(option=>option.signal.aborted));assert.equal(f.window.count(),0);
});
