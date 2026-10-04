import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const source = readFileSync(new URL('../src/ConcurrencySettings.tsx', import.meta.url), 'utf8').replace(/^import .*;\n/gm, '');
const compiled = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.React, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const nodes = node => !node || typeof node !== 'object' ? [] : [node, ...(node.props?.children || []).flat(Infinity).flatMap(nodes)];
const text = node => node == null || typeof node === 'boolean' ? '' : typeof node !== 'object' ? String(node) : (node.props?.children || []).flat(Infinity).map(text).join('');
const button = (tree, label) => nodes(tree).find(node => node.type === 'button' && text(node) === label);
const tick = () => new Promise(resolve => setImmediate(resolve));
let sequence = 0;
async function setup(api = async () => ({})) {
  let index = 0, writes = 0; const values = [], cleanups = [], requests = [];
  globalThis.concurrencySettingsTest = {
    React: { createElement: (type, props, ...children) => ({ type, props: { ...props, children } }) },
    useRef: initial => { const i = index++; return values[i] ||= { current: initial }; },
    useState: initial => { const i = index++; if (!(i in values)) values[i] = initial; return [values[i], value => { writes++; values[i] = value; }]; },
    useEffect: callback => { const i = index++; if (!(i in values)) { values[i] = true; cleanups.push(callback()); } },
    api: (...args) => { requests.push(args); return api(...args); },
  };
  const header = 'const {React,useRef,useState,useEffect,api}=globalThis.concurrencySettingsTest;\n';
  const module = await import('data:text/javascript;base64,' + Buffer.from(header + compiled + '\n//' + sequence++).toString('base64'));
  const render = (name, props) => { index = 0; return module[name](props); };
  return { render, requests, writes: () => writes, unmount: () => cleanups.forEach(cleanup => cleanup?.()) };
}
const status = {revision:0,desiredAudioConcurrency:1,effectiveAudioConcurrency:1,routeConcurrencyCap:1,networkActive:0,localActive:0,localQueued:0,attemptsActive:0,accepting:true,phaseCounts:{}};

test('上限1时只显示1段，旧期望4不显示为已生效并可点1归一',async()=>{
  const f=await setup(async()=>({...status,revision:1}));
  const props={status:{...status,desiredAudioConcurrency:4},connected:true,refresh:async()=>{}};
  const tree=f.render('ConcurrencySettings',props);
  assert.equal(tree.type,'details');assert.equal(tree.props.open,undefined);
  assert.match(text(tree),/同时制作：最多 1 段/);assert.match(text(tree),/此前保存的 4 段.*未生效/);
  assert.doesNotMatch(text(tree),/当前已开放|灰色档位/);assert.match(text(tree),/降档后.*继续完成/);
  assert.equal(nodes(tree).filter(n=>n.type==='button').length,1);
  assert.equal(button(tree,'1 段').props['aria-pressed'],true);assert.equal(button(tree,'1 段').props.disabled,false);
  for(const count of [2,3,4,5,6,7,8]) assert.equal(button(tree,count+' 段'),undefined);
  assert.equal(f.requests.length,0);
  button(tree,'1 段').props.onClick();await tick();
  assert.deepEqual(f.requests,[['/scheduler',{revision:0,desiredAudioConcurrency:1},'PUT']]);
  assert.doesNotMatch(text(f.render('ConcurrencySettings',props)),/此前保存/);
});

test('可用档位只PUT版本和段数，重复点击不重复发送，回执立即展示实际值',async()=>{
  let resolve,finishRefresh;const f=await setup(()=>new Promise(r=>resolve=r));let refreshes=0;
  const props={status:{...status,routeConcurrencyCap:4},connected:true,refresh:()=>{refreshes++;return new Promise(r=>finishRefresh=r);}};
  button(f.render('ConcurrencySettings',props),'3 段').props.onClick();button(f.render('ConcurrencySettings',props),'4 段').props.onClick();
  assert.deepEqual(f.requests,[['/scheduler',{revision:0,desiredAudioConcurrency:3},'PUT']]);
  assert.ok(nodes(f.render('ConcurrencySettings',props)).filter(n=>n.type==='button').every(n=>n.props.disabled));
  assert.equal(button(f.render('ConcurrencySettings',props),'1 段').props['aria-pressed'],true);
  resolve({...status,revision:1,routeConcurrencyCap:4,desiredAudioConcurrency:3,effectiveAudioConcurrency:3});await tick();
  const saved=f.render('ConcurrencySettings',props);
  assert.match(text(saved),/同时制作：最多 3 段/);assert.equal(button(saved,'3 段').props['aria-pressed'],true);assert.equal(refreshes,1);
  finishRefresh();await tick();
  const newer=f.render('ConcurrencySettings',{...props,status:{...status,revision:2,desiredAudioConcurrency:2,effectiveAudioConcurrency:2,routeConcurrencyCap:3}});
  assert.equal(button(newer,'2 段').props['aria-pressed'],true);assert.match(text(newer),/同时制作：最多 2 段/);
  assert.equal(button(newer,'4 段'),undefined);
});

