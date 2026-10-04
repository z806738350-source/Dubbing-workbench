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

test('设置默认折叠，只提供1至4选择并如实显示受账号上限约束',async()=>{
  const f=await setup(),tree=f.render('ConcurrencySettings',{status:{...status,desiredAudioConcurrency:3},connected:true,refresh:async()=>{}});
  assert.equal(tree.type,'details');assert.equal(tree.props.open,undefined);
  assert.match(text(tree),/同时制作：1 段/);assert.match(text(tree),/已选择 3 段，实际同时 1 段/);
  assert.match(text(tree),/不增加生成份数/);assert.match(text(tree),/已发送的音频继续完成/);
  assert.equal(nodes(tree).filter(n=>n.type==='button').length,4);assert.equal(button(tree,'3 段').props['aria-pressed'],true);
  assert.equal(f.requests.length,0);
});

test('并发调整只PUT版本和期望数，重复点击不重复发送，回执展示实际值',async()=>{
  let resolve;const f=await setup(()=>new Promise(r=>resolve=r));let refreshes=0;
  const props={status,connected:true,refresh:async()=>{refreshes++;}};
  button(f.render('ConcurrencySettings',props),'3 段').props.onClick();button(f.render('ConcurrencySettings',props),'4 段').props.onClick();
  assert.deepEqual(f.requests,[['/scheduler',{revision:0,desiredAudioConcurrency:3},'PUT']]);
  assert.ok(nodes(f.render('ConcurrencySettings',props)).filter(n=>n.type==='button').every(n=>n.props.disabled));
  resolve({...status,revision:1,desiredAudioConcurrency:3});await tick();
  assert.match(text(f.render('ConcurrencySettings',props)),/已选择 3 段，实际同时 1 段/);assert.equal(refreshes,1);
  const newer=f.render('ConcurrencySettings',{...props,status:{...status,revision:2,desiredAudioConcurrency:2,effectiveAudioConcurrency:2,routeConcurrencyCap:3}});
  assert.equal(button(newer,'2 段').props['aria-pressed'],true);assert.match(text(newer),/同时制作：2 段/);
});

test('断线和重复选择零发送，设置冲突显示错误并刷新最新版本',async()=>{
  const f=await setup(async()=>{throw new Error('并发设置已改变，请重新核对');});let refreshes=0;
  const props={status,connected:true,refresh:async()=>{refreshes++;}};
  button(f.render('ConcurrencySettings',{...props,connected:false}),'3 段').props.onClick();
  button(f.render('ConcurrencySettings',props),'1 段').props.onClick();assert.equal(f.requests.length,0);
  button(f.render('ConcurrencySettings',props),'2 段').props.onClick();await tick();
  assert.match(text(f.render('ConcurrencySettings',props)),/并发设置已改变/);assert.equal(refreshes,1);
  assert.equal(button(f.render('ConcurrencySettings',props),'2 段').props.disabled,false);
});

test('关闭设置后旧回执不再更新或刷新其他工作区',async()=>{
  let resolve;const f=await setup(()=>new Promise(r=>resolve=r));let refreshes=0;
  button(f.render('ConcurrencySettings',{status,connected:true,refresh:async()=>{refreshes++;}}),'2 段').props.onClick();
  f.unmount();const writes=f.writes();resolve({...status,revision:1});await tick();
  assert.equal(f.writes(),writes);assert.equal(refreshes,0);
});

test('全局状态区分准备、上游和本地整理，本地恢复不说成模型仍在生成',async()=>{
  const f=await setup();
  assert.match(text(f.render('ConcurrencyStatus',{status:{...status,attemptsActive:5,phaseCounts:{preparing:1,sending:2,receiving:1,processing:1}}})),/1 段准备 · 3 段生成或接收 · 1 段整理/);
  assert.match(text(f.render('ConcurrencyStatus',{status:{...status,storageBlocked:true,accepting:false}})),/本地整理需要处理/);
  assert.match(text(f.render('ConcurrencyStatus',{status})),/全局制作空闲/);
});
