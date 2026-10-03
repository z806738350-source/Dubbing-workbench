import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { fail, same, text, uid } from './store.mjs';
import { compile, templateOf, resolveCompiler, sceneContract, validEventDescription, assertQuoteAnchor, sceneIntentConflicts } from './templates.mjs';
import { storedAudioUnavailable } from './audio.mjs';
import { configurationDecided } from './experience.mjs';

export const sampleText = '清晨的风吹过窗边，我把桌上的书合上，准备出门。';
export const defaultFeatures = { voiceCreation: true, groups: true, scenes: true };
const active = j => ['queued', 'running'].includes(j.status);
const stamp = () => new Date().toISOString();
const persisted = value => JSON.parse(JSON.stringify(value));
const rates = c => [c?.speech_rate, c?.loudness_rate, c?.pitch_rate];
const variant = () => ({ current: null, previous: null, approved: null, review: null, latest: 'none', revision: 1, guidance: '' });
const revision = (u, expected) => { if (expected !== (u.revision ?? 1)) fail('资料已在其他页面更新，请核对当前版本', 409); };
const contentRevision = s => s.contentRevision ?? s.revision;
const eventInput = e => {
  const { id, kind, description, memberId, position, startMemberId, endMemberId, startPosition, endPosition } = e;
  return { id, kind, description, memberId, position, startMemberId, endMemberId, startPosition, endPosition, ...(e.transition ? {transition:e.transition} : {}) };
};

