import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const source = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const component = source.slice(source.indexOf('function ExportDialog('), source.indexOf('function RebindDialog('));
const code = ts.transpileModule(component, { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React } }).outputText;
const nodes = node => !node || typeof node !== 'object' ? [] : [node, ...(node.props?.children || []).flat(Infinity).flatMap(nodes)];
const content = node => typeof node === 'string' || typeof node === 'number' ? String(node) : (node?.props?.children || []).flat(Infinity).map(content).join('');
const button = (tree, label) => nodes(tree).find(node => node.type === 'button' && content(node) === label);
const exportForm = tree => nodes(tree).find(node => node.type === 'Form' && node.props.label !== '保存间隔');
const defer = () => { let resolve; return { promise: new Promise(r => resolve = r), resolve: value => resolve(value) }; };
const settle = () => new Promise(resolve => setImmediate(resolve));
const click = async node => { node.props.onClick(); await settle(); };
const savedExport = (id, overrides = {}) => ({ id, format: 'wav', arrangement: 3, createdAt: '2026-10-03T08:00:00Z', fileExists: true, current: true, ...overrides });
function setup({ submit = async () => ({ jobIds: ['export-job'] }), reveal = async () => ({ directory: '/workspace/项目/output' }), chapter = {} } = {}) {
  let index = 0, close = 0, refresh = 0, stateUpdates = 0;
  const hooks = [], effects = [], sent = [], requests = [];
  const env = {
    React: { createElement: (type, props, ...children) => ({ type, props: { ...props, children } }) },
    Dialog: 'Dialog', Form: 'Form', Field: 'Field', Select: 'Select', Headphones: 'Headphones', Download: 'Download', FolderOpen: 'FolderOpen', Check: 'Check',
    useState: value => { const i = index++; if (!(i in hooks)) hooks[i] = value; return [hooks[i], next => { stateUpdates++; hooks[i] = typeof next === 'function' ? next(hooks[i]) : next; }]; },
    useRef: value => hooks[index++] ||= { current: value }, useEffect: next => effects.push(next),
    withSavedDrafts: async (_scope, _deps, next) => next(),
    submitOperation: async (...args) => { sent.push(args); return submit(...args); },
    api: async (...args) => { requests.push(args); return reveal(...args); },
    basis: () => ({}), action: async () => {}, active: status => ['queued', 'running'].includes(status),
  };
  const ExportDialog = new Function(...Object.keys(env), code + ';return ExportDialog;')(...Object.values(env));
  const props = {
    chapter: { id: 'chapter', title: '示例章', gap: 0, revision: 2, arrangement: 3, segments: [], playbackItems: [], exports: [], reviewItems: [{ id: 'unit', audioId: 'audio', basis: { revision: 1 } }], outputDirectory: '/workspace/项目/output', ...chapter },
    ready: 2, total: 2, passed: 2, connectionReady: true, jobs: [{ id: 'export-job', status: 'success' }],
    onClose: () => close++, onRefresh: async () => refresh++,
  };
  const render = () => { index = 0; return ExportDialog(props); };
  render(); const cleanup = effects[0]();
  return { props, render, submit: () => exportForm(render()).props.onSubmit(), sent, requests, cleanup, close: () => close, refresh: () => refresh, stateUpdates: () => stateUpdates };
}

test('导出使用核对时的版本和审核快照，提交后保留面板并刷新成品', async () => {
  const f = setup(), confirmed = f.props.chapter;
  f.props.chapter = { ...confirmed, revision: 4, arrangement: 5, reviewItems: [{ id: 'unit', audioId: 'new-audio' }] };
  await f.submit();
  assert.equal(f.close(), 0); assert.equal(f.refresh(), 1); assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0][1].revision, 2); assert.equal(f.sent[0][1].arrangement, 3);
  assert.equal(f.sent[0][1].confirm, true); assert.deepEqual(f.sent[0][1].reviewItems, confirmed.reviewItems);
  assert.equal(f.sent[0][2], f.props.jobs);
});

test('导出回执迟到时只刷新资料，不关闭新页面或更新已卸载面板状态', async () => {
  const receipt = defer(), f = setup({ submit: () => receipt.promise }), pending = f.submit();
  f.cleanup(); const updates = f.stateUpdates(); receipt.resolve({ jobIds: ['export-job'] }); await pending;
  assert.equal(f.close(), 0); assert.equal(f.refresh(), 1); assert.equal(f.sent.length, 1); assert.equal(f.stateUpdates(), updates);
});