test('本地处理上限低于已保存设置时保留可应用选择，实际值和原因单独说明',async()=>{
  const f=await setup(),tree=f.render('ConcurrencySettings',{status:{...status,desiredAudioConcurrency:4,effectiveAudioConcurrency:2,routeConcurrencyCap:4},connected:true,refresh:async()=>{}});
  assert.equal(button(tree,'4 段').props['aria-pressed'],true);assert.equal(button(tree,'2 段').props['aria-pressed'],false);
  assert.equal(button(tree,'4 段').props.disabled,false);
  assert.match(text(tree),/同时制作：最多 2 段/);assert.match(text(tree),/已保存 4 段.*本地处理上限为 2 段/);
  assert.doesNotMatch(text(tree),/未开放|此前保存/);assert.equal(f.requests.length,0);
});

test('降档回执立即显示新上限，在途仍可超过上限直到自然完成',async()=>{
  const f=await setup(async()=>({...status,revision:1,routeConcurrencyCap:4,networkActive:4,attemptsActive:4,phaseCounts:{sending:4}}));
  const props={status:{...status,desiredAudioConcurrency:4,effectiveAudioConcurrency:4,routeConcurrencyCap:4,networkActive:4,attemptsActive:4,phaseCounts:{sending:4}},connected:true,refresh:async()=>{}};
  button(f.render('ConcurrencySettings',props),'1 段').props.onClick();await tick();
  const tree=f.render('ConcurrencySettings',props);
  assert.match(text(tree),/同时制作：最多 1 段/);assert.equal(button(tree,'1 段').props['aria-pressed'],true);
  assert.match(text(tree),/降档后.*已发出的音频会继续完成/);
  const liveStatus=nodes(tree).find(n=>typeof n.type==='function'&&n.type.name==='ConcurrencyStatus').props.status;
  assert.equal(liveStatus.networkActive,4);assert.equal(liveStatus.attemptsActive,4);
});

test('断线和重复选择零发送，设置冲突显示错误并刷新最新版本',async()=>{
  const f=await setup(async()=>{throw new Error('并发设置已改变，请重新核对');});let refreshes=0;
  const props={status:{...status,routeConcurrencyCap:3},connected:true,refresh:async()=>{refreshes++;}};
  const disconnected=f.render('ConcurrencySettings',{...props,connected:false});
  assert.ok(nodes(disconnected).filter(n=>n.type==='button').every(n=>n.props.disabled));
  button(disconnected,'3 段').props.onClick();
  button(f.render('ConcurrencySettings',props),'1 段').props.onClick();assert.equal(f.requests.length,0);
  button(f.render('ConcurrencySettings',props),'2 段').props.onClick();await tick();
  assert.match(text(f.render('ConcurrencySettings',props)),/并发设置已改变/);assert.equal(refreshes,1);
  assert.equal(button(f.render('ConcurrencySettings',props),'2 段').props.disabled,false);
});

test('关闭设置后旧回执不再更新或刷新其他工作区',async()=>{
  let resolve;const f=await setup(()=>new Promise(r=>resolve=r));let refreshes=0;
  button(f.render('ConcurrencySettings',{status:{...status,routeConcurrencyCap:2},connected:true,refresh:async()=>{refreshes++;}}),'2 段').props.onClick();
  f.unmount();const writes=f.writes();resolve({...status,revision:1});await tick();
  assert.equal(f.writes(),writes);assert.equal(refreshes,0);
});

