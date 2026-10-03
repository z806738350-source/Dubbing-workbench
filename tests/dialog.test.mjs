import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source = readFileSync(new URL('../src/components.tsx', import.meta.url), 'utf8');
const component = source.slice(source.indexOf('export function Dialog('), source.indexOf('export function Select(')).replace('export function Dialog', 'function Dialog');
const code = ts.transpileModule(component, { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React } }).outputText;
const env = {
  React: { createElement: (type, props, ...children) => ({ type, props: { ...props, children } }) },
  useRef: value => ({ current: value }), useContext: () => 0, useEffect() {},
  DialogDepth: { Provider: 'DialogDepth.Provider' }, ErrorBanner: 'ErrorBanner', X: 'X',
  createPortal: node => node, document: { body: {} },
};
const Dialog = new Function(...Object.keys(env), code + '\nreturn Dialog;')(...Object.values(env));
const render = props => Dialog({ title: '声音背景', children: '面板内容', ...props });
const nodes = node => !node || typeof node !== 'object' ? [] : [node, ...(node.props?.children || []).flat(Infinity).flatMap(nodes)];
const cancelEvent = () => ({
  prevented: false, stopped: false,
  preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; },
});

test('嵌套帮助取消阻止原生默认关闭和合成冒泡，仅关闭当前弹窗', () => {
  const closed = [], parent = render({ onClose: () => closed.push('panel') }), help = render({ onClose: () => closed.push('help') }), event = cancelEvent();
  for (const dialog of [help, parent]) { dialog.props.onCancel(event); if (event.stopped) break; }
  assert.equal(event.prevented, true); assert.equal(event.stopped, true);
  assert.deepEqual(closed, ['help']);
});

test('单层弹窗取消仍关闭一次，标题关闭按钮仍可正常使用', () => {
  let closed = 0;
  const dialog = render({ onClose: () => closed++ }), event = cancelEvent();
  dialog.props.onCancel(event); assert.equal(closed, 1); assert.equal(event.prevented, true); assert.equal(event.stopped, true);
  nodes(dialog).find(node => node.type === 'button' && node.props['aria-label'] === '关闭').props.onClick();
  assert.equal(closed, 2);
});

test('标题动作插槽可缺省，提供说明入口时保留标题、正文和关闭按钮', () => {
  const help = env.React.createElement('button', { 'aria-label': '声音背景说明' }, '说明');
  for (const headerActions of [undefined, help]) {
    const dialog = render({ onClose() {}, headerActions }), all = nodes(dialog), head = all.find(node => node.props.className === 'dialog-head');
    assert.equal(all.find(node => node.type === 'h2').props.children[0], '声音背景');
    assert.equal(all.find(node => node.props.className === 'dialog-body').props.children[0], '面板内容');
    assert.equal(head.props.children.includes(help), !!headerActions);
    assert.equal(all.filter(node => node.type === 'button' && node.props['aria-label'] === '关闭').length, 1);
  }
});