test('无当前成品时导出为主操作；待检查时保留明确的检查确认', () => {
  const f = setup();
  assert.equal(exportForm(f.render()).props.label, '导出成品'); assert.equal(exportForm(f.render()).props.primary, true);
  assert.equal(button(f.render(), '打开成品文件夹'), undefined);
  f.props.chapter = { ...f.props.chapter, playbackItems: [{ validity: 'matched', review: 'pending' }] };
  assert.equal(exportForm(f.render()).props.label, '确认检查并导出');
});

test('导出进行中禁用重复提交，成品到达后切换到打开操作', () => {
  const f = setup();
  f.props.jobs = [{ id: 'job', chapterId: 'chapter', kind: 'export', status: 'running' }];
  assert.equal(exportForm(f.render()).props.label, '正在导出…'); assert.equal(exportForm(f.render()).props.busy, true);
  f.props.jobs = [{ ...f.props.jobs[0], status: 'success' }];
  f.props.chapter = { ...f.props.chapter, exports: [savedExport('completed')] };
  assert.equal(exportForm(f.render()).props.busy, false); assert.equal(exportForm(f.render()).props.primary, false);
  assert.ok(button(f.render(), '打开成品文件夹'));
});

test('主按钮定位所选格式最新有效成品，切换格式不会误开另一份文件', async () => {
  const f = setup({ chapter: { exports: [
    savedExport('older-wav'), savedExport('latest-wav', { createdAt: '2026-10-03T09:00:00Z' }),
    savedExport('latest-mp3', { format: 'mp3', createdAt: '2026-10-03T10:00:00Z' }),
    savedExport('stale-wav', { current: false }), savedExport('missing-wav', { fileExists: false }),
  ] } });
  const tree = f.render();
  assert.match(content(tree), /\/workspace\/项目\/output/);
  assert.equal(exportForm(tree).props.label, '重新导出'); assert.equal(exportForm(tree).props.primary, false);
  assert.ok(!nodes(tree).some(node => node.type === 'a' && node.props.download));
  await click(button(tree, '打开成品文件夹'));
  assert.deepEqual(f.requests[0], ['/exports/latest-wav/reveal', {}]);
  nodes(f.render()).find(node => node.type === 'Select').props.onChange('mp3');
  await click(button(f.render(), '打开成品文件夹'));
  assert.deepEqual(f.requests[1], ['/exports/latest-mp3/reveal', {}]);
});

test('其他成品收起显示，历史结果定位自身文件，缺失文件无法点击', async () => {
  const f = setup({ chapter: { exports: [savedExport('old', { current: false, arrangement: 1 }), savedExport('missing', { current: false, fileExists: false, arrangement: 2 }), savedExport('current')] } });
  const tree = f.render(), details = nodes(tree).find(node => node.type === 'details');
  assert.ok(details); assert.ok(!details.props.open);
  assert.equal(content(nodes(details).find(node => node.type === 'summary')), '其他已导出文件（2）');
  assert.match(content(details), /编排 1/); assert.match(content(details), /编排 2/);
  const actions = nodes(details).filter(node => node.type === 'button' && content(node) === '打开文件夹');
  assert.equal(actions.length, 2);
  assert.equal(actions.filter(node => node.props.disabled).length, 1);
  await click(actions.find(node => !node.props.disabled));
  assert.deepEqual(f.requests, [['/exports/old/reveal', {}]]);
  assert.ok(!nodes(tree).some(node => node.type === 'a' && node.props.download));
});

test('打开文件夹等待期间禁用操作，失败就地显示原因并允许重试', async () => {
  const receipt = defer(); let fail = true;
  const f = setup({ chapter: { exports: [savedExport('current')] }, reveal: async () => { await receipt.promise; if (fail) throw new Error('成品文件已被移动'); return {}; } });
  button(f.render(), '打开成品文件夹').props.onClick();
  assert.ok(nodes(f.render()).some(node => node.type === 'button' && node.props.disabled));
  receipt.resolve(); await settle();
  assert.match(content(f.render()), /成品文件已被移动/);
  assert.ok(!button(f.render(), '打开成品文件夹').props.disabled);
  fail = false; await click(button(f.render(), '打开成品文件夹'));
  assert.equal(f.requests.length, 2); assert.doesNotMatch(content(f.render()), /成品文件已被移动/);
});

test('打开文件夹回执晚于关闭面板时不再更新卸载后的状态', async () => {
  const receipt = defer(), f = setup({ chapter: { exports: [savedExport('current')] }, reveal: () => receipt.promise });
  button(f.render(), '打开成品文件夹').props.onClick();
  f.cleanup(); const updates = f.stateUpdates(); receipt.resolve({}); await settle();
  assert.equal(f.stateUpdates(), updates); assert.equal(f.close(), 0); assert.equal(f.requests.length, 1);
});
