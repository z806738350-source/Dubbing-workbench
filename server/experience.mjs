import { fail, same, text } from './store.mjs';
import { saveCandidateVoice } from './audio.mjs';

const now = () => new Date().toISOString();
const recordId = (kind, id) => `ux-${kind}:${id}`;
export const policyOf = (store, projectId) => store.maybe('settings', recordId('policy', projectId)) || {projectId, mode:'review', revision:0};
const valuesOf = (s, field) => field === 'role' ? [s.roleId,s.type] : [s.roleId,s.voiceId,s.voiceSource];
export function configurationDecided(s) {
  return ['role','identity'].every(field => {
    const confirmed = s[field === 'role' ? 'roleConfirmed' : 'identityConfirmed'];
    const decision = s.decisions?.[field];
    return confirmed && (!decision || decision.state === 'accepted' && same(decision.values, valuesOf(s, field)));
  });
}
export function decide(s, field, source, extra = {}) {
  s.decisions = {...s.decisions, [field]:{source, at:now(), values:valuesOf(s,field), state:s[field === 'role' ? 'roleConfirmed' : 'identityConfirmed'] ? 'accepted' : 'needsDecision', ...extra}};
}
export function humanChanges(before, after, action, payload) {
  const fields = ['text','roleId','voiceId','voiceSource','performance','type','config','excluded'];
  const changed = fields.filter(field => !same(before[field], after[field]));
  const confirming = action === 'segment.confirm' && Array.isArray(payload.ids) && payload.ids.includes(after.id);
  after.protectedFields = [...new Set([...(before.protectedFields || []), ...changed])];
  if (changed.includes('roleId') || changed.includes('type') || before.roleConfirmed !== after.roleConfirmed || confirming) decide(after,'role','human');
  if (changed.includes('voiceId') || changed.includes('voiceSource') || changed.includes('roleId') || before.identityConfirmed !== after.identityConfirmed || confirming && payload.roleOnly !== true) decide(after,'identity',action === 'role.update' || payload.resetVoice ? 'inherited' : 'human');
  if (changed.includes('performance')) after.decisions = {...after.decisions,performance:{source:'human',at:now(),values:after.performance}};
  return changed.length || confirming || !same(before.decisions,after.decisions);
}
function grantFor(store, config, request, kind) {
  const c = request.chapterId ? store.get('chapters',request.chapterId) : null;
  const projectId = c?.projectId || request.projectId;
  const required = request.requireGrant || projectId && policyOf(store,projectId).revision > 0;
  if (!request.grantId && !required) return null;
  if (!request.grantId) fail('请先明确本次素材外发范围和请求额度',403);
  const g = store.get('settings',recordId('grant',request.grantId));
  if (g.revoked || g.expiresAt && Date.parse(g.expiresAt) <= Date.now()) fail('本次授权已撤回或到期，未发送的请求已停止',403);
  if (g.projectId !== projectId || g.chapterId && g.chapterId !== request.chapterId || !g.steps.includes(request.kind)) fail('本次任务超出已授权的项目、章节或用途',403);
  const route = kind === 'text' ? config.baseUrl : config.audioUrl;
  if (g.routes[kind] !== route || request.models.some(model => model !== g.models[kind])) fail('模型或接口范围已变化，请重新授权',403);
  if (!g.materials.includes('text') || request.voiceIds.length && !g.materials.includes('reference')) fail('本次素材类别尚未获得授权',403);
  if ((request.voiceIds || []).some(id => !g.voiceIds.includes(id))) fail('本次参考声音超出已授权素材范围',403);
  return g;
}
export function reserveGrant(store, config, p, attempts, kind = 'audio') {
  const request = {chapterId:p.chapterId || '',projectId:p.projectId,kind:p.kind || 'generate',grantId:p.grantId,requireGrant:p.requireGrant,models:[...new Set(attempts.map(a => a.input?.model || a.model || config.model))],voiceIds:[...new Set(attempts.flatMap(a => a.input?.referenceVoiceIds || (a.input?.voiceId ? [a.input.voiceId] : [])))]};
  const g = grantFor(store,config,request,kind);
  if (!g) return;
  if (g[kind+'Used'] + g[kind+'Reserved'] + attempts.length > g[kind+'Limit']) fail('本次授权的请求额度不足；在途和结果不明仍占用额度',403);
  g[kind+'Reserved'] += attempts.length;
  store.put('settings',g);
  for (const a of attempts) a.grantReservation = {grantId:g.grantId,kind,state:'reserved',request};
}
export function settleGrant(store, config, a, state) {
  const r = a.grantReservation;
  if (!r || r.state !== 'reserved') return;
  const g = state === 'used' ? grantFor(store,config,r.request,r.kind) : store.get('settings',recordId('grant',r.grantId));
  g[r.kind+'Reserved']--;
  if (state === 'used') g[r.kind+'Used']++;
  r.state = state;
  store.put('settings',g);
}
export function createExperience(store, domain, worker, analysis, config) {
  const inflight = new Map();
  const save = op => store.put('settings',op);
  function policy(p) {
    store.get('projects',p.projectId);
    const previous = policyOf(store,p.projectId);
    if (p.revision !== previous.revision) fail('协作策略已改变，请刷新后选择',409);
    if (!['smart','review'].includes(p.mode)) fail('协作策略无效');
    return store.put('settings',{id:recordId('policy',p.projectId),projectId:p.projectId,mode:p.mode,revision:previous.revision+1,at:now()});
  }
  function grant(p) {
    store.get('projects',p.projectId);
    if (p.chapterId && store.get('chapters',p.chapterId).projectId !== p.projectId) fail('章节不属于当前项目');
    const grantId = text(p.grantId,'授权标识',100), id = recordId('grant',grantId);
    const previous = store.maybe('settings',id);
    const request = JSON.parse(JSON.stringify(p));
    if (previous) { if (!same(previous.request,request)) fail('同一授权标识的范围不同',409); return previous; }
    const allowed = ['extract','director','scene','generate','unit-generate','voice-create','voice-test'];
    if (!Array.isArray(p.steps) || !p.steps.length || p.steps.some(step => !allowed.includes(step))) fail('授权用途无效');
    for (const field of ['textLimit','audioLimit']) if (!Number.isSafeInteger(p[field]) || p[field] < 0 || p[field] > 10000) fail('请求额度应为0至10000的整数');
    if (p.expiresAt && (!Number.isFinite(Date.parse(p.expiresAt)) || Date.parse(p.expiresAt) <= Date.now())) fail('授权有效期无效');
    const materials = p.materials || ['text',...(p.steps.some(step => ['generate','unit-generate','voice-test'].includes(step)) ? ['reference'] : [])];
    if (!Array.isArray(materials) || materials.some(kind => !['text','reference'].includes(kind)) || !materials.includes('text')) fail('请选择这次外发的素材类别');
    const voices = materials.includes('reference') ? p.voiceIds || store.all('voices').filter(v => v.state === 'active').map(v => v.id) : [];
    if (!Array.isArray(voices) || voices.some(id => !store.maybe('voices',id))) fail('参考声音范围无效');
    const textModel = p.textModel === undefined ? domain.textModel() : text(p.textModel,'文本模型',200);
    if (textModel.length > 150 || /[\s\u0000-\u001f]/u.test(textModel)) fail('文本模型名称无效');
    return store.put('settings',{id,grantId,projectId:p.projectId,chapterId:p.chapterId || null,steps:[...new Set(p.steps)],materials:[...new Set(materials)],voiceIds:[...new Set(voices)],models:{text:textModel,audio:config.model},routes:{text:config.baseUrl,audio:config.audioUrl},textLimit:p.textLimit,audioLimit:p.audioLimit,textUsed:0,audioUsed:0,textReserved:0,audioReserved:0,expiresAt:p.expiresAt || null,revoked:false,revision:1,request,at:now()});
  }
  function revoke(p) {
    const g = store.get('settings',recordId('grant',p.grantId));
    g.revoked = true; g.revision++;
    return store.put('settings',g);
  }
  function unprotect(p) {
    return store.transaction(() => {
      const c = domain.editable(p.chapterId,p.revision), s = store.get('segments',p.segmentId);
      if (s.chapterId !== c.id || s.retired || p.field !== 'performance') fail('请选择当前台词的表演项重新安排');
      s.protectedFields = (s.protectedFields || []).filter(field => field !== p.field);
      s.aiAllowedFields = [...new Set([...(s.aiAllowedFields || []),p.field])];
      store.put('segments',s,c.id); domain.touch(c,true,false); return {...s,chapterRevision:c.revision};
    });
  }
  function project(projectId) {
    store.get('projects',projectId);
    return {policy:policyOf(store,projectId),grants:store.all('settings').filter(r => r.id.startsWith('ux-grant:') && r.projectId === projectId).map(({request,...g}) => g),changes:store.all('settings').filter(r => r.id.startsWith('ux-change:') && r.projectId === projectId)};
  }
  function plan(p) {
    if (p.kind === 'prepareChapter') return analysis.plan({...p,kind:p.analysisKind});
    const c = domain.editable(p.chapterId,p.revision);
    if (p.arrangement !== undefined && p.arrangement !== c.arrangement) fail('实际声音编排在核对后已变化，请重新查看生成范围',409);
    if (!Array.isArray(p.ids) || !p.ids.length || new Set(p.ids).size !== p.ids.length || p.ids.some(id => !domain.list(c.id).some(s => s.id === id && !s.excluded))) fail('请选择当前章节的有效台词');
    let rows = domain.enhancement.resolve(c.id).filter(row => row.s.members.some(id => p.ids.includes(id)));
    if (p.unitId) {
      const unit = domain.enhancement.getUnit(p.unitId);
      if (unit.chapterId !== c.id || !['active','pending'].includes(unit.state) || !unit.members.some(id => p.ids.includes(id))) fail('目标对话片段已变化',409);
      rows = [{s:unit}];
    }
    const units = rows.map(row => {
      const mode = p.mode || row.s.mode;
      if (!['dry','scene'].includes(mode)) fail('声音版本无效');
      const st = domain.enhancement.status(domain.enhancement.getUnit(row.s.id),mode);
      return {unitId:row.s.id,members:row.s.members,mode,reuse:!p.regenerate && st.validity === 'matched',audioId:st.audio?.id || null};
    });
    return {chapterId:c.id,revision:c.revision,arrangement:c.arrangement,unitIds:units.filter(u => !u.reuse).map(u => u.unitId),memberIds:units.flatMap(u => u.members),units,textRequests:0,audioRequests:units.filter(u => !u.reuse).length};
  }
  function view(op) {
    const result = {...op}; delete result.request;
    if (op.result?.analysis?.id) {
      const a = store.get('suggestions',op.result.analysis.id);
      result.result = {...op.result,analysis:a,applied:a.automation?.applied || 0,needsDecision:a.automation?.needsDecision || a.items.filter(i => i.uncertain || i.issues?.length).length};
      result.outcome = a.status === 'running' ? 'processing' : a.batches?.some(b => b.status === 'unknown') ? 'unknown' : a.status === 'applied' ? 'completed' : 'needsInput';
    }
    if (op.jobIds.length) {
      const jobs = op.jobIds.map(id => store.get('jobs',id));
      result.outcome = jobs.some(j => ['queued','running'].includes(j.status)) ? 'processing' : jobs.some(j => j.status === 'unknown') ? 'unknown' : jobs.every(j => j.status === 'success') ? 'completed' : 'needsInput';
    }
    return result;
  }
  function get(id) { return view(store.get('settings',recordId('operation',id))); }
  async function run(p) {
    text(p.operationId,'操作标识',100);
    if (inflight.has(p.operationId)) { const existing = store.get('settings',recordId('operation',p.operationId)); if (!same(existing.request,p)) fail('同一操作标识的内容不同',409); return inflight.get(p.operationId); }
    const task = execute(p);
    inflight.set(p.operationId,task);
    try { return await task; } finally { inflight.delete(p.operationId); }
  }
  async function execute(p) {
    const id = recordId('operation',p.operationId), old = store.maybe('settings',id);
    if (old && !same(old.request,p)) fail('同一操作标识的内容不同',409);
    if (old?.steps.completed || old?.jobIds.length || old?.result?.analysis) return view(old);
    const op = old || {id,operationId:p.operationId,kind:p.kind,request:JSON.parse(JSON.stringify(p)),steps:{},jobIds:[],createdObjectIds:[],outcome:'processing',at:now()};
    save(op);
    const step = (name, fn) => {
      if (op.steps[name]) return op.steps[name];
      return store.transaction(() => { const result = fn(); op.steps[name] = result; save(op); return result; });
    };
    try {
      if (p.kind === 'save') {
        step('completed',() => {
          const result = domain.mutate(p.action,p.data);
          op.result = p.data.chapterId ? {...result,chapterRevision:store.get('chapters',p.data.chapterId).revision} : result;
          op.dependencies = {chapterId:p.data.chapterId || result.chapterId,segmentIds:p.action.startsWith('segment.') ? p.data.ids || [p.data.id].filter(Boolean) : [],unitIds:p.data.unitId ? [p.data.unitId] : [],roleIds:p.action === 'role.update' ? [p.data.id] : []};
          return true;
        });
        op.outcome = 'completed';
      } else if (p.kind === 'prepareChapter') {
        const existing = store.all('suggestions').find(a => a.operationId === p.operationId);
        const a = existing || await analysis.start({...p,kind:p.analysisKind || (domain.list(p.chapterId).length ? 'director' : 'extract'),...(p.analysisKind === 'scene' ? {sceneEnabled:true} : {}),autoApply:p.autoApply !== false,requireGrant:true});
        op.result = {analysis:a}; op.createdObjectIds = [a.id]; op.steps.analysis = a.id;
      } else if (p.kind === 'useVoice') {
        let voice = op.steps.voice ? store.get('voices',op.steps.voice) : p.audioId ? await saveCandidateVoice(store,{audioId:p.audioId,name:p.name || '新声音'}) : store.get('voices',p.voiceId);
        op.steps.voice = voice.id; op.createdObjectIds = [voice.id]; op.result = {voice}; save(op);
        if (p.scope !== 'library') step('bound',() => {
          if (!p.chapterId || (!p.segmentId && !p.roleId)) fail('请选择这次使用声音的章节与角色或台词');
          if (voice.state !== 'active' || voice.deletePending) fail('请选择当前可用的声音');
          const target = domain.mutate(p.segmentId ? 'segment.update' : 'role.update',p.segmentId ? {chapterId:p.chapterId,revision:p.revision,id:p.segmentId,voiceId:voice.id,identityChosen:true} : {chapterId:p.chapterId,revision:p.revision,id:p.roleId,entityRevision:p.entityRevision,voiceId:voice.id,apply:p.apply !== false,chapterOnly:p.updateDefault !== true,identityChosen:true});
          op.result = {voice,target:{...target,chapterRevision:store.get('chapters',p.chapterId).revision}}; return op.result.target;
        });
        op.steps.completed = true; op.outcome = 'completed';
      } else {
        let payload = {chapterId:p.chapterId,projectId:p.projectId,revision:p.revision,grantId:p.grantId,requireGrant:true,commandId:p.operationId,...(p.retryUnknown === true ? {retryUnknown:true} : {}),...(p.resumeRoute === true ? {resumeRoute:true} : {})};
        if (p.kind === 'groupAndGenerate') {
          const unit = step('unit',() => domain.mutate('unit.create',{chapterId:p.chapterId,revision:p.revision,ids:p.ids,guidance:p.guidance || ''}));
          op.createdObjectIds = [unit.id]; op.result = {unit};
          payload = {...payload,kind:'unit-generate',revision:unit.chapterRevision,unitIds:[unit.id],mode:'dry'};
        } else if (p.kind === 'sceneAndGenerate') {
          const adopted = step('events',() => {
            let c = domain.editable(p.chapterId,p.revision), unit = store.get('units',p.unitId);
            if (unit.chapterId !== c.id || unit.revision !== p.entityRevision) fail('当前声音背景已变化',409);
            if (!Array.isArray(p.eventIds) || new Set(p.eventIds).size !== p.eventIds.length) fail('声音事件范围无效');
            for (const eventId of p.eventIds) {
              const e = store.get('events',eventId);
              domain.mutate('event.update',{chapterId:c.id,revision:c.revision,unitId:unit.id,entityRevision:unit.revision,id:e.id,eventRevision:e.revision,state:'adopted'});
              c = store.get('chapters',c.id); unit = store.get('units',unit.id);
            }
            return {revision:c.revision,unitRevision:unit.revision};
          });
          payload = {...payload,kind:'unit-generate',revision:adopted.revision,unitIds:[p.unitId],mode:'scene'};
        } else if (p.kind === 'generateSelection') {
          const selected = plan(p); op.result = {plan:selected};
          if (!selected.audioRequests) { op.steps.completed = true; op.outcome = 'completed'; save(op); return view(op); }
          payload = {...payload,kind:'unit-generate',revision:selected.revision,arrangement:selected.arrangement,unitIds:selected.unitIds,...(p.mode ? {mode:p.mode} : {})};
        } else if (p.kind === 'voiceCandidate') payload = {...payload,kind:'voice-create',sessionId:p.sessionId,entityRevision:p.entityRevision};
        else if (p.kind === 'export') payload = {...payload,requireGrant:false,kind:'export',arrangement:p.arrangement,reviewItems:p.reviewItems,confirm:p.confirm === true,format:p.format};
        else fail('组合操作类型无效');
        const job = await worker.submit(payload);
        op.jobIds = [job.id]; op.steps.enqueued = job.id; op.result = {...op.result,job}; op.outcome = 'processing';
      }
      delete op.error; delete op.errorStatus;
    } catch (e) {
      op.error = e.status ? e.message : '操作中断，已完成的步骤保留，可用相同操作重试';
      op.errorStatus = e.status || 500;
      op.outcome = Object.keys(op.steps).length ? 'prepared' : 'needsInput';
    }
    save(op); return view(op);
  }
  function undo(p) {
    return store.transaction(() => {
      const change = store.get('settings',recordId('change',p.changeId)), c = domain.editable(change.chapterId,p.revision);
      if (change.undoneAt) return change;
      for (const item of change.items) {
        const s = store.get('segments',item.id);
        if (s.retired || Object.keys(item.after).some(field => !same(s[field],item.after[field]))) fail('AI安排后这部分已被修改，请比较差异后决定',409);
      }
      for (const item of change.items) { const s = store.get('segments',item.id); Object.assign(s,item.before); store.put('segments',s,c.id); }
      domain.touch(c,true,false); domain.enhancement.syncLegacy(); change.undoneAt = now(); return store.put('settings',change);
    });
  }
  return {policy,grant,revoke,project,plan,run,get,undo,unprotect};
}
