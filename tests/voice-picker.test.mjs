import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const compile = source => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.React } }).outputText;
const url = source => 'data:text/javascript;base64,' + Buffer.from(source + '\n//' + crypto.randomUUID()).toString('base64');
const storage = () => { const map = new Map(); return { getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, value), removeItem: key => map.delete(key), entries: () => [...map] }; };
const fixture = () => ({
  chapter: { id: 'chapter', projectId: 'project', revision: 1, roleVoices: { role: 'chapter-voice' }, segments: [{ id: 'one', order: 0, text: '当前台词', roleId: 'role', voiceSource: 'default' }, { id: 'two', order: 1, text: '单句选择', roleId: 'role', voiceSource: 'override', voiceId: 'single-voice' }] },
  roles: [{ id: 'role', revision: 1, name: '角色', voiceId: 'project-voice' }],
  state: { voices: [{ id: 'chapter-voice', state: 'active', name: '本章声音', duration: 3 }], jobs: [], voiceSessions: [], settings: { features: {}, configured: true, audioTools: true, routeBlocked: false, model: 'audio' } },
  initialTarget: { roleId: 'role' }, onClose() {}, onRefresh: async () => {}, play() {}, onUsed() {},
});
const nodes = node => !node || typeof node !== 'object' ? [] : [node, ...(node.props?.children || []).flat(Infinity).flatMap(nodes)];
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
async function setup(api = async () => ({}), operations = async () => ({ result: {} })) {
  globalThis.localStorage ||= storage(); globalThis.sessionStorage ||= storage();
  const apiSource = compile(readFileSync(new URL('../src/api.ts', import.meta.url), 'utf8'));
  const autosaveSource = compile(readFileSync(new URL('../src/autosave.ts', import.meta.url), 'utf8')).replace('"./api"', JSON.stringify(url(apiSource)));
  const autosave = await import(url(autosaveSource));
  let index = 0; const hooks = [];
  const runtime = { ...autosave, api, submitOperation: operations, useEffect: effect => effect(),
    useState: initial => { const key = index++; if (!(key in hooks)) hooks[key] = typeof initial === 'function' ? initial() : initial; return [hooks[key], value => { hooks[key] = typeof value === 'function' ? value(hooks[key]) : value; }]; },
    useRef: initial => { const key = index++; return hooks[key] ||= { current: initial }; },
    React: { createElement: (type, props, ...children) => ({ type, props: { ...props, children } }), Fragment: 'Fragment' },
  };
  globalThis.voicePickerTest = runtime;
  const source = readFileSync(new URL('../src/WorkspaceExperience.tsx', import.meta.url), 'utf8');
  const component = source.slice(source.indexOf('export function VoicePicker('), source.indexOf('export function RecoveryCenter('));
  const header = `const {useEffect,useRef,useState,api,submitOperation,withSavedDrafts,draftScopeRevision,React}=globalThis.voicePickerTest; const Dialog='Dialog',Field='Field',Form='Form',VoiceCreation='VoiceCreation',Search='Search',Play='Play',Upload='Upload';\n`;
  const { VoicePicker } = await import(url(header + compile(component)));
  return { ...autosave, render: props => { index = 0; return VoicePicker(props); } };
}

test('voice choice captures scope and chapter voice; polling changes require an explicit new review', async () => {
  globalThis.localStorage = storage(); globalThis.sessionStorage = storage();
  const { render } = await setup(), props = fixture(); props.initialTarget.tab = 'create';
  let tree = render(props), creator = nodes(tree).find(node => node.type === 'VoiceCreation');
  assert.equal(creator.props.target.revision, 1); assert.equal(creator.props.target.dependencies.length, 2);
  const changed = { ...props, chapter: { ...props.chapter, revision: 4, segments: [{ ...props.chapter.segments[0], text: '外页改动' }, props.chapter.segments[1]] } };
  tree = render(changed); creator = nodes(tree).find(node => node.type === 'VoiceCreation');
  assert.equal(creator.props.target.revision, 1); assert.equal(creator.props.target.needsReview, true);
  assert.ok(nodes(tree).some(node => node.type === 'p' && node.props.children.join('') === '第 1 条 · 当前台词'));
  const review = nodes(tree).find(node => node.type === 'button' && node.props.children.includes('重新核对当前范围')); review.props.onClick();
  creator = nodes(render(changed)).find(node => node.type === 'VoiceCreation'); assert.equal(creator.props.target.revision, 4); assert.equal(creator.props.target.needsReview, false);
});