test('全局状态区分准备、上游和本地整理，本地恢复不说成模型仍在生成',async()=>{
  const f=await setup();
  assert.match(text(f.render('ConcurrencyStatus',{status:{...status,attemptsActive:5,phaseCounts:{preparing:1,sending:2,receiving:1,processing:1}}})),/1 段准备 · 3 段生成或接收 · 1 段整理/);
  assert.match(text(f.render('ConcurrencyStatus',{status:{...status,storageBlocked:true,accepting:false}})),/本地整理需要处理/);
  assert.match(text(f.render('ConcurrencyStatus',{status})),/全局制作空闲/);
});


test('上限8变4后仅显示1至4，旧期望8不冒充生效且可保存合法档位',async()=>{
  const f=await setup(async()=>({...status,revision:2,desiredAudioConcurrency:4,effectiveAudioConcurrency:4,routeConcurrencyCap:4}));
  const props={status:{...status,desiredAudioConcurrency:8,effectiveAudioConcurrency:8,routeConcurrencyCap:8},connected:true,refresh:async()=>{}};
  assert.equal(button(f.render('ConcurrencySettings',props),'8 段').props['aria-pressed'],true);
  const updated={...props,status:{...props.status,revision:1,effectiveAudioConcurrency:4,routeConcurrencyCap:4}},tree=f.render('ConcurrencySettings',updated);
  assert.match(text(tree),/同时制作：最多 4 段/);assert.doesNotMatch(text(tree),/当前已开放|灰色档位/);assert.match(text(tree),/此前保存的 8 段.*未生效/);
  assert.deepEqual(nodes(tree).filter(n=>n.type==='button').map(text),['1 段','2 段','3 段','4 段']);
  for(const count of [5,6,7,8]) assert.equal(button(tree,count+' 段'),undefined);
  assert.equal(f.requests.length,0);
  button(tree,'4 段').props.onClick();await tick();
  assert.deepEqual(f.requests,[['/scheduler',{revision:1,desiredAudioConcurrency:4},'PUT']]);
  const saved=f.render('ConcurrencySettings',updated);assert.doesNotMatch(text(saved),/此前保存/);assert.equal(button(saved,'4 段').props['aria-pressed'],true);
  button(saved,'4 段').props.onClick();assert.equal(f.requests.length,1);
});

test('已验证上限8时可保存8，按服务器回执区分期望与实际并保持八段在途',async()=>{
  const f=await setup(async()=>({...status,revision:1,desiredAudioConcurrency:8,effectiveAudioConcurrency:6,routeConcurrencyCap:8,networkActive:8,attemptsActive:8,phaseCounts:{sending:8}}));
  const props={status:{...status,routeConcurrencyCap:8},connected:true,refresh:async()=>{}};
  const initial=f.render('ConcurrencySettings',props);assert.equal(button(initial,'8 段').props.disabled,false);assert.doesNotMatch(text(initial),/当前已开放|灰色档位/);
  assert.deepEqual(nodes(initial).filter(n=>n.type==='button').map(text),['1 段','2 段','3 段','4 段','5 段','6 段','7 段','8 段']);
  button(initial,'8 段').props.onClick();await tick();assert.deepEqual(f.requests,[['/scheduler',{revision:0,desiredAudioConcurrency:8},'PUT']]);
  const saved=f.render('ConcurrencySettings',props);assert.equal(button(saved,'8 段').props['aria-pressed'],true);assert.match(text(saved),/同时制作：最多 6 段/);assert.match(text(saved),/已保存 8 段.*本地处理上限为 6 段/);
  const liveStatus=nodes(saved).find(n=>typeof n.type==='function'&&n.type.name==='ConcurrencyStatus').props.status;assert.equal(liveStatus.networkActive,8);
  const downgraded=f.render('ConcurrencySettings',{...props,status:{...liveStatus,revision:2,desiredAudioConcurrency:4,effectiveAudioConcurrency:4}});assert.equal(button(downgraded,'4 段').props['aria-pressed'],true);assert.match(text(downgraded),/同时制作：最多 4 段/);assert.match(text(downgraded),/降档后.*已发出的音频会继续完成/);assert.equal(nodes(downgraded).find(n=>typeof n.type==='function'&&n.type.name==='ConcurrencyStatus').props.status.networkActive,8);
});
