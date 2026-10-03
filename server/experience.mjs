import { fail, same, text } from './store.mjs';
import { saveCandidateVoice } from './audio.mjs';

const now = () => new Date().toISOString();
const recordId = (kind, id) => `ux-${kind}:${id}`;
export const policyOf = (store, projectId) => store.maybe('settings', recordId('policy', projectId)) || {projectId, mode:'review', revision:0};
const valuesOf = (s, field) => field === 'role' ? [s.roleId,s.type] : [s.roleId,s.voiceId,s.voiceSource];
const fieldDecided = (s, field) => s[field === 'role' ? 'roleConfirmed' : 'identityConfirmed'] && (!s.decisions?.[field] || s.decisions[field].state === 'accepted' && same(s.decisions[field].values,valuesOf(s,field)));
export function configurationDecided(s) {
  return ['role','identity'].every(field => fieldDecided(s,field));
}
export function decide(s, field, source, extra = {}) {
  s.decisions = {...s.decisions, [field]:{source, at:now(), values:valuesOf(s,field), state:s[field === 'role' ? 'roleConfirmed' : 'identityConfirmed'] ? 'accepted' : 'needsDecision', ...extra}};
}
export function inheritStructure(s, parents, action, operationId) {
  const provenance = {parentIds:parents.map(p=>p.id),parentRevision:s.source.parentRevision,action,...(operationId ? {operationId} : {})};
  s.protectedFields = [...new Set(parents.flatMap(p=>p.protectedFields || []))];
  for (const field of ['role','identity']) {
    s[field === 'role' ? 'roleConfirmed' : 'identityConfirmed'] = parents.every(p=>fieldDecided(p,field));
    decide(s,field,'structural',provenance);
  }
  s.decisions = {...s.decisions,performance:{source:'structural',at:now(),values:s.performance,...provenance}};
  return s;
}
export const attemptScope = a => ({kind:['single','unit'].includes(a.targetKind) || a.segmentId ? 'unit' : a.targetKind,id:a.segmentId || a.unitId || a.targetId,mode:['single','unit'].includes(a.targetKind) || a.segmentId ? a.mode || a.input?.mode || 'dry' : null});
const targetMembers = (store,target) => target.input?.members?.map(m=>m.id) || store.maybe('units',attemptScope(target).id)?.members || [attemptScope(target).id];
export function relatedTarget(store, a, b) {
  const left=attemptScope(a),right=attemptScope(b);
  if(left.kind!=='unit' || right.kind!=='unit') return same(left,right);
  if(left.id===right.id) return true;
  const ancestry=id=>{const ids=new Set(),visit=id=>{if(!id || ids.has(id))return;ids.add(id);for(const parent of store.maybe('segments',id)?.source?.parentIds || [])visit(parent);};visit(id);return ids;};
  return targetMembers(store,a).some(id=>targetMembers(store,b).some(other=>ancestry(id).has(other) || ancestry(other).has(id)));
}
function decisionCovers(store, sent, target) {
  const a=attemptScope(sent),b=attemptScope(target);
  if(a.kind!=='unit' || b.kind!=='unit') return same(a,b);
  if(a.mode!==b.mode) return false;
  const decided=new Set(targetMembers(store,sent));
  const covers=(id,seen=new Set())=>{
    if(decided.has(id))return true;
    if(seen.has(id))return false;
    const parents=store.maybe('segments',id)?.source?.parentIds || [];
    return parents.length>0 && parents.every(parent=>covers(parent,new Set([...seen,id])));
  };
  return targetMembers(store,target).every(id=>covers(id));
}
export function outstandingAttempts(store, targets, history=store.all('attempts'), related=false) {
  const decisions=history.filter(a=>a.createdAt && a.acknowledgedAttemptIds?.length);
  return history.filter(a=>a.status === 'unknown' && targets.some(target=>(related ? relatedTarget(store,target,a) : same(attemptScope(target),attemptScope(a))) && !decisions.some(sent=>sent.acknowledgedAttemptIds.includes(a.id) && decisionCovers(store,sent,target))));
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
  const chapterOf = p => p.chapterId || p.data?.chapterId;
  const projectOf = p => p.projectId || p.data?.projectId || (chapterOf(p) && store.maybe('chapters',chapterOf(p))?.projectId);
  const save = op => {
    const c = chapterOf(op.request), p = projectOf(op.request);
    if (c && !store.maybe('chapters',c) || p && !store.maybe('projects',p)) return op;
    return store.put('settings',op);
  };
  const projectBusy = projectId => [...inflight.keys()].some(id => {
    const op = store.maybe('settings',recordId('operation',id));
    return op && projectOf(op.request) === projectId;
  });
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
    const actionKind = p.actionKind || (p.regenerate ? 'forceRegenerate' : 'updateSelected');
    if (!['fillMissing','updateSelected','redoRejected','forceRegenerate'].includes(actionKind)) fail('生成动作无效');
    const history=store.all('attempts');
    const units = rows.map(row => {
      const mode = p.mode || row.s.mode;
      if (!['dry','scene'].includes(mode)) fail('声音版本无效');
      const st = domain.enhancement.status(domain.enhancement.getUnit(row.s.id),mode);
      const rejected=st.review === 'rework', request=actionKind === 'forceRegenerate' || actionKind === 'redoRejected' ? actionKind === 'forceRegenerate' || rejected : st.validity !== 'matched' || actionKind === 'updateSelected' && rejected;
      const outstandingAttemptIds=outstandingAttempts(store,[{targetKind:'unit',targetId:row.s.id,mode}],history,true).map(a=>a.id);
      return {unitId:row.s.id,members:row.s.members,mode,reuse:!request,rejected,audioId:st.audio?.id || null,outstandingAttemptIds};
    });
    return {chapterId:c.id,revision:c.revision,arrangement:c.arrangement,actionKind,unitIds:units.filter(u => !u.reuse).map(u => u.unitId),memberIds:units.flatMap(u => u.members),units,rejectedUnits:units.filter(u=>u.rejected).map(u=>u.unitId),outstandingAttemptIds:[...new Set(units.filter(u=>!u.reuse).flatMap(u=>u.outstandingAttemptIds))],textRequests:0,audioRequests:units.filter(u => !u.reuse).length};
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
    if (p.kind === 'save' && p.action === 'project.delete') fail('删除项目请使用项目列表中的删除操作');
    const chapterId = chapterOf(p), projectId = projectOf(p);
    if (chapterId) store.get('chapters',chapterId);
    if (projectId) store.get('projects',projectId);
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
          const result = domain.mutate(p.action,{...p.data,...(['segment.split','segment.merge'].includes(p.action)?{operationId:p.operationId}:{})});
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
        let payload = {chapterId:p.chapterId,projectId:p.projectId,revision:p.revision,grantId:p.grantId,requireGrant:true,commandId:p.operationId,...(p.retryUnknown === true ? {retryUnknown:true} : {}),...(p.acknowledgedAttemptIds ? {acknowledgedAttemptIds:p.acknowledgedAttemptIds} : {}),...(p.resumeRoute === true ? {resumeRoute:true} : {})};
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
      const splits = change.splits || [], childIds = splits.flatMap(split => split.children.map(s => s.id));
      if (childIds.length) {
        domain.enhancement.assertStructural('segment.split',{chapterId:c.id,ids:childIds});
        for (const split of splits) {
          if (!store.get('segments',split.parent.id).retired) fail('原片段已恢复或改变，本次不能再次撤销',409);
          for (const expected of split.children) {
            const s = store.get('segments',expected.id), u = store.maybe('units',s.id);
            if (s.retired || !same(s,expected) || u?.mode === 'scene' || u?.variants?.scene?.guidance || store.all('events',s.id).some(e => e.state !== 'removed')) fail('拆分后子条已被修改或设置场景，请比较差异后决定',409);
          }
        }
        if (store.all('attempts').some(a => childIds.includes(a.segmentId || a.targetId || a.unitId) || a.input?.members?.some(s => childIds.includes(s.id))) || store.all('audios',c.id).some(a => childIds.includes(a.targetId) || a.input?.members?.some(s => childIds.includes(s.id)))) fail('拆分后已生成声音或提交请求，本次不能自动撤销',409);
      }
      for (const item of change.items) { const s = store.get('segments',item.id); Object.assign(s,item.before); store.put('segments',s,c.id); }
      for (const split of splits) {
        for (const child of split.children) store.put('segments',{...store.get('segments',child.id),retired:true},c.id);
        store.put('segments',{...split.parent,retired:false},c.id);
      }
      if (splits.length) domain.list(c.id).forEach((s,order) => store.put('segments',{...s,order},c.id));
      domain.touch(c,true,!!splits.length); domain.enhancement.syncLegacy(); change.undoneAt = now(); return store.put('settings',change);
    });
  }
  return {policy,grant,revoke,project,plan,run,get,undo,unprotect,projectBusy};
}