// A single unit has the segment primary key. Its dry fields are a controlled
// compatibility mirror; group/scene selections never write segment.current.
export function createEnhancement(store, d) {
  const features = () => ({ ...defaultFeatures, ...store.maybe('settings', 'models')?.features });
  const enabled = key => { if (!features()[key]) fail('此增强功能已关闭，已有资源仍可查看和处理'); };
  function syncLegacySegment(s) {
    let u = store.maybe('units', s.id);
    if (!u) u = { id: s.id, chapterId: s.chapterId, kind: 'single', members: [s.id], state: 'active', revision: 1, membershipRevision: 1, mode: 'dry', guidance: '', variants: { dry: variant(), scene: {...variant(),template:'scene-v2'} }, createdAt: stamp() };
    u.state = s.retired ? 'retired' : 'active';
    const before = u.variants.dry;
    const dry = { ...before, current: s.current || null, previous: s.previous || null, approved: s.approved || null, review: s.review || null, latest: s.latest || 'none' };
    if (!same(before, dry) || !store.maybe('units', s.id) || store.get('units', s.id).state !== u.state) {
      u.variants.dry = dry;
      store.put('units', u, s.chapterId);
    }
    return u;
  }
  const syncLegacy = () => { for (const s of store.all('segments')) syncLegacySegment(s); };
  store.transaction(() => {
    const schema = store.maybe('settings', 'data-schema');
    if (schema && schema.version > 3) fail('数据模式高于此版本，请使用匹配版本或恢复对应备份');
    syncLegacy();
    invalidateEvents();
    if (!schema || schema.version < 3) store.put('settings', { id: 'data-schema', version: 3, migratedAt: stamp(), migrations: [...(schema?.migrations || []), { version: 3, at: stamp(), singleUnits: store.all('units').length, capabilities:['immutable-scene-compiler','candidate-content-revision','scoped-unknown-decision','idempotent-chapter-create','structural-decisions'] }] });
    store.protectSchema();
  });
  function getUnit(id) { return store.get('units', id); }
  function members(u) {
    if (!u.members.length) fail('生成单元没有成员，请先解除组并核对', 409);
    const rows = u.members.map(id => store.get('segments', id));
    if (rows.some(s => s.retired || s.excluded || s.chapterId !== u.chapterId)) fail('生成单元成员已变化，请先解除组并核对', 409);
    if (rows.some(s => typeof s.text !== 'string' || !s.text.trim())) fail('生成单元成员正文为空，请先解除组并核对', 409);
    if (rows.length === 1) return rows; // One existing member is always a contiguous chapter range.
    const all = d.list(u.chapterId), start = all.findIndex(s => s.id === u.members[0]);
    if (!same(all.slice(start, start + rows.length).map(s => s.id), u.members)) fail('组成员顺序或连续范围已变化', 409);
    return rows;
  }
  function eventBasis(u, e) {
    const ids = [...new Set([...(e.startMemberId ? [e.startMemberId, e.endMemberId] : [e.memberId]),...(e.transition ? [e.transition.memberId] : [])])];
    const c = store.get('chapters',u.chapterId);
    const sourceBasis = ['原文明示','上下文推断'].includes(e.evidence?.kind) ? { evidenceSource: c.source ? {version:c.sourceVersion || 1} : {script:members(u).map(s=>s.text).join('\n')} } : {};
    return { ...sourceBasis, membershipRevision: u.membershipRevision, members: u.members, anchors: ids.map(id => {
      const s = store.get('segments', id);
      return { id, text: s.text, roleId: s.roleId, type: s.type, excluded: s.excluded, retired: !!s.retired };
    }) };
  }
  function eventView(e, u = getUnit(e.unitId)) {
    let valid = false; const diagnostics = [];
    try { assertEventRange(u, e); valid = u.state !== 'dissolved' && same(e.basis, eventBasis(u, e)); } catch (error) { diagnostics.push(error.message); }
    return { ...e, diagnostics, validity: valid && !e.needsReview ? 'valid' : 'needsReview' };
  }
  function invalidateEvents(chapterId) {
    for (const u of store.all('units', chapterId)) for (const e of store.all('events', u.id)) {
      if (!e.needsReview && eventView(e, u).validity === 'needsReview') {
        e.needsReview = true;
        store.put('events', e, u.id);
      }
    }
  }
  const events = u => store.all('events', u.id).map(e => eventView(e, u));
  function buildInput(u, mode = u.mode, model, forGeneration = false, validatePrompt = true, chapter) {
    if (!['dry', 'scene'].includes(mode)) fail('生成类型无效');
    const rows = members(u), first = rows[0];
    const c = chapter || store.get('chapters', u.chapterId);
    for (const s of rows) d.validate(s, c);
    if (forGeneration && rows.some(s => !configurationDecided(s) || !s.voiceId)) fail('请先完成全部成员的角色和声音身份确认');
    if (rows.some(s => !same(s.config, first.config) || (s.model || 'seed-audio-1.0') !== (first.model || 'seed-audio-1.0'))) fail('成员数值配置或模型不同，请先明确统一设置', 409);
    if (u.kind === 'group' && rows.some(s => s.template !== first.template)) fail('成员模板不同，请先明确统一模板', 409);
    const referenceVoiceIds = [], slots = [];
    for (const s of rows) {
      const previous = slots.find(v => v.roleId === s.roleId);
      if (previous && previous.voiceId !== s.voiceId) fail('同角色成员使用不同实际音色，请先明确统一', 409);
      if (s.voiceId && !referenceVoiceIds.includes(s.voiceId)) referenceVoiceIds.push(s.voiceId);
      if (!previous) slots.push({ speaker: String.fromCharCode(65 + slots.length), roleId: s.roleId, voiceId: s.voiceId, reference: referenceVoiceIds.indexOf(s.voiceId) + 1 });
    }
    if (referenceVoiceIds.length > 3) fail('本组超过三份实际参考音频，请缩小范围');
    const selected = mode === 'scene' ? events(u).filter(e => e.state === 'adopted') : [];
    if (validatePrompt && selected.some(e => e.validity !== 'valid')) fail('场景事件已失效，请重新确认或明确移除后再生成', 409);
    const v = u.variants[mode];
    const guidance = v.guidance ?? (mode === 'dry' ? u.guidance || '' : '');
    const template = v.template || (mode === 'scene' ? 'scene-v1' : u.kind === 'single' ? first.template : 'dialogue-dry-v1');
    const input = { targetKind: 'unit', unitId: u.id, mode, model: model || first.model || 'seed-audio-1.0', template, config: first.config, members: rows.map(s => ({ id: s.id, roleId: s.roleId, type: s.type, text: s.text, voiceId: s.voiceId, performance: s.performance })), slots, referenceVoiceIds, guidance, events: selected.map(eventInput), ...(mode==='scene' && v.backgroundPresence ? {backgroundPresence:v.backgroundPresence} : {}), ...(v.resolvedCompilerId ? {compilerId:v.resolvedCompilerId} : {}) };
    if (template==='scene-v4-presence-1') input.constraintSources={guidance:v.guidanceSource || {kind:guidance?'inherited_user':'system_default'},backgroundPresence:v.backgroundPresenceSource || {kind:'system_default'},events:selected.map(e=>({id:e.id,source:e.source || {kind:e.evidence?.suggestionId?'adopted_ai':'inherited_user'}}))};
    if (u.kind === 'single' && mode === 'dry') Object.assign(input, d.inputOf(first), v.template ? {template:v.template} : {});
    if (!validatePrompt) return input;
    const prompt = compile(input);
    if (Array.from(prompt).length > sceneContract.promptMax) fail('完整提示超过 3000 字符，请缩减指导或拆小范围；未发送');
    if (mode === 'dry') {
      const issues = [...rows.flatMap(s => d.performanceIssues(s)), ...d.performanceIssues({template:'dry-v1',performance:guidance})];
      if (issues.length) fail('干声指导与音乐或音效冲突，请调整或选择场景');
    }
    return input;
  }
  function basis(u, mode = u.mode) {
    const rows = members(u);
    if (u.kind === 'single' && mode === 'dry') return d.basisOf(rows[0]);
    return persisted({ unitId: u.id, mode, membershipRevision: u.membershipRevision, members: rows.map(d.basisOf), guidance: u.variants[mode].guidance ?? (mode === 'dry' ? u.guidance || '' : ''), ...(mode==='scene' && u.variants[mode].backgroundPresence ? {backgroundPresence:u.variants[mode].backgroundPresence} : {}), events: mode === 'scene' ? events(u).filter(e => e.state === 'adopted').map(e => ({ ...eventInput(e), basis: e.basis, validity: e.validity })) : [] });
  }
  function requestIdentity(input, prompt) {
    return [input.model || 'seed-audio-1.0', prompt ?? compile(input), input.referenceVoiceIds || (input.voiceId ? [input.voiceId] : []), rates(input.config)];
  }
  const compatibleReviewBasis = (u, mode, review, audio) => u.kind === 'single' && mode === 'dry' ? d.reviewBasis(review?.basis, audio?.model) : review?.basis;
  function status(u, mode = u.mode, chapter) {
    const v = u.variants[mode], a = v.current ? store.maybe('audios', v.current) : null;
    let input = null, currentBasis = null, prompt = '', promptIssues = [];
    try { input = buildInput(u, mode, undefined, false, true, chapter); currentBasis = basis(u, mode); prompt = compile(input); } catch(e) { promptIssues = [e.message]; }
    const validity = !a ? 'missing' : storedAudioUnavailable(store, a) ? 'broken' : input && same(requestIdentity(input, prompt), requestIdentity(a.input, a.prompt)) ? 'matched' : 'stale';
    const review = validity === 'matched' && v.review?.audioId === v.current && same(compatibleReviewBasis(u,mode,v.review,a), currentBasis) ? v.review.state : 'pending';
    return { validity, review, audio: a, basis: currentBasis, prompt, promptIssues, input };
  }
  function history(u, mode, chapter, currentStatus) {
    const refs = [u.variants[mode].current,u.variants[mode].previous,u.variants[mode].approved];
    let identity = null;
    try { const input = currentStatus ? currentStatus.input : buildInput(u,mode,undefined,false,true,chapter); if (input) identity = requestIdentity(input); } catch { /* invalid targets retain readable history */ }
    return store.unitHistory(u,mode,refs).filter(a => {
      if (a.input?.unitId === u.id) return (a.input.mode || a.mode || 'dry') === mode;
      if (u.kind !== 'single' || mode !== 'dry') return false;
      return a.targetKind === 'single' && a.targetId === u.id || refs.includes(a.id) || store.maybe('attempts',a.id)?.segmentId === u.id;
    }).map(a => { let matched = false, available = false; try { available = !storedAudioUnavailable(store,a); matched = !!identity && available && same(identity,requestIdentity(a.input,a.prompt)); } catch {} return { ...a, available, matched, selected: u.variants[mode].current === a.id }; });
  }
  function restorePlan(u, mode, audioId) {
    if (!['dry','scene'].includes(mode)) fail('目标类型无效');
    if (['dissolved','retired'].includes(u.state)) fail('这段已解除或移除，只能试听历史声音',409);
    const audio = history(u,mode).find(a => a.id === audioId);
    if (!audio) fail('这份历史声音不属于当前这段或声音类型，请重新选择',409);
    if (!audio.available) fail('这份历史声音文件损坏或缺失，不能恢复使用',409);
    if (!audio.input) fail('这份历史声音缺少生成设置，不能恢复使用，请重新生成',409);
    // Current replaceable guidance/events need not compile. Protect the actual
    // script, voices and parameters before constructing a legal old candidate.
    const input = buildInput(u,mode,undefined,false,false);
    const protectedMembersMatch = audio.input.members ? same(input.members,audio.input.members) : u.kind==='single' && mode==='dry' && same([input.text,input.voiceId,input.performance],[audio.input.text,audio.input.voiceId,audio.input.performance]);
    if (!protectedMembersMatch || !same(input.referenceVoiceIds,audio.input.referenceVoiceIds || (audio.input.voiceId ? [audio.input.voiceId] : [])) || !same(input.config,audio.input.config) || (input.model || 'seed-audio-1.0') !== (audio.input.model || 'seed-audio-1.0'))
      fail('正文、角色、参考声音或成员设置已变化，不能直接恢复这份旧声音；请核对当前台词后重新生成',409);
    const currentEvents = store.all('events',u.id), conflicts = [];
    const restoredEvents = mode === 'scene' ? (audio.input.events || []).map(saved => {
      const existing = store.maybe('events',saved.id);
      if (existing && existing.unitId !== u.id) fail('历史声音事件已不属于当前这段，不能恢复',409);
      if (existing?.state === 'draft') conflicts.push(`历史事件 ${saved.id} 与未采用草稿同ID；请先保留并处理这份草稿`);
      const savedSource = audio.input.constraintSources?.events?.find(e=>e.id===saved.id)?.source;
      if (savedSource && existing?.source && !same(savedSource,existing.source)) conflicts.push(`历史事件 ${saved.id} 的来源已改变；请先核对来源`);
      return validateEvent(u,{ ...existing,...saved,state:'adopted',evidence:existing?.evidence });
    }) : [];
    const resolvedCompilerId = resolveCompiler(audio.input,audio.prompt);
    if (!resolvedCompilerId) fail('这份历史提示无法由已保存的编译版本精确重现；仍可试听，不能恢复使用',409);
    const candidateInput = {...input,template:audio.input.template,guidance:audio.input.guidance || '',events:restoredEvents.map(eventInput)};
    delete candidateInput.compilerId; delete candidateInput.backgroundPresence;
    if (audio.input.template === 'scene-v3-native' || audio.input.compilerId) candidateInput.compilerId = resolvedCompilerId;
    if (audio.input.backgroundPresence) candidateInput.backgroundPresence = audio.input.backgroundPresence;
    const candidatePrompt = compile(candidateInput);
    if (Array.from(candidatePrompt).length > sceneContract.promptMax) fail('历史候选完整提示超过3000个Unicode字符，不能恢复使用');
    if (candidatePrompt !== audio.prompt || !same(requestIdentity(candidateInput,candidatePrompt),requestIdentity(audio.input,audio.prompt))) fail('历史候选不能精确重现原声音的请求，不能恢复使用',409);
    let changed = true;
    try { changed = !same(requestIdentity(input),requestIdentity(audio.input,audio.prompt)); } catch { /* Invalid current settings are the fields being replaced. */ }
    const changedAdoptedEvents = {removedIds:currentEvents.filter(e=>e.state==='adopted' && !restoredEvents.some(saved=>same(eventInput(saved),eventInput(e)))).map(e=>e.id),restoredIds:restoredEvents.filter(saved=>!currentEvents.some(e=>e.state==='adopted' && same(eventInput(saved),eventInput(e)))).map(e=>e.id)};
    const baseRevisions = {chapter:store.get('chapters',u.chapterId).revision,unit:u.revision,scene:u.variants.scene.revision,eventRevisions:currentEvents.map(({id,revision,state})=>({id,revision,state}))};
    return { audio,input,changed,restoredEvents,candidateInput,resolvedCompilerId,targetCompilerIdentity:resolvedCompilerId,changedAdoptedEvents,preservedDraftIds:currentEvents.filter(e=>e.state==='draft').map(e=>e.id),conflicts,baseRevisions,resultWouldMatch:conflicts.length===0,blockers:conflicts };
  }
  function view(u, chapter) {
    chapter ||= store.maybe('chapters',u.chapterId);
    const diagnostics = []; try { members(u); } catch (error) { diagnostics.push(error.message); }
    const states = Object.fromEntries(['dry','scene'].map(mode=>[mode,status(u,mode,chapter)]));
    let sceneConflicts=[];try { sceneConflicts=sceneIntentConflicts(states.scene.input || buildInput(u,'scene',undefined,false,false,chapter)); } catch { /* Structural diagnostics above retain the root reason. */ }
    return { ...u, diagnostics, sceneConflicts, guidance: u.variants[u.mode].guidance ?? (u.mode === 'dry' ? u.guidance || '' : ''), variants: Object.fromEntries(['dry', 'scene'].map(mode => [mode, { ...u.variants[mode], status: states[mode], history:history(u,mode,chapter,states[mode]) }])), status: states[u.mode], events: events(u) };
  }
  function resolve(chapterId, chapter) {
    const all = d.list(chapterId);
    for (const s of all) syncLegacySegment(s);
    const included = all.filter(s => !s.excluded), units = store.all('units', chapterId);
    const groups = units.filter(u => u.kind === 'group' && u.state === 'active');
    const owner = new Map();
    for (const u of groups) { members(u); for (const id of u.members) { if (owner.has(id)) fail('当前编排重复覆盖成员', 409); owner.set(id, u); } }
    const result = [], seen = new Set();
    for (const s of included) {
      const u = owner.get(s.id) || getUnit(s.id);
      if (seen.has(u.id)) continue;
      seen.add(u.id);
      const st = status(u,u.mode,chapter);
      result.push({ s: { id: u.id, unitId: u.id, members: u.members, mode: u.mode, kind: u.kind, chapterId: u.chapterId }, a: st.audio, basis: st.basis, validity: st.validity, review: st.review, promptIssues: st.promptIssues });
    }
    if (!same(result.flatMap(r => r.s.members), included.map(s => s.id))) fail('当前编排必须按章顺序覆盖每条有效台词一次', 409);
    return result;
  }
  function inspectArrangement(chapterId, chapter) {
    try { return { rows: resolve(chapterId,chapter), issues: [] }; }
    catch (error) { return { rows: [], issues: [error.message] }; }
  }
  function setReview(u, mode, state, currentBasis) {
    const v = u.variants[mode];
    v.review = { audioId: v.current, basis: currentBasis, state, at: stamp() };
    if (state === 'passed') v.approved = v.current;
    store.put('units', u, u.chapterId);
    const a = store.get('audios', v.current); a.review = v.review; store.put('audios', a, u.chapterId);
    if (u.kind === 'single' && mode === 'dry') {
      const s = store.get('segments', u.members[0]);
      Object.assign(s, { review: v.review, approved: v.approved }); store.put('segments', s, u.chapterId);
    }
  }
  function prepareRender(p, c) {
    const rows = resolve(c.id), all = d.list(c.id), included = all.filter(s => !s.excluded);
    if (!rows.length) fail('章节没有有效朗读片段');
    if (rows.some(r => r.validity !== 'matched')) fail('仍有单元缺少匹配音频，请完成生成后重试');
    const reviewItems = rows.map(r => ({ id: r.s.id, audioId: r.a.id, basis: r.basis }));
    let confirmation;
    if (p.kind === 'export') {
      if (!['wav', 'mp3'].includes(p.format)) fail('导出格式无效');
      if (!d.coverage(c, all).valid) fail('原文覆盖不完整，不能正式导出');
      if (included.some(s => !configurationDecided(s))) fail('请完成角色和声音身份核对');
      if (rows.some(r => r.review === 'rework')) fail('仍有需返工的单元');
      if (p.arrangement !== c.arrangement || !same(p.reviewItems, reviewItems)) fail('章节版本已变化，请重新检查后导出', 409);
      if (!p.confirm && rows.some(r => r.review !== 'passed')) fail('请先确认待检查的音频');
      if (p.confirm) for (const r of rows) if (r.review !== 'passed') setReview(getUnit(r.s.id), r.s.mode, 'passed', r.basis);
      confirmation = { at: stamp(), arrangement: c.arrangement, reviewItems };
    }
    return { rows, reviewItems, confirmation, ids: rows.map(r => r.s.id), total: rows.length };
  }
  function groupPlan(p) {
    const c = d.editable(p.chapterId, p.revision);
    if (!Array.isArray(p.ids) || p.ids.length < 2 || new Set(p.ids).size !== p.ids.length) fail('请选择至少两条连续有效台词');
    const rows = d.list(c.id), start = rows.findIndex(s => s.id === p.ids[0]);
    if (!same(rows.slice(start, start + p.ids.length).map(s => s.id), p.ids) || rows.slice(start, start + p.ids.length).some(s => s.excluded)) fail('只能选择同章按真实顺序连续的有效台词');
    if (store.all('units', c.id).some(u => u.kind === 'group' && ['active', 'pending'].includes(u.state) && u.members.some(id => p.ids.includes(id)))) fail('成员已属于活动或待生成组，请先解除', 409);
    const u = { id: uid(), chapterId: c.id, kind: 'group', members: p.ids, state: 'pending', revision: 1, membershipRevision: 1, mode: 'dry', guidance: p.guidance || '', variants: { dry: variant(), scene: {...variant(),template:'scene-v2'} }, createdAt: stamp() };
    if (typeof u.guidance !== 'string' || u.guidance.length > 2000) fail('组指导最多 2000 字');
    u.variants.dry.guidance = u.guidance;
    const input = buildInput(u, 'dry', undefined, true);
    return { unit: u, members: p.ids.map(id => store.get('segments', id)), input, prompt: compile(input), conflicts: [] };
  }
  function assertStructural(action, p) {
    const ids = p.ids || (p.id ? [p.id] : []);
    if (action === 'segment.merge') { const rows = d.list(p.chapterId), next = rows[rows.findIndex(s => s.id === p.id) + 1]; if (next) ids.push(next.id); }
    const structural = ['segment.split', 'segment.merge', 'chapter.source', 'chapter.resegment'].includes(action) || action === 'segment.update' && p.excluded !== undefined && p.excluded !== store.get('segments',p.id).excluded;
    if (structural && store.all('units', p.chapterId).some(u => u.kind === 'group' && ['active', 'pending'].includes(u.state) && (!ids.length || u.members.some(id => ids.includes(id))))) fail('结构修改前请先解除相关活动或待生成组', 409);
    if (['segment.review','segment.restore'].includes(action) && store.all('units', p.chapterId).some(u => u.kind === 'group' && u.state === 'active' && u.members.includes(p.id))) fail('当前按整组检查或恢复，请使用组版本操作', 409);
  }
  function assertEventRange(u, e) {
    const positions = ['before','during','after'];
    if (e.startMemberId || e.endMemberId) {
      const start = u.members.indexOf(e.startMemberId), end = u.members.indexOf(e.endMemberId);
      if (start < 0 || end < start) fail('持续声音事件边界不属于本单元或顺序错误');
      const startPosition = e.startPosition || 'before', endPosition = e.endPosition || 'after';
      if (![startPosition, endPosition].every(v => positions.includes(v))) fail('声音事件位置无效');
      if (start === end && positions.indexOf(startPosition) > positions.indexOf(endPosition)) fail('持续声音事件的结束位置早于开始位置，语义范围顺序错误');
    } else {
      if (!u.members.includes(e.memberId) || !positions.includes(e.position)) fail('事件锚点必须是本单元的明确成员ID及位置');
    }
    if (e.transition) {
      if (e.kind !== 'music') fail('转折发展仅用于音乐事件');
      assertQuoteAnchor(members(u),e.transition);
      const ids = e.startMemberId ? u.members.slice(u.members.indexOf(e.startMemberId),u.members.indexOf(e.endMemberId)+1) : [e.memberId];
      if (!ids.includes(e.transition.memberId)) fail('转折引文必须在该音乐的采用范围内');
    }
  }
  function validateEvent(u, item) {
    if (!['environment', 'effect', 'music'].includes(item.kind)) fail('声音事件类型无效');
    if (!validEventDescription(item.description)) fail(`声音事件描述不能为空，且不能超过 ${sceneContract.descriptionMax} 个 Unicode 字符`);
    const e = { ...item, id: item.id || uid(), unitId: u.id, description: item.description, state: item.state || 'draft' };
    if (!['draft', 'adopted', 'removed'].includes(e.state)) fail('声音事件采用状态无效');
    assertEventRange(u, e);
    if (e.startMemberId || e.endMemberId) { e.startPosition ||= 'before'; e.endPosition ||= 'after'; }
    const evidence = e.evidence || { kind: '用户创作选择', quote: '', reason: '' };
    if (!['原文明示','上下文推断','创作建议','用户创作选择'].includes(evidence.kind)) fail('声音事件依据分类无效');
    if (typeof (evidence.quote || '') !== 'string' || typeof (evidence.reason || '') !== 'string' || (evidence.quote || '').length > 3000 || (evidence.reason || '').length > 3000) fail('声音事件依据格式无效');
    const chapter = store.get('chapters', u.chapterId);
    const evidenceSource = chapter.source || members(u).map(s=>s.text).join('\n');
    const quotes = evidence.quotes === undefined ? [evidence.quote] : evidence.quotes;
    const normalized = value => value.replace(/\r\n?/g,'\n').trim();
    if (evidence.quotes !== undefined && (!Array.isArray(quotes) || !quotes.length || quotes.some(q => typeof q !== 'string' || !q.trim() || q.length > 3000) || normalized(evidence.quote || '') !== normalized(quotes.join('\n')))) fail('依据展示与逐字引文片段不一致');
    if (['原文明示','上下文推断'].includes(evidence.kind) && (!evidence.quote || quotes.some(q => !evidenceSource.includes(q)) || evidence.kind === '上下文推断' && !evidence.reason?.trim())) fail('明示或推断事件需要本章逐字引文，推断需要说明');
    if (e.transition && (typeof e.transition.development !== 'string' || !e.transition.development.trim() || Array.from(e.transition.development).length > 500 || e.transition.volumeChange !== undefined && (typeof e.transition.volumeChange !== 'string' || Array.from(e.transition.volumeChange).length > 200))) fail('转折发展或音量变化描述无效');
    e.evidence = evidence; e.source ||= {kind:item.evidence?.suggestionId ? 'adopted_ai' : 'user',...(item.evidence?.suggestionId ? {suggestionId:item.evidence.suggestionId} : {})}; e.basis = eventBasis(u, e); e.revision = item.revision || 1; e.needsReview = false;
    return e;
  }
  function addEvents(unitId, items, expectedRevision) {
    const u = getUnit(unitId);
    if (u.state === 'dissolved' || u.state === 'retired') fail('生成单元已解除', 409);
    if (expectedRevision !== undefined) revision(u, expectedRevision);
    members(u);
    const records = items.map(item => validateEvent(u, { ...item, id: uid(), revision: 1 }));
    records.forEach(e => store.put('events', e, u.id));
    u.revision++; u.variants.scene.revision++; store.put('units', u, u.chapterId);
    const c = store.get('chapters', u.chapterId); d.touch(c, true, false);
    return records.map(e => eventView(e, u));
  }
  function snapshot() {
    return { schemaVersion: 3, sceneContract, features: features(), voiceSessions: store.all('voiceSessions').map(s => ({ ...s, candidates: store.all('jobs').filter(j => j.sessionId === s.id).flatMap(j => store.all('attempts', j.id).map(a => {
      const audio = store.maybe('audios', a.id), saved = store.maybe('voices', a.id);
      return { id: a.id, jobId: j.id, status: a.status, error: a.error || j.error, audioId: audio?.id, savedVoiceId: saved?.sourceAudioId === a.id ? saved.id : undefined, input: a.input, prompt: a.prompt, referenceEligible: !!audio && !storedAudioUnavailable(store,audio) && audio.duration > 0 && audio.duration <= 30 && /^(wav|mp3)$/.test(audio.format || '') && existsSync(join(store.directory, audio.path)) && statSync(join(store.directory, audio.path)).size > 0 && statSync(join(store.directory, audio.path)).size <= 10 * 1024 * 1024, discarded: !!a.discarded, late: a.adopted === false };
    })) })) };
  }
  function prepare(p, config) {
    if (p.kind === 'voice-create') {
      enabled('voiceCreation');
      const s = store.get('voiceSessions', p.sessionId); revision(s, p.entityRevision);
      if (s.state !== 'active') fail('候选会话已放弃，请新建描述');
      if (store.all('jobs').some(j => j.sessionId === s.id && active(j))) fail('该声音会话已有活动任务', 409);
      const input = { targetKind: 'candidate', sessionId: s.id, description: s.description, text: s.text, model: s.model || config.model, template: s.template, config: s.config, referenceVoiceIds: [] };
      const prompt = compile(input); if (Array.from(prompt).length > 3000) fail('完整声音描述提示超过 3000 字符');
      return { job: { chapterId: '', targetKind: 'candidate', sessionId: s.id, sessionRevision: s.revision,sessionContentRevision:contentRevision(s) }, attempts: [{ targetKind: 'candidate', targetId: s.id, input, basis: { sessionId: s.id, revision: contentRevision(s) } }] };
    }
    if (p.kind !== 'unit-generate') fail('增强任务类型无效');
    const c = d.editable(p.chapterId, p.revision), ids = p.unitIds || (p.unitId ? [p.unitId] : []);
    if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length) fail('请选择生成单元');
    const selectedUnits = ids.map(getUnit), covered = new Set();
    for (const unit of selectedUnits) for (const id of unit.members) { if (covered.has(id)) fail('同批生成目标重复覆盖成员，请选择真实生成单元',409); covered.add(id); }
    const attempts = ids.map(id => {
      const u = getUnit(id); if (u.chapterId !== c.id || ['dissolved','retired'].includes(u.state)) fail('单元已变化', 409);
      const mode = p.mode || u.mode;
      if (u.kind === 'single' && store.all('units',c.id).some(g => g.kind === 'group' && g.state === 'active' && g.members.includes(u.id))) fail('成员属于活动组，请按组生成或先解除分组',409);
      if (u.kind === 'group') enabled('groups'); if (mode === 'scene') enabled('scenes');
      const input = buildInput(u, mode, undefined, true);
      for (const id of input.referenceVoiceIds) {
        const v = store.get('voices', id);
        if (!['active','archived'].includes(v.state) || v.deletePending || !v.path || !existsSync(join(store.directory, v.path))) fail('参考声音已停用、删除或文件缺失');
      }
      return { targetKind: 'unit', targetId: u.id, unitId: u.id, mode, unitRevision: u.revision, membershipRevision: u.membershipRevision, input, basis: basis(u, mode) };
    });
    return { job: { chapterId: c.id, revision: c.revision, targetKind: 'unit', unitIds: ids, mode: p.mode }, attempts };
  }
  function validateDispatch(job, a) {
    if (a.targetKind === 'candidate') {
      const s = store.get('voiceSessions', a.targetId);
      if (s.state !== 'active' || (store.maybe('attempts',a.id) || a).discarded || contentRevision(s) !== (job.sessionContentRevision ?? job.sessionRevision)) fail('声音描述已修改、候选已放弃或会话放弃，本次未发送', 409);
    } else if (a.targetKind === 'unit') {
      const u = getUnit(a.unitId || a.targetId), c = store.get('chapters', u.chapterId);
      if (['dissolved','retired'].includes(u.state) || c.revision !== job.revision || u.revision !== a.unitRevision || u.membershipRevision !== a.membershipRevision || !same(basis(u, a.mode), a.basis)) fail('生成单元、设置或章节修订已变化，本次未发送', 409);
      buildInput(u, a.mode, undefined, true);
    }
  }
  function register(job, a, audio) {
    if (a.targetKind === 'candidate') {
      const s = store.get('voiceSessions', a.targetId);
      return active(job) && s.state === 'active' && !(store.maybe('attempts',a.id) || a).discarded && contentRevision(s) === (job.sessionContentRevision ?? job.sessionRevision);
    }
    const u = getUnit(a.unitId || a.targetId), c = store.get('chapters', u.chapterId);
    const history = store.all('attempts'), later = history.slice(history.findIndex(v => v.id === a.id) + 1).some(v => v.targetKind === 'unit' && (v.unitId || v.targetId) === u.id && v.mode === a.mode);
    if (!active(job) || ['dissolved','retired'].includes(u.state) || later || c.revision !== job.revision || u.revision !== a.unitRevision || !same(basis(u, a.mode), a.basis)) return false;
    const v = u.variants[a.mode], old = v.current;
    if (old !== audio.id) v.previous = old;
    v.current = audio.id; v.review = null; v.latest = 'success';
    const changed = u.mode !== a.mode || u.state === 'pending' || old !== audio.id;
    u.mode = a.mode; u.state = 'active'; store.put('units', u, c.id);
    if (u.kind === 'single' && a.mode === 'dry') { const s = store.get('segments', u.members[0]); Object.assign(s, { current: v.current, previous: v.previous, review: null, latest: 'success' }); store.put('segments', s, c.id); }
    if (changed) d.touch(c, false, true);
    return true;
  }
  function setAttemptStatus(job, a, state) {
    if (a.targetKind !== 'unit') return;
    const u = getUnit(a.unitId || a.targetId);
    const history = store.all('attempts'), newer = history.slice(history.findIndex(v => v.id === a.id) + 1).some(v => v.targetKind === 'unit' && (v.unitId || v.targetId) === u.id && v.mode === a.mode);
    if (!active(job) || newer || ['dissolved','retired'].includes(u.state) || u.revision !== a.unitRevision) return;
    u.variants[a.mode].latest = state; store.put('units', u, u.chapterId);
    if (u.kind === 'single' && a.mode === 'dry') { const s = store.get('segments', u.members[0]); s.latest = state; store.put('segments', s, u.chapterId); }
  }
  function preview(p) {
    if (p.kind === 'group') return groupPlan(p);
    const c = d.editable(p.chapterId, p.revision), u = getUnit(p.id);
    if (u.chapterId !== c.id) fail('单元不属于当前章'); revision(u, p.entityRevision);
    if (p.kind === 'dissolve') return { unit: view(u), items: dissolvePlan(u), arrangement: c.arrangement, events: events(u).filter(e => e.state === 'adopted') };
    const mode = p.mode || u.mode;
    if (p.kind === 'restore') {
      const plan = restorePlan(u,mode,p.audioId), { audio:a,input } = plan, differences = [];
      if (!same(input.members,a.input.members)) differences.push('成员正文、角色或表演设置不同'); if (!same(input.referenceVoiceIds,a.input.referenceVoiceIds)) differences.push('实际参考声音不同'); if (!same(input.config,a.input.config)) differences.push('有效数值配置不同'); if (input.template !== a.input.template) differences.push('提示模板不同'); if (input.guidance !== a.input.guidance) differences.push('单元指导不同'); if (!same(input.events,a.input.events)) differences.push('已采用声音事件不同');
      if ((input.compilerId || input.template) !== plan.resolvedCompilerId) differences.push('精确历史编译版本不同');
      if (input.backgroundPresence !== a.input.backgroundPresence) differences.push('背景存在感不同');
      const {audio,restoredEvents,changed,...publicPlan} = plan;
      return { ...publicPlan,input:a.input,basis:a.basis,currentInput:input,differences,identityChanged:!same(a.basis,basis(u,mode)) };
    }
    const input = buildInput(u, mode);
    if (p.kind === 'template') return { before: compile(input), after: compile({ ...input, template: p.template }), from: input.template, to: p.template };
    fail('预览类型无效');
  }
  function dissolvePlan(u) {
    if (u.kind !== 'group' || !['active','pending'].includes(u.state)) fail('只能解除活动或待生成组');
    return u.members.map(id => {
      const s = store.maybe('segments', id), single = store.maybe('units', id), diagnostics = [];
      if (!s) diagnostics.push(`成员缺失（${id}）`);
      else if (s.chapterId !== u.chapterId || s.retired || s.excluded) diagnostics.push('成员已改变、停用或排除，请核对');
      else { try { d.validate(s, store.get('chapters',u.chapterId)); } catch (error) { diagnostics.push(error.message); } }
      const st = single?.kind === 'single' && single.chapterId === u.chapterId ? status(single,'dry') : null;
      if (!st) diagnostics.push('原单条生成单元缺失或已改变');
      return { id, mode: 'dry', audioId: st?.audio?.id || null, validity: st?.validity || 'missing', review: st?.review || 'pending', diagnostics: [...new Set([...diagnostics, ...(st?.promptIssues || [])])] };
    });
  }
  function mutate(action, p) {
    if (action === 'voice-candidate.discard') {
      const a = store.get('attempts', p.id || p.audioId), j = store.get('jobs', a.jobId), session = store.get('voiceSessions', p.sessionId || j.sessionId);
      if (a.targetKind !== 'candidate' || j.sessionId !== session.id) fail('候选不属于该会话');
      revision(session, p.entityRevision);
      a.discarded = true; store.put('attempts', a, j.id);
      if (active(j)) { j.stop = true; store.put('jobs', j); }
      session.contentRevision ??= session.revision; session.revision++; store.put('voiceSessions', session); return { ...a, sessionRevision: session.revision };
    }
    if (action.startsWith('voice-session.')) {
      if (action === 'voice-session.create') { enabled('voiceCreation'); const s = { id: uid(), description: text(p.description, '声音描述', 2000), text: sampleText, template: 'voice-design-v1', model: process.env.KUNPO_TTS_MODEL || 'seed-audio-1.0', config: { speech_rate: 0, loudness_rate: 0, pitch_rate: 0 }, revision: 1, contentRevision:1, state: 'active', createdAt: stamp() }; return store.put('voiceSessions', s); }
      const s = store.get('voiceSessions', p.id); revision(s, p.entityRevision);
      s.contentRevision ??= s.revision;
      if (action === 'voice-session.update') { if (s.state !== 'active') fail('已放弃会话不能修改'); const description = text(p.description, '声音描述', 2000); if (description !== s.description) s.contentRevision++; s.description = description; }
      else if (action === 'voice-session.abandon') { s.state = 'abandoned'; for (const j of store.all('jobs').filter(j => j.sessionId === s.id && active(j))) { j.stop = true; store.put('jobs', j); } }
      else fail('未知声音会话操作');
      s.revision++; return store.put('voiceSessions', s);
    }
    const c = d.editable(p.chapterId, p.revision);
    if (action === 'unit.create') { enabled('groups'); const plan = groupPlan(p); store.put('units', plan.unit, c.id); d.touch(c, true, false); return { ...view(plan.unit), chapterRevision: c.revision }; }
    const u = getUnit(p.unitId || p.id);
    if (u.chapterId !== c.id || ['dissolved','retired'].includes(u.state)) fail('生成单元已经解除或改变', 409);
    revision(u, p.entityRevision);
    if (action.startsWith('event.')) {
      if (action === 'event.create') enabled('scenes');
      if (action === 'event.create') { const records = addEvents(u.id, [{ ...p, id: undefined }], u.revision); return { ...records[0], unitRevision: u.revision + 1, chapterRevision: store.get('chapters', c.id).revision }; }
      const old = store.get('events', p.eventId || p.id);
      if (old.unitId !== u.id) fail('事件不属于当前单元');
      revision(old, p.eventRevision);
      const next = action === 'event.remove' ? { ...old, state: 'removed', revision: old.revision + 1 } : validateEvent(u, { ...old, ...p, id: old.id, revision: old.revision + 1 });
      if (!['event.update','event.remove','event.reconfirm'].includes(action)) fail('未知声音事件操作');
      if (action === 'event.update' && eventView(old,u).validity === 'needsReview') { next.basis = old.basis; next.needsReview = true; }
      store.put('events', next, u.id); u.variants.scene.revision++;
    } else if (action === 'unit.update') {
      if (p.guidance !== undefined) { if (u.kind === 'single' && (p.mode || u.mode) === 'dry') fail('单条干声表演请使用片段编辑，不能保存未生效的组指导'); if (typeof p.guidance !== 'string' || Array.from(p.guidance).length > 2000) fail('组指导最多 2000 字'); const mode = p.mode || u.mode; if (!['dry','scene'].includes(mode)) fail('目标类型无效'); u.variants[mode].guidance = p.guidance; u.variants[mode].guidanceSource={kind:'user',at:stamp()}; u.variants[mode].revision++; if (mode === 'dry') u.guidance = p.guidance; }
      if (p.backgroundPresence !== undefined) { if ((p.mode || u.mode) !== 'scene' || !['clear','natural','subtle','unspecified'].includes(p.backgroundPresence)) fail('背景存在感只接受场景的轻、自然、清楚或未设置'); u.variants.scene.backgroundPresence=p.backgroundPresence;u.variants.scene.backgroundPresenceSource={kind:'user',at:stamp()};u.variants.scene.revision++; }
      if (p.template !== undefined) fail('请使用明确的模板切换操作');
    } else if (action === 'unit.dissolve') {
      if (p.arrangement !== undefined && p.arrangement !== c.arrangement) fail('拆组预览后的编排已变化，请重新预览',409);
      for (const item of dissolvePlan(u)) {
        const single = store.maybe('units',item.id);
        if (single?.kind === 'single' && single.chapterId === c.id && single.mode !== 'dry') { single.mode = 'dry'; single.revision++; store.put('units',single,c.id); }
      }
      u.state = 'dissolved'; u.membershipRevision++;
      for (const j of store.all('jobs', c.id).filter(active)) if (store.all('attempts', j.id).some(a => a.unitId === u.id)) { j.stop = true; store.put('jobs', j, c.id); }
      d.touch(c, false, true);
    } else if (action === 'unit.switch') {
      if (!['dry','scene'].includes(p.mode)) fail('目标类型无效');
      if (status(u, p.mode).validity !== 'matched') fail('目标类型没有匹配音频，请明确生成范围与费用后生成', 409);
      u.mode = p.mode; d.touch(c, false, true);
    } else if (action === 'unit.review') {
      const mode = p.mode || u.mode, st = status(u, mode);
      if (!['passed','rework'].includes(p.state)) fail('检查状态无效');
      if (st.validity !== 'matched' || u.variants[mode].current !== p.audioId || !same(st.basis, p.basis)) fail('试听版本已变化，请重新检查当前音频', 409);
      setReview(u, mode, p.state, st.basis);
      return { ...view(u), chapterRevision: c.revision };
    } else if (action === 'unit.template') {
      if (p.confirm !== true) fail('请明确确认模板差异');
      const mode = p.mode || u.mode, target = templateOf(p.template);
      if (mode === 'scene' ? target.mode !== 'scene' : u.kind === 'group' ? target.scope !== 'group' : target.mode !== 'dry' || target.scope && target.scope !== 'single') fail('模板不适用于此生成单元');
      if (u.kind === 'single' && mode === 'dry') { const s = store.get('segments',u.id); s.template=p.template; d.validate(s,c); store.put('segments',s,c.id); delete u.variants[mode].template; }
      else u.variants[mode].template = p.template;
      delete u.variants[mode].resolvedCompilerId;
      u.variants[mode].revision++;
    } else if (action === 'unit.select-result') {
      const mode = p.mode || u.mode; if (!['dry','scene'].includes(mode)) fail('目标类型无效');
      const a = history(u,mode).find(a => a.id === p.audioId); if (!a || !a.matched) fail('此历史产物不属于本单元或当前请求不匹配，请先核对设置',409);
      const v = u.variants[mode], old = v.current, rework = v.review?.state === 'rework';
      if (old !== a.id) v.previous = old; v.current=a.id; v.latest='success'; v.review={audioId:a.id,basis:basis(u,mode),state:rework?'rework':'pending',at:stamp()};
      u.mode=mode;u.state='active';
      if (u.kind === 'single' && mode === 'dry') { const s=store.get('segments',u.id); Object.assign(s,{current:v.current,previous:v.previous,review:v.review,latest:'success'});store.put('segments',s,c.id); }
      d.touch(c,false,true);
    } else if (action === 'unit.restore') {
      const mode = p.mode || u.mode, plan = restorePlan(u,mode,p.audioId), {audio:a,changed,restoredEvents,candidateInput,resolvedCompilerId} = plan, v = u.variants[mode];
      if (p.baseRevisions && !same(p.baseRevisions,plan.baseRevisions)) fail('恢复预览后的事件或设置已变化，请重新预览',409);
      if (plan.conflicts.length) fail(plan.conflicts.join('；'),409);
      if (changed) {
        if (!p.restoreSettings) fail('旧设置不同，请先查看差异并明确恢复设置', 409);
        v.restoreProvenance={audioId:a.id,at:stamp(),before:{guidance:v.guidance,template:v.template,resolvedCompilerId:v.resolvedCompilerId,backgroundPresence:v.backgroundPresence,adoptedEvents:store.all('events',u.id).filter(e=>e.state==='adopted')}};
        v.guidance = candidateInput.guidance; v.guidanceSource={kind:'inherited_user',audioId:a.id}; if (mode === 'dry') u.guidance = v.guidance; v.template = a.input.template;
        delete v.backgroundPresence; if (candidateInput.backgroundPresence) v.backgroundPresence=candidateInput.backgroundPresence;
        v.backgroundPresenceSource={kind:'inherited_user',audioId:a.id};
        if (mode === 'scene') {
          for (const e of store.all('events', u.id).filter(e=>e.state==='adopted')) { e.state = 'removed'; store.put('events', e, u.id); }
          for (const restored of restoredEvents) store.put('events',restored,u.id);
        }
      }
      if (candidateInput.compilerId) {
        v.resolvedCompilerId=resolvedCompilerId;
        const original=store.get('audios',a.id);
        if (!original.resolvedCompilerId) { original.resolvedCompilerId=resolvedCompilerId;original.migrationProvenance={method:'exact-input-prompt',sourceTemplateId:original.input.template,promptSha256:createHash('sha256').update(original.prompt).digest('hex'),at:stamp()};store.put('audios',original,c.id); }
      } else delete v.resolvedCompilerId;
      u.mode = mode; u.state = 'active';
      const rework = v.review?.state === 'rework', old = v.current; v.current = a.id; if (old !== a.id) v.previous = old;
      v.review = !rework && a.review && same(compatibleReviewBasis(u,mode,a.review,a), basis(u, mode)) ? a.review : { audioId: a.id, basis: basis(u, mode), state: rework ? 'rework' : 'pending', at: stamp() };
      if (u.kind === 'single' && mode === 'dry') { const s = store.get('segments', u.id); Object.assign(s, { current: v.current, previous: v.previous, review: v.review }); store.put('segments', s, c.id); }
      d.touch(c, false, true);
    } else fail('未知增强操作');
    u.revision++; store.put('units', u, c.id);
    if (action === 'unit.restore') { const restored=getUnit(u.id); if (status(restored,p.mode || u.mode).validity !== 'matched' || restored.variants[p.mode || u.mode].current !== p.audioId) fail('恢复后的候选未匹配原音频，已取消全部恢复写入',409); }
    if (!['unit.dissolve','unit.switch','unit.restore','unit.select-result'].includes(action)) d.touch(c, true, false);
    return action.startsWith('event.') ? { ...eventView(store.get('events', p.eventId || p.id), u), unitRevision: u.revision, chapterRevision: c.revision } : { ...view(u), chapterRevision: c.revision };
  }
  function assertLegacyGeneration(c, selected) {
    const blocked = store.all('units', c.id).filter(u => u.kind === 'group' && u.state === 'active' || u.kind === 'single' && u.mode === 'scene');
    if (selected.some(s => blocked.some(u => u.members.includes(s.id)))) fail('当前片段属于活动组或场景单元，请按单元生成或明确切回干声', 409);
  }
  function compilerCompatibility() {
    return store.all('audios').filter(a=>a.input?.template==='scene-v3-native').map(a=>({audioId:a.id,unitId:a.input.unitId,oldTemplateId:a.input.template,promptSha256:createHash('sha256').update(a.prompt || '').digest('hex'),resolvedCompilerId:resolveCompiler(a.input,a.prompt),affectedModes:[a.input.mode || 'scene'],readOnly:true}));
  }
  return { invalidateEvents, history, compilerCompatibility, restorePlan, assertLegacyGeneration, syncLegacy, syncLegacySegment, features, getUnit, members, input: buildInput, basis, status, view, resolve, inspectArrangement, events, eventBasis, assertEventRange, addEvents, snapshot, prepare, prepareRender, validateDispatch, register, setAttemptStatus, preview, dissolvePlan, mutate, assertStructural };
}