test('角色选声范围补齐空的单句覆盖，并保留已有单句声音', async () => {
  globalThis.localStorage = storage(); globalThis.sessionStorage = storage();
  const {render}=await setup(),props=fixture();props.initialTarget.tab='create';
  props.chapter.segments.push({id:'missing',order:2,text:'尚未选声',roleId:'role',voiceSource:'override',voiceId:null});
  const tree=render(props),creator=nodes(tree).find(node=>node.type==='VoiceCreation');
  assert.deepEqual(creator.props.target.dependencies,['segment:one','segment:missing','role:role']);
  assert.match(nodes(tree).filter(node=>node.type==='p').map(node=>node.props.children.join('')).join('\n'),/2 条将使用所选声音/);
});

test('same-page save receipts advance the binding; a foreign change during that barrier sends nothing', async () => {
  globalThis.localStorage = storage(); globalThis.sessionStorage = storage(); const sent = [];
  const first = await setup(undefined, async (key, payload) => { sent.push(payload); return { result: {} }; }), props = fixture();
  let dirty = true;
  first.registerDraftSave('one', { scope: 'chapter:chapter', dependencies: ['segment:one'], dirty: () => dirty, state: () => 'local', freeze() {}, flush: async () => { await first.queueDraftSave('chapter:chapter', 1, ['segment:one'], async revision => ({ revision: revision + 1, changes: ['segment:one'] })); dirty = false; } });
  first.render(props).props.footer.props.onClick(); await tick();
  assert.equal(sent.length, 1); assert.equal(sent[0].revision, 2); assert.equal(sent[0].voiceId, 'chapter-voice'); assert.equal(sent[0].chapterOnly, true);
  let foreignSent = 0;
  const second = await setup(undefined, async () => { foreignSent++; return { result: {} }; }), other = fixture(); let release;
  second.registerDraftSave('one', { scope: 'chapter:chapter', dependencies: ['segment:one'], dirty: () => true, state: () => 'local', freeze() {}, flush: () => new Promise(resolve => release = resolve) });
  second.render(other).props.footer.props.onClick(); await tick();
  second.render({ ...other, chapter: { ...other.chapter, revision: 7 } }); release(); await tick(); assert.equal(foreignSent, 0);
});

test('lost reference upload keeps one ID across reload and stores metadata without recording bytes', async () => {
  globalThis.localStorage = storage(); globalThis.sessionStorage = storage(); const ids = []; let recover = false;
  globalThis.FileReader = class { readAsDataURL() { this.result = 'data:audio/wav;base64,c2VjcmV0LXJlY29yZGluZw=='; this.onload(); } };
  const api = async (path, body) => { if (body) { ids.push(body.uploadId); if (!recover) throw new TypeError('offline'); return { id: body.uploadId, name: body.name }; } throw new TypeError('offline'); };
  const props = fixture(), file = { name: 'reference.wav', size: 100, lastModified: 10 }, form = { get: () => file };
  let app = await setup(api), tree = app.render(props);
  nodes(tree).find(node => node.type === 'button' && node.props.children.includes('上传参考')).props.onClick();
  await assert.rejects(nodes(app.render(props)).find(node => node.type === 'Form').props.onSubmit(form), /offline/);
  assert.equal(localStorage.entries().length, 1); assert.ok(!JSON.stringify(localStorage.entries()).includes('c2VjcmV0'));
  recover = true; app = await setup(api); tree = app.render(props);
  nodes(tree).find(node => node.type === 'button' && node.props.children.includes('上传参考')).props.onClick();
  await nodes(app.render(props)).find(node => node.type === 'Form').props.onSubmit(form);
  assert.equal(ids.length, 2); assert.equal(ids[0], ids[1]); assert.equal(localStorage.entries().length, 0);
});
