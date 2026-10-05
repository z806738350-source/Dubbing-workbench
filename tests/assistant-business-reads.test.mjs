import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, uid } from '../server/store.mjs';
import { createDomain } from '../server/domain.mjs';
import { createAnalysis } from '../server/analysis.mjs';
import { createExperience } from '../server/experience.mjs';
import { createAssistant } from '../server/assistant/service.mjs';
import { createAssistantContext } from '../server/assistant/context.mjs';

function fixture(t, answers = []) {
  const directory = mkdtempSync(join(tmpdir(), 'assistant-business-reads-'));
  const store = openStore(directory), domain = createDomain(store);
  const project = domain.mutate('project.create', { name: '当前项目' });
  const chapter = domain.mutate('chapter.create', { projectId: project.id, title: '第一章', source: '清晨的风吹过窗边。\n我把桌上的书合上。', segment: true });
  const scope = { projectId: project.id, chapterId: chapter.id };
  const config = { baseUrl: 'https://provider.invalid/v1', model: 'seed-audio-1.0', key: 'fixture-secret' };
  const worker = { submit: async () => { throw Error('unexpected paid dispatch'); } };
  const analysis = createAnalysis(store, domain, config), experience = createExperience(store, domain, worker, analysis, config), requests = [];
  const assistant = createAssistant({ store, domain, analysis, experience, worker, config, fetchImpl: async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answers.shift()) } }] }));
  } });
  assistant.model.save({ revision: 0, enabled: true, baseUrl: config.baseUrl, model: 'fixture-model', credentialSource: 'audio', vision: false });
  const session = assistant.create(scope).session;
  t.after(async () => { await assistant.close(); analysis.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const unitId = domain.list(chapter.id)[0].id;
  const event = data => domain.mutate('event.create', { ...scope, revision: store.get('chapters', chapter.id).revision, unitId, entityRevision: store.get('units', unitId).revision, kind: 'environment', description: '轻风穿过窗边', memberId: unitId, position: 'during', state: 'adopted', ...data });
  return { directory, store, domain, project, chapter, scope, unitId, event, analysis, assistant, requests, answers, session, capabilities: assistant.capabilities };
}

async function idle(assistant) {
  for (let i = 0; i < 300 && assistant.active; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(assistant.active, 0);
}

test('RF03-1 persisted event facts enter the actual second model request after scoped reading', async t => {
  const f = fixture(t), marker = '只存在数据库的场景标记RF03';
  f.event({ description: marker });
  f.requests.length = 0;
  f.answers.push(
    { reply: '先读取当前事件', reads: [{ capabilityId: 'read.events', input: { unitId: f.unitId } }] },
    { reply: '当前已有该环境事件。' },
  );
  // Only provider replies are mocked; the real model adapter captures its outgoing JSON.
  await f.assistant.send(f.session.id, { messageId: uid(), text: '现在有哪些背景？', approved: true, materials: ['text'], limits: { assistant: 2, audio: 0, analysis: 0 } });
  await idle(f.assistant);
  assert.equal(f.requests.length, 2, f.assistant.get(f.session.id).runs[0].error);
  assert.ok(!JSON.stringify(f.requests[0]).includes(marker));
  const context = JSON.parse(f.requests[1].messages[1].content);
  assert.equal(context.reads.length, 1);
  assert.equal(context.reads[0].result.items[0].description, marker);
  assert.equal(context.reads[0].result.unitRevision, f.store.get('units', f.unitId).revision);
  assert.equal(f.assistant.get(f.session.id).steps.length, 0);
});

test('event detail preserves states, versions, source quotes and semantic transitions without rewriting history', async t => {
  const f = fixture(t), adopted = f.event({ kind: 'music', description: '旋律逐渐舒展', evidence: { kind: '原文明示', quote: '清晨的风吹过窗边。' }, transition: { memberId: f.unitId, quote: '清晨', occurrence: 1, development: '旋律舒展', volumeChange: '稍增强' } });
  const draft = f.event({ description: '待考虑的关窗声', state: 'draft' }), removed = f.event({ description: '已移除的水滴', state: 'removed' });
  const before = f.store.all('events', f.unitId);
  const result = await f.capabilities.read('read.events', { unitId: f.unitId }, f.scope);
  assert.deepEqual(result.items.map(row => row.state), ['adopted', 'draft', 'removed']);
  assert.equal(result.items.find(row => row.id === adopted.id).transition.quote, '清晨');
  assert.equal(result.items.find(row => row.id === adopted.id).evidence.quote, '清晨的风吹过窗边。');
  for (const id of [adopted.id, draft.id, removed.id]) {
    const detail = await f.capabilities.read('read.events', { unitId: f.unitId, id }, f.scope);
    assert.equal(detail.items[0].revision, 1);
    assert.equal(detail.items[0].validity, 'valid');
    assert.equal(detail.items[0].source.kind, 'user');
  }
  assert.deepEqual(f.store.all('events', f.unitId), before);
});

test('old suggestions are discoverable and free current reuse inspection retains old issues', async t => {
  const f = fixture(t), id = uid(), itemId = uid();
  const suggestion = { id, chapterId: f.chapter.id, unitId: f.unitId, kind: 'scene', status: 'applied', draftVersion: 1, revision: 1, contextRevision: 1, unitRevision: 1, source: 'PRIVATE_FULL_SOURCE', items: [{ id: itemId, unitId: f.unitId, kind: 'environment', description: '轻风', memberId: f.unitId, position: 'during', evidence: '原文明示', sourceQuote: '清晨的风吹过窗边。', issues: ['历史旧问题'] }], batches: undefined, createdAt: '2026-10-01T00:00:00Z' };
  f.store.put('suggestions', suggestion, f.chapter.id);
  const found = await f.capabilities.read('read.suggestions', { unitId: f.unitId }, f.scope);
  assert.equal(found.items[0].id, id);
  assert.equal(found.items[0].itemCount, 1);
  const detail = await f.capabilities.read('read.suggestions', { id, unitId: f.unitId }, f.scope);
  assert.equal(detail.items[0].id, itemId);
  assert.deepEqual(detail.items[0].issues, ['历史旧问题']);
  assert.ok(!JSON.stringify(detail).includes('PRIVATE_FULL_SOURCE'));
  const before = f.store.get('suggestions', id), checked = await f.capabilities.read('analysis.previewReuse', { id, unitId: f.unitId }, f.scope);
  assert.equal(checked.items[0].canReuse, true);
  assert.deepEqual(checked.items[0].historicalIssues, ['历史旧问题']);
  assert.deepEqual(f.store.get('suggestions', id), before);
});

test('existing shared candidate sessions and pending results are discovered without other project data', async t => {
  const f = fixture(t), shared = f.domain.mutate('voice-session.create', { description: '已存在的温和声音' });
  const projectSession = f.domain.mutate('voice-session.create', { description: '本项目声音' });
  f.store.put('voiceSessions', { ...projectSession, projectId: f.project.id });
  const other = f.domain.mutate('project.create', { name: '其他项目' }), privateSession = f.domain.mutate('voice-session.create', { description: '其他项目保密描述' });
  f.store.put('voiceSessions', { ...privateSession, projectId: other.id });
  const jobId = uid(), candidateId = uid();
  f.store.put('jobs', { id: jobId, sessionId: shared.id, kind: 'voice-create', status: 'unknown', request: { key: 'PRIVATE_KEY' } });
  f.store.put('attempts', { id: candidateId, jobId, targetKind: 'candidate', targetId: shared.id, status: 'unknown', input: { description: shared.description, secret: 'PRIVATE_PROMPT' }, prompt: 'PRIVATE_PROMPT', discarded: false }, jobId);
  const found = await f.capabilities.read('read.voiceSession', {}, f.scope);
  assert.deepEqual(found.items.map(row => row.id), [shared.id, projectSession.id]);
  assert.equal(found.items[0].scope, 'shared');
  const detail = await f.capabilities.read('read.voiceSession', { id: shared.id }, f.scope);
  assert.equal(detail.items[0].id, candidateId);
  assert.equal(detail.items[0].status, 'unknown');
  assert.equal(detail.items[0].referenceEligible, false);
  assert.equal(detail.items[0].input.description, shared.description);
  assert.ok(!JSON.stringify([found, detail]).includes('PRIVATE_'));
  await assert.rejects(f.capabilities.read('read.voiceSession', { id: privateSession.id }, f.scope), /超出/);
});

test('large event lists expose pagination omissions and full refers only to declared projected fields', async t => {
  const f = fixture(t);
  for (let i = 0; i < 5; i++) f.event({ description: '事件' + i });
  const first = await f.capabilities.read('read.events', { unitId: f.unitId, limit: 2 }, f.scope);
  assert.equal(first.visibility, 'partial'); assert.equal(first.total, 5); assert.equal(first.nextOffset, 2);
  assert.equal(first.omittedBefore, 0); assert.equal(first.omittedAfter, 3);
  assert.ok(first.projectionFields.includes('description'));
  const next = await f.capabilities.read('read.events', { unitId: f.unitId, offset: first.nextOffset, limit: 3 }, f.scope);
  assert.equal(next.visibility, 'partial'); assert.equal(next.omittedBefore, 2); assert.equal(next.nextOffset, null);
  assert.equal(new Set([...first.items, ...next.items].map(row => row.id)).size, 5);
  const all = await f.capabilities.read('read.events', { unitId: f.unitId }, f.scope);
  assert.equal(all.visibility, 'full'); assert.ok(all.observedAt);
  for (let i = 0; i < 8; i++) f.event({ description: '长'.repeat(1500), state: 'draft', evidence: { kind: '用户创作选择', quote: '引'.repeat(3000), reason: '由'.repeat(3000) } });
  const bounded = await f.capabilities.read('read.events', { unitId: f.unitId, limit: 40 }, f.scope);
  assert.ok(bounded.returned < bounded.total); assert.equal(bounded.visibility, 'partial');
  assert.ok(bounded.nextOffset > 0); assert.ok(JSON.stringify(bounded).length < 52000);
  await assert.rejects(f.capabilities.read('read.events', { unitId: f.unitId, limit: 1000 }, f.scope), /无效/);
});

test('all new business reads reject other chapters, mismatched units and deleted objects', async t => {
  const f = fixture(t), other = f.domain.mutate('project.create', { name: '越界项目' });
  const chapter = f.domain.mutate('chapter.create', { projectId: other.id, title: '保密章', source: '保密正文', segment: true }), foreignUnitId = f.domain.list(chapter.id)[0].id;
  for (const [id, input] of [['read.unit', { id: foreignUnitId }], ['read.events', { unitId: foreignUnitId }], ['read.suggestions', { unitId: foreignUnitId }], ['read.audioHistory', { unitId: foreignUnitId }]]) await assert.rejects(f.capabilities.read(id, input, f.scope), /超出/);
  const foreignSuggestionId = uid(); f.store.put('suggestions', { id: foreignSuggestionId, chapterId: chapter.id, items: [] }, chapter.id);
  await assert.rejects(f.capabilities.read('read.suggestions', { id: foreignSuggestionId }, f.scope), /超出/);
  const event = f.event({ description: '绑定本单元' }), nextUnit = f.domain.list(f.chapter.id)[1].id;
  await assert.rejects(f.capabilities.read('read.events', { unitId: nextUnit, id: event.id }, f.scope), /不属于/);
  f.store.remove('units', f.unitId);
  await assert.rejects(f.capabilities.read('read.unit', { id: f.unitId }, f.scope), /不存在/);
});

test('chapter and automatic context explicitly distinguish summaries from events, suggestions and histories', async t => {
  const f = fixture(t), first = await f.capabilities.read('read.chapter', { limit: 1 }, f.scope);
  assert.equal(first.visibility, 'partial'); assert.equal(first.pages.segments.nextOffset, 1);
  assert.ok(first.omittedSections.includes('events'));
  const context = createAssistantContext({ store: f.store, domain: f.domain, capabilities: f.capabilities })(f.scope);
  assert.equal(context.facts.visibility, 'full');
  assert.ok(context.facts.omittedSections.includes('events'));
  assert.ok(context.facts.projectionFields.segments.includes('text'));
  assert.match(context.instructions.join(' '), /full/);
  const units = await f.capabilities.read('read.unit', {}, f.scope);
  assert.equal(units.items[0].id, f.unitId);
  const unit = await f.capabilities.read('read.unit', { id: f.unitId }, f.scope);
  assert.equal(unit.items[0].variants.scene.backgroundPresence, 'clear');
});

test('audio history discovers original and processed versions through unit ownership without paths or raw prompts', async t => {
  const f = fixture(t), id = uid(), originalId = uid();
  writeFileSync(join(f.directory, 'fixture.wav'), 'fixture');
  const original = { id: originalId, chapterId: f.chapter.id, targetKind: 'single', targetId: f.unitId, path: 'fixture.wav', format: 'wav', duration: 1, input: { unitId: f.unitId, mode: 'dry', text: '清晨的风吹过窗边。' }, prompt: 'PRIVATE_FULL_PROMPT' };
  f.store.put('audios', original, f.chapter.id);
  f.store.put('audios', { ...original, id, originalAudioId: originalId, originalAvailability: 'retained', processingVersion: 'tail-v1', processing: { trimmedDuration: 0.2 } }, f.chapter.id);
  const result = await f.capabilities.read('read.audioHistory', { unitId: f.unitId, mode: 'dry' }, f.scope);
  assert.deepEqual(result.items.map(row => row.id), [originalId, id]);
  assert.equal(result.items[1].originalAudioId, originalId);
  assert.equal(result.items[1].available, true);
  assert.ok(!JSON.stringify(result).includes('fixture.wav'));
  assert.ok(!JSON.stringify(result).includes('PRIVATE_FULL_PROMPT'));
});

test('event reread observes changes and stale previews cannot overwrite a newer version', async t => {
  const f = fixture(t), event = f.event({ description: '原风声' });
  const before = await f.capabilities.read('read.events', { unitId: f.unitId, id: event.id }, f.scope);
  const input = { id: event.id, unitId: f.unitId, description: '助手提案' }, preview = await f.capabilities.preview('event.update', input, f.scope);
  f.domain.mutate('event.update', { ...f.scope, revision: f.store.get('chapters', f.chapter.id).revision, id: event.id, unitId: f.unitId, entityRevision: f.store.get('units', f.unitId).revision, eventRevision: event.revision, description: '人工新版风声' });
  const after = await f.capabilities.read('read.events', { unitId: f.unitId, id: event.id }, f.scope);
  assert.equal(after.items[0].revision, before.items[0].revision + 1);
  assert.equal(after.items[0].description, '人工新版风声');
  await assert.rejects(f.capabilities.execute('event.update', input, f.scope, { actorKind: 'human_approved_proposal', operationId: uid(), baseRevisions: preview.baseRevisions, preview: preview.preview }), /已变化/);
});
