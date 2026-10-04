import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const source = readFileSync(new URL('../src/AudioProvenance.tsx', import.meta.url), 'utf8').replace(/^import .*;\n/gm, '');
const compiled = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.React, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const nodes = node => !node || typeof node !== 'object' ? [] : [node, ...(node.props?.children || []).flat(Infinity).flatMap(nodes)];
const text = node => node == null || typeof node === 'boolean' ? '' : typeof node !== 'object' ? String(node) : (node.props?.children || []).flat(Infinity).map(text).join('');
const button = (tree, label) => nodes(tree).find(node => node.type === 'button' && text(node) === label);
const tick = () => new Promise(resolve => setImmediate(resolve));
let sequence = 0;
async function setup(api = async () => ({})) {
  let index = 0, writes = 0; const values = [], cleanups = [], requests = [];
  globalThis.audioProvenanceTest = {
    React: { createElement: (type, props, ...children) => ({ type, props: { ...props, children } }) },
    useRef: initial => { const i = index++; return values[i] ||= { current: initial }; },
    useState: initial => { const i = index++; if (!(i in values)) values[i] = initial; return [values[i], value => { writes++; values[i] = value; }]; },
    useEffect: callback => { const i = index++; if (!(i in values)) { values[i] = true; cleanups.push(callback()); } },
    api: (...args) => { requests.push(args); return api(...args); },
  };
  const header = 'const {React,useRef,useState,useEffect,api}=globalThis.audioProvenanceTest;\n';
  const module = await import('data:text/javascript;base64,' + Buffer.from(header + compiled + '\n//' + sequence++).toString('base64'));
  const render = (name, props) => { index = 0; return module[name](props); };
  return { render, requests, writes: () => writes, unmount: () => cleanups.forEach(cleanup => cleanup?.()) };
}

test('原件入口默认折叠，预览零采用，选用显式且原生按钮/summary可键盘操作', async () => {
  const f = await setup(), played = [], selected = [], raw = {id:'raw',available:true,matched:true,selected:false};
  const props = {record:{originalAudioId:'raw',originalAvailability:'retained'},original:raw,connected:true,locked:false,preview:id=>played.push(id),useOriginal:record=>selected.push(record)};
  const tree = f.render('AudioProvenance', props);
  assert.equal(tree.type, 'details'); assert.equal(tree.props.open, undefined); assert.equal(nodes(tree)[1].type, 'summary');
  button(tree, '试听原件').props.onClick(); assert.deepEqual(played, ['raw']); assert.deepEqual(selected, []);
  button(tree, '使用原件').props.onClick(); assert.deepEqual(selected, [raw]); assert.equal(f.requests.length, 0);
  assert.equal(button(f.render('AudioProvenance', {...props,playingId:'raw'}), '暂停原件').props.disabled, false);
});

test('旧素材不伪造原件、丢失原件不可点，未完成编辑和断线仍阻止采用', async () => {
  const f = await setup(), calls = [], props = {record:{originalAudioId:'old',originalAvailability:'not-saved'},original:{id:'old',matched:true,available:true},connected:true,locked:false,preview:()=>calls.push('preview'),useOriginal:()=>calls.push('use')};
  let tree = f.render('AudioProvenance', props); assert.match(text(tree), /历史供应商原件未保存/); assert.ok(button(tree,'试听清理前版本')); assert.equal(button(tree,'试听原件'), undefined);
  tree = f.render('AudioProvenance', {...props,record:{}}); assert.equal(text(tree), '历史原件未保存');
  for (const override of [{original:undefined},{original:{...props.original,available:false}},{connected:false},{locked:true}]) {
    tree = f.render('AudioProvenance', {...props,...override}); const use = button(tree,'使用清理前版本') || button(tree,'核对并使用清理前版本');
    assert.equal(use.props.disabled,true); use.props.onClick();
  }
  assert.deepEqual(calls, []);
});

test('免费本地恢复只POST指定尝试和任务范围，重复点击不重复发送，回执后刷新但不试听或采用', async () => {
  let resolve; const wait = new Promise(done => {resolve = done;}), f = await setup(async () => wait); let refreshed = 0;
  const props = {attemptId:'attempt',jobId:'job',chapterId:'chapter',connected:true,refresh:async()=>{refreshed++;}};
  button(f.render('LocalAudioRecovery', props), '免费恢复').props.onClick(); button(f.render('LocalAudioRecovery', props), '正在本地恢复…').props.onClick();
  assert.deepEqual(f.requests, [['/attempts/attempt/recover',{jobId:'job',chapterId:'chapter'}]]);
  assert.equal(button(f.render('LocalAudioRecovery', props), '正在本地恢复…').props.disabled, true);
  resolve({id:'audio'}); await tick();
  assert.equal(refreshed,1); assert.match(text(f.render('LocalAudioRecovery', props)), /已免费恢复，当前选版保持/); assert.equal(button(f.render('LocalAudioRecovery', props),'免费恢复'),undefined);
});

test('恢复失败可免费重试，断线禁止发送，关闭面板后迟到回执不更新新面板', async () => {
  const f = await setup(async () => { throw new Error('任务范围已变化'); }), props = {attemptId:'attempt',jobId:'job',chapterId:'',connected:true,refresh:async()=>{throw new Error('should not refresh');}};
  button(f.render('LocalAudioRecovery', {...props,connected:false}), '免费恢复').props.onClick(); assert.equal(f.requests.length,0);
  button(f.render('LocalAudioRecovery', props), '免费恢复').props.onClick(); await tick();
  const tree = f.render('LocalAudioRecovery', props); assert.match(text(tree), /任务范围已变化/); assert.equal(button(tree,'免费恢复').props.disabled,false);
  let resolve; const delayed = await setup(() => new Promise(done=>{resolve=done;}));
  button(delayed.render('LocalAudioRecovery', props),'免费恢复').props.onClick(); delayed.unmount(); const writes = delayed.writes();
  resolve({id:'audio'}); await tick(); assert.equal(delayed.writes(),writes);
});
