import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { openStore, uid } from '../server/store.mjs';
import { createDomain } from '../server/domain.mjs';
import { compile } from '../server/templates.mjs';

const source = readFileSync(new URL('../src/WorkspaceExperience.tsx', import.meta.url), 'utf8');
const component = source.slice(source.indexOf('export type WorkspaceIssue'), source.indexOf('export function ProjectOverview('));
const runtime = `const React={createElement:(type,props,...children)=>({type,props:{...props,children}})}; const useState=value=>[value,()=>{}],Dialog='Dialog',Check='Check';\n`;
const compiled = ts.transpileModule(runtime + component, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.React } }).outputText;
const { chapterIssues, IssueCenter } = await import('data:text/javascript;base64,' + Buffer.from(compiled).toString('base64'));
const nodes = node => !node || typeof node !== 'object' ? [] : [node, ...(node.props?.children || []).flat(Infinity).flatMap(nodes)];

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dubbing-workspace-issues-')), store = openStore(dir), domain = createDomain(store);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const project = domain.mutate('project.create', { name: '问题中心隔离验收' });
  const chapter = domain.mutate('chapter.create', { projectId: project.id, title: '两句对话', source: '第一句。第二句。', segment: true });
  const role = store.all('roles', project.id)[0], voice = { id: uid(), name: '参考', state: 'active', path: 'voices/reference.wav' };
  mkdirSync(join(dir, 'voices')); writeFileSync(join(dir, voice.path), 'fixture'); store.put('voices', voice);
  const edit = (action, data) => domain.mutate(action, { chapterId: chapter.id, revision: store.get('chapters', chapter.id).revision, ...data });
  edit('role.update', { id: role.id, entityRevision: role.revision || 1, voiceId: voice.id, apply: true });
  const ids = domain.list(chapter.id).map(segment => segment.id); edit('segment.confirm', { ids });
  function attempt(unitId, mode = 'dry', status = 'success', retryUnknown = false) {
    const prepared = domain.enhancement.prepare({ kind: 'unit-generate', chapterId: chapter.id, revision: store.get('chapters', chapter.id).revision, unitId, mode, retryUnknown }, { model: 'seed-audio-1.0' });
    const job = { id: uid(), kind: 'unit-generate', status: 'running', ...prepared.job };
    const item = { id: uid(), jobId: job.id, ...prepared.attempts[0], status };
    store.put('jobs', job, chapter.id); store.put('attempts', item, job.id);
    if (status === 'success') {
      const audio = { id: item.id, path: `audio/${item.id}.wav`, input: item.input, basis: item.basis, prompt: compile(item.input), model: item.input.model };
      mkdirSync(join(dir, 'audio'), { recursive: true }); writeFileSync(join(dir, audio.path), 'fixture'); store.put('audios', audio, chapter.id);
      assert.equal(domain.enhancement.register(job, item, audio), true);
    } else domain.enhancement.setAttemptStatus(job, item, status);
    job.status = status; store.put('jobs', job, chapter.id); return item.id;
  }
  const snapshot = () => domain.chapter(chapter.id), issues = () => chapterIssues(snapshot(), domain.snapshot().roles, domain.snapshot().voices);
  const scene = unitId => edit('event.create', { unitId, entityRevision: store.get('units', unitId).revision, kind: 'effect', description: '轻敲一下', memberId: ids[0], position: 'after', state: 'adopted' });
  for (const id of ids) attempt(id);
  return { store, domain, chapter, ids, edit, attempt, scene, snapshot, issues };
}

test('active group unknown is one scoped issue; its matching older audio and member dry successes survive', t => {
  const f = setup(t), group = f.edit('unit.create', { ids: f.ids }), audioId = f.attempt(group.id);
  f.attempt(group.id, 'dry', 'unknown');
  const before = f.snapshot(); assert.ok(before.segments.every(segment => segment.latest === 'success'));
  const issues = f.issues().filter(issue => issue.kind === 'request');
  assert.equal(issues.length, 1); assert.equal(issues[0].unitId, group.id); assert.equal(issues[0].mode, 'dry'); assert.deepEqual(issues[0].ids, f.ids);
  assert.match(issues[0].detail, /可能已.*计费/); assert.match(issues[0].detail, /新结果待核对/); assert.match(issues[0].detail, /匹配声音仍可试听/);
  assert.deepEqual(f.snapshot().playbackItems, before.playbackItems); assert.equal(before.playbackItems[0].audioId, audioId); assert.equal(before.playbackItems[0].validity, 'matched');
});

test('scene unknown is reported even when the actual playback remains successful dry audio', t => {
  const f = setup(t), id = f.ids[0], dryId = f.snapshot().playbackItems[0].audioId;
  f.scene(id); f.attempt(id, 'scene', 'unknown');
  const chapter = f.snapshot(), issues = f.issues().filter(issue => issue.kind === 'request');
  assert.equal(chapter.segments[0].latest, 'success'); assert.equal(chapter.units.find(unit => unit.id === id).mode, 'dry');
  assert.equal(issues.length, 1); assert.equal(issues[0].unitId, id); assert.equal(issues[0].mode, 'scene'); assert.match(issues[0].detail, /匹配声音仍可试听/);
  assert.equal(chapter.playbackItems[0].audioId, dryId); assert.equal(chapter.playbackItems[0].validity, 'matched');
  let target; const tree = IssueCenter({ chapter, roles: f.domain.snapshot().roles, voices: f.domain.snapshot().voices, onUnit: (...args) => { target = args; } });
  const button = nodes(tree).find(node => node.type === 'button' && node.props.children.includes('核对生成任务'));
  assert.ok(button); button.props.onClick(); assert.deepEqual(target, [id, 'scene']);
});

test('scene rerun unknown keeps the selected matching scene and reports its new result', t => {
  const f = setup(t), id = f.ids[0]; f.scene(id); const audioId = f.attempt(id, 'scene'); f.attempt(id, 'scene', 'unknown');
  const before = f.snapshot(); assert.equal(before.playbackItems[0].mode, 'scene'); assert.equal(before.playbackItems[0].audioId, audioId); assert.equal(before.playbackItems[0].validity, 'matched');
  assert.equal(f.issues().filter(issue => issue.kind === 'request').length, 1); assert.deepEqual(f.snapshot().playbackItems, before.playbackItems);
});

test('historical unknown is not an issue after a later successful result replaces that variant', t => {
  const f = setup(t), group = f.edit('unit.create', { ids: f.ids }); f.attempt(group.id); f.attempt(group.id, 'dry', 'unknown');
  const audioId = f.attempt(group.id, 'dry', 'success', true);
  assert.ok(f.domain.snapshot().jobs.some(job => job.status === 'unknown'));
  assert.equal(f.issues().filter(issue => issue.kind === 'request').length, 0); assert.equal(f.snapshot().playbackItems[0].audioId, audioId);
});

test('active group suppresses superseded member failures; pending group and latest group failures remain actionable', t => {
  const f = setup(t); f.attempt(f.ids[0], 'dry', 'failed'); const group = f.edit('unit.create', { ids: f.ids }); f.attempt(group.id, 'dry', 'unknown');
  assert.ok(f.issues().some(issue => issue.unitId === group.id && issue.mode === 'dry'));
  f.attempt(group.id, 'dry', 'success', true);
  assert.equal(f.issues().filter(issue => issue.kind === 'request').length, 0);
  f.attempt(group.id, 'dry', 'failed');
  const issues = f.issues().filter(issue => issue.kind === 'request'); assert.equal(issues.length, 1); assert.equal(issues[0].unitId, group.id); assert.equal(issues[0].mode, 'dry');
});
