import { existsSync, rmSync, readdirSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fail, same, text, uid } from "./store.mjs";
import { storedAudioUnavailable } from "./audio.mjs";
import { compile, templateOf, templateCatalog, listTemplates, listUnitTemplates } from "./templates.mjs";
import { createProjectFolder, renameProjectFolder, stageProjectDeletion, recoverProjectDeletions, projectFile, recordFiles } from './workspace.mjs';
export { compile } from "./templates.mjs";
import { createEnhancement, defaultFeatures } from "./enhancement.mjs";
import { configurationDecided, decide, humanChanges, assistantActor, assistantChanges, assistantOverride, assistantMutation, inheritStructure, outstandingAttempts, policyOf, assistantEffectState, assistantEffects, assertAssistantEffects } from './experience.mjs';
import { shortRanges } from './semantic.mjs';
import { importProblems } from './import-validation.mjs';

export const defaultConfig = templateOf("dry-v1").defaults;
export const active = (j) => ["queued", "running"].includes(j.status);
export function checkEntityRevision(entity, expected) {
  if (expected !== (entity.revision ?? 1))
    fail("资料已在其他页面更新，当前草稿未覆盖。请核对最新资料后重新编辑", 409);
}
export const textModel = (store) =>
  store.maybe("settings", "models")?.textModel ||
  process.env.KUNPO_TEXT_MODEL ||
  "gemini-3.8-flash";
export function validAliasSource(store, alias, projectId, currentChapter) {
  const source = currentChapter?.id === alias.chapterId ? currentChapter : alias.chapterId ? store.maybe("chapters", alias.chapterId) : null;
  if (alias.needsReview || !source || source.projectId !== projectId || !Number.isInteger(alias.sourceVersion)) return false;
  if (alias.kind === "用户补充") return !alias.sourceQuote;
  return ["原文明示", "上下文推断"].includes(alias.kind) && !!alias.sourceQuote &&
    source.source.includes(alias.sourceQuote) && alias.sourceVersion === (source.sourceVersion || 1) &&
    (alias.kind !== "上下文推断" || !!alias.reason?.trim());
}
export function knownRoles(store, chapter, replacementSource) {
  chapter = store.get("chapters", chapter.id);
  if (replacementSource !== undefined && replacementSource !== chapter.source)
    chapter = {...chapter, source:replacementSource, sourceVersion:(chapter.sourceVersion || 1) + 1};
  const known = (id) =>
    !id || (store.maybe("chapters", id)?.order ?? Infinity) <= chapter.order;
  return store
    .all("roles", chapter.projectId)
    .filter((r) => !r.archived && known(r.introducedIn))
    .map((r) => {
      const aliases = (r.aliasSources || []).filter(a => known(a.chapterId) && validAliasSource(store, a, r.projectId, chapter));
      return {
        id: r.id,
        name: r.name,
        narrator: r.narrator,
        voiceId: r.voiceId,
        aliases: aliases.map(a => a.name),
        aliasSources: aliases,
        facts: (r.facts || []).filter((f) => known(f.chapterId) &&
          (!f.sourceQuote || (f.sourceVersion || 1) === ((f.chapterId === chapter.id ? chapter : store.maybe("chapters", f.chapterId))?.sourceVersion || 1))),
      };
    });
}
export function performanceIssues(s) {
  if (templateCatalog.versions[s.template]?.mode !== "dry") return [];
  // ponytail: explicit phrase checks only; arbitrary natural-language contradictions still require review.
  const clauses = (s.performance || "").split(/[，,。；;\n]|但是|但|然而|不过|\b(?:but|however)\b/iu);
  const conflict = clauses.some(clause => !/(?:不要|禁止|无需|不添加|不加|无音乐|无音效|无环境|不播放|without|no music|no sound)/iu.test(clause) &&
    (/(?:加入|添加|配上|播放|伴随|搭配|背景|add|play|with).{0,30}(?:音乐|音效|环境声|雨声|雷声|脚步声|BGM|music|sound effects)/iu.test(clause) ||
    /(?:音乐|音效|雨声|雷声|BGM).{0,20}(?:作背景|伴奏|铺底)/iu.test(clause)));
  return conflict ? ["干声模式与额外音乐或音效指导冲突，请修改表演指导后再生成。"] : [];
}
export const inputOf = (s) => ({
  model: s.model || "seed-audio-1.0",
  text: s.text,
  voiceId: s.voiceId,
  performance: s.performance,
  config: s.config,
  template: s.template,
});
export const audioInput = (a) => ({
  model: a.model || "seed-audio-1.0",
  ...a.input,
});
export function audioMatches(s, audio) {
  const input = audioInput(audio);
  const configOf = c => [c?.speech_rate, c?.loudness_rate, c?.pitch_rate];
  try {
    return same(
      [inputOf(s).model, compile(s), s.voiceId, configOf(s.config)],
      [input.model, audio.prompt ?? compile(input), input.voiceId, configOf(input.config)],
    );
  } catch {
    return false;
  }
}
const reviewBasis = (basis, model) => ({
  model: model || "seed-audio-1.0",
  ...basis,
});
export const basisOf = (s) => ({
  ...inputOf(s),
  roleId: s.roleId,
  type: s.type,
  source: s.source,
  identityConfirmed: s.identityConfirmed,
  roleConfirmed: s.roleConfirmed,
});
export function segmentStatus(store, s) {
  const audio = s.current ? store.maybe("audios", s.current) : null;
  const validity = !audio
    ? "missing"
    : storedAudioUnavailable(store, audio)
      ? "broken"
      : audioMatches(s, audio)
        ? "matched"
        : "stale";
  const review =
    validity === "matched" &&
    s.review?.audioId === s.current &&
    same(reviewBasis(s.review.basis, audio?.model), basisOf(s))
      ? s.review.state
      : "pending";
  let prompt = "", templateError = "";
  try { prompt = compile(s); } catch (e) { templateError = e.message; }
  return { validity, review, audio, prompt, promptIssues: [...performanceIssues(s), ...(templateError ? [templateError] : [])] };
}
export function pieces(source) {
  // Offsets are Unicode code points, matching source coverage even with emoji.
  const chars = Array.from(source), spans = [];
  let start = 0;
  for (const {end} of shortRanges(source,true)) {
    const value = chars.slice(start,end).join('');
    if (value.trim()) { spans.push({start,end,text:value});start=end; }
    else if (spans.length) { const last=spans.at(-1);last.end=end;last.text+=value;start=end; }
  }
  return spans;
}
export function coverage(chapter, segments) {
  if (!chapter.source)
    return { valid: segments.length > 0, gaps: 0, overlaps: 0 };
  const chars = Array.from(chapter.source);
  if (
    segments.some(
      (s) => (s.source.version || 1) !== (chapter.sourceVersion || 1),
    )
  )
    return {
      valid: false,
      gaps: chars.filter((c) => c.trim()).length,
      overlaps: 0,
    };
  const counts = new Uint16Array(chars.length);
  const seen = new Set();
  for (const s of segments)
    for (const span of s.source.spans || []) {
      const key = `${span.start}:${span.end}:${span.origin || s.source.group || s.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (
        !Number.isInteger(span.start) ||
        !Number.isInteger(span.end) ||
        span.start < 0 ||
        span.end > chars.length ||
        span.start >= span.end
      )
        return { valid: false, gaps: 1, overlaps: 0 };
      for (let i = span.start; i < span.end; i++) counts[i]++;
    }
  const gaps = chars.filter((c, i) => c.trim() && !counts[i]).length;
  const overlaps = chars.filter((c, i) => c.trim() && counts[i] > 1).length;
  return { valid: !gaps && !overlaps, gaps, overlaps };
}
export function createDomain(store) {
  // Legacy aliases have no reliable evidence category. Preserve them for review;
  // changing their eligibility invalidates pending analysis, not existing audio.
  store.transaction(() => {
    const projects = new Set();
    for (const r of store.all("roles")) {
      const before = r.aliasSources || (r.aliases || []).map(name => ({name, chapterId:null}));
      const sources = before.map(a => !a.needsReview && !validAliasSource(store, a, r.projectId) ? {...a, needsReview:true} : a);
      if (!same(before, sources)) {
        r.aliasSources = sources;
        r.revision = (r.revision ?? 1) + 1;
        store.put("roles", r, r.projectId);
        projects.add(r.projectId);
      }
    }
    for (const id of projects) {
      const p = store.get("projects", id);
      p.contextRevision++;
      store.put("projects", p);
    }
  });
  const list = (chapterId) =>
    store
      .all("segments", chapterId)
      .filter((s) => !s.retired)
      .sort((a, b) => a.order - b.order);
  function editable(chapterId, expected) {
    const c = store.get("chapters", chapterId);
    if (store.all("jobs", chapterId).some(active))
      fail("本章正在处理任务，请等待完成或停止后续任务", 409);
    if (expected !== c.revision)
      fail("本章已在其他页面更新，当前编辑未覆盖，请刷新后核对", 409);
    return c;
  }
  function touch(c, content = true, arrangement = true) {
    if (content) c.revision++;
    if (arrangement) c.arrangement++;
    c.updatedAt = new Date().toISOString();
    store.put("chapters", c, c.projectId);
    enhancement?.invalidateEvents(c.id);
  }
  function context(projectId) {
    const p = store.get("projects", projectId);
    p.contextRevision++;
    store.put("projects", p);
  }
  function deletionPlan({id}) {
    return store.transaction(()=>{
      const project=store.get('projects',id),chapters=store.all('chapters',id),related=table=>chapters.flatMap(c=>store.all(table,c.id));
      const jobs=related('jobs'),attempts=jobs.flatMap(j=>store.all('attempts',j.id)),products=Object.fromEntries(['audios','masters','exports'].map(table=>[table,related(table)]));
      const snapshot=(rows,fields)=>rows.map(row=>Object.fromEntries(['id',...fields].map(field=>[field,row[field]??null]))).sort((a,b)=>a.id.localeCompare(b.id));
      const scope={project:{id,revision:project.revision??1,contextRevision:project.contextRevision??0},chapters:snapshot(chapters,['revision','arrangement']),products:Object.fromEntries(Object.entries(products).map(([table,rows])=>[table,snapshot(rows,['path','delivery','processing'])])),jobs:snapshot(jobs,['status','stop']),attempts:snapshot(attempts,['status','path','deliveryVersion','delivery','processing']),suggestions:snapshot(related('suggestions'),['draftVersion','status'])};
      scope.assistant = store.all('assistantSessions',id).map(s=>({id:s.id,revision:s.revision,state:s.state,attachments:store.all('assistantAttachments',s.id).map(a=>({id:a.id,path:a.path,sourcePath:a.sourcePath})),runs:store.all('assistantRuns',s.id).map(r=>({id:r.id,revision:r.revision,state:r.state}))}));
      const audioIds=new Set(products.audios.map(a=>a.id)),sharedVoiceIds=store.all('voices').filter(v=>audioIds.has(v.sampleAudioId)||audioIds.has(v.sourceAudioId)).map(v=>v.id);
      return {projectId:id,name:project.name,scope,chapters:chapters.map(c=>({id:c.id,title:c.title,revision:c.revision,arrangement:c.arrangement})),counts:{chapters:chapters.length,...Object.fromEntries(Object.entries(products).map(([table,rows])=>[table,rows.length]))},sharedVoiceIds,blockers:sharedVoiceIds.length?[{code:'shared-voice-reference',message:'共用音色仍引用本项目音频，请先处理引用后再删除。'}]:[]};
    });
  }
  function deleteProject(p, executionContext) {
    text(p.id, '项目标识', 100);
    let files;
    let result;
    try { result = store.transaction(() => {
      const project = store.maybe('projects', p.id);
      if (!project) return {id:p.id,deleted:true,alreadyDeleted:true};
      if (!p.scope || !same(p.scope,deletionPlan({id:p.id}).scope)) fail('项目的章节、产物或任务范围已变化，请重新查看删除范围；未删除任何资料',409);
      if (p.entityRevision !== undefined) checkEntityRevision(project, p.entityRevision);
      const chapters = store.all('chapters', project.id), chapterIds = new Set(chapters.map(c => c.id));
      const related = table => chapters.flatMap(c => store.all(table, c.id));
      const roles = store.all('roles', project.id), roleIds = new Set(roles.map(r => r.id));
      const jobs = related('jobs'), jobIds = new Set(jobs.map(j => j.id));
      const attempts = jobs.flatMap(j => store.all('attempts', j.id));
      const units = related('units'), unitIds = new Set(units.map(u => u.id));
      const events = store.all('events').filter(e => chapterIds.has(e.chapterId) || unitIds.has(e.unitId));
      const suggestions = related('suggestions');
      const owns = request => !!request && (request.projectId === project.id || chapterIds.has(request.chapterId));
      const grantIds = new Set(store.all('settings').filter(s => s.id.startsWith('ux-grant:') && s.projectId === project.id).map(s => s.grantId || s.id.slice('ux-grant:'.length)));
      if (store.all('jobs').some(j => active(j) && (chapterIds.has(j.chapterId) || owns(j.request))) || suggestions.some(s => s.status === 'running') ||
          store.all('attempts').some(a => a.status === 'sending' && jobIds.has(a.jobId) || a.grantReservation?.state === 'reserved' && grantIds.has(a.grantReservation.grantId)) ||
          attempts.some(a => a.quota?.state === 'reserved'))
        fail('本项目仍有任务或请求额度正在处理，请等待完成或停止后续任务再删除', 409);
      const assistantSessions=store.all('assistantSessions',project.id), assistantRuns=assistantSessions.flatMap(s=>store.all('assistantRuns',s.id));
      const deletingRun = assistantActor(executionContext) && executionContext.actorKind === 'human_approved_proposal' && assistantRuns.find(r => r.id === executionContext.runId);
      if(assistantRuns.some(r=>r.id !== deletingRun?.id && ['planning','executing','waitingJobs'].includes(r.state))) fail('助手仍在处理此项目，请先暂停并等当前步骤保存后再删除',409);
      const records = {
        assistantSessions, assistantRuns, assistantMessages:assistantSessions.flatMap(s=>store.all('assistantMessages',s.id)), assistantAttachments:assistantSessions.flatMap(s=>store.all('assistantAttachments',s.id)), assistantSteps:assistantRuns.flatMap(r=>store.all('assistantSteps',r.id)), assistantDecisions:assistantRuns.flatMap(r=>store.all('assistantDecisions',r.id)),
        projects:[project],chapters,roles,segments:related('segments'),units,events,suggestions,jobs,attempts,
        audios:related('audios'),masters:related('masters'),exports:related('exports'),
        settings:store.all('settings').filter(s => (s.id.startsWith('ux-') || s.id.startsWith('assistant-operation:') || s.id.startsWith('assistant-call:') || s.id.startsWith('tail-maintenance:')) && (owns(s) || owns(s.request) || owns(s.request?.data) || chapterIds.has(s.dependencies?.chapterId) ||
          s.dependencies?.roleIds?.some(id => roleIds.has(id)) || typeof s.request?.action === 'string' && (s.request.action.startsWith('role.') && roleIds.has(s.request.data?.id) ||
          s.request.action.startsWith('project.') && s.request.data?.id === project.id))),
      };
      const deletedIds = table => new Set(records[table].map(row => row.id));
      const audioIds = deletedIds('audios');
      if (store.all('voices').some(v => audioIds.has(v.sampleAudioId) || audioIds.has(v.sourceAudioId)))
        fail('共用音色仍引用本项目音频，未删除任何资料', 409);
      const sharedPaths = [...store.all('voices'), ...store.all('assistantAttachments').filter(a=>a.projectId!==project.id), ...['audios','masters','exports'].flatMap(table => {
        const ids = deletedIds(table); return store.all(table).filter(row => !ids.has(row.id));
      })].flatMap(row => recordFiles(row)).concat(store.all('attempts').filter(a => !jobIds.has(a.jobId)).flatMap(a => recordFiles(a, true)));
      sharedPaths.push(...sharedPaths.map(path => path + '.part'));
      const paths = [...records.audios,...records.masters,...records.exports,...records.assistantAttachments].flatMap(row => recordFiles(row))
        .concat(attempts.flatMap(a => recordFiles(a, true)));
      paths.push(...paths.map(path => path + '.part'));
      for (const master of records.masters.filter(m => m.path?.startsWith('masters/'))) {
        const stem = basename(master.path).replace(/\.wav$/, '');
        if (existsSync(join(store.directory, 'masters'))) for (const name of readdirSync(join(store.directory, 'masters')))
          if (name === stem + '.pcm.part' || name.startsWith(stem + '-') && /^\d+\.pcm\.part$/.test(name.slice(stem.length + 1))) paths.push(join(dirname(master.path), name));
      }
      files = stageProjectDeletion(store, project, paths, sharedPaths);
      for (const [table, rows] of Object.entries(records)) for (const row of rows) store.remove(table, row.id);
      if (deletingRun) {
        const stamp = new Date().toISOString();
        // Keep only a content-free receipt so the approved deletion can finish
        // and be read without recreating the deleted conversation or materials.
        store.put('assistantSessions', { id: deletingRun.sessionId, projectId: null, chapterId: null, title: '已删除项目的操作记录', state: 'archived', revision: 1, createdAt: stamp });
        store.put('assistantRuns', { id: deletingRun.id, sessionId: deletingRun.sessionId, binding: { projectId: null, chapterId: null }, state: 'completed', revision: deletingRun.revision + 1, mode: deletingRun.mode, objective: '项目已删除', summary: '项目及关联资料已删除。', budget: deletingRun.budget, createdAt: stamp, updatedAt: stamp }, deletingRun.sessionId);
      }
      return {id:project.id,deleted:true};
    }); } catch (error) { files?.undo(); throw error; }
    return {...result,cleanupPending:result.alreadyDeleted ? recoverProjectDeletions(store, p.id) : files?.finish() || false};
  }
  function makeSegment(c, t, role, source, order) {
    return {
      id: uid(),
      chapterId: c.id,
      order,
      text: t,
      roleId: role.id,
      type: "narration",
      roleConfirmed: source.kind === "manual",
      identityConfirmed: true,
      voiceId: roleVoice(c,role),
      voiceSource: "default",
      performance: "",
      config: { ...templateOf(templateCatalog.current).defaults },
      template: templateCatalog.current,
      model: process.env.KUNPO_TTS_MODEL || "seed-audio-1.0",
      excluded: false,
      source,
      current: null,
      previous: null,
      approved: null,
      review: null,
      latest: "none",
    };
  }
  function roleVoice(c,role) {
    return Object.hasOwn(c.roleVoices || {},role.id) ? c.roleVoices[role.id] : role.voiceId || null;
  }
  function rebind(s, roleId) {
    const r = store.get("roles", roleId);
    if (r.archived) fail("请先恢复已归档角色");
    if (s.roleId === roleId) return;
    s.roleId = r.id;
    s.roleConfirmed = true;
    if (s.voiceSource === "default") {
      s.voiceId = roleVoice(store.get('chapters',s.chapterId),r);
      s.identityConfirmed = true;
    } else s.identityConfirmed = false;
  }
  function validate(s, c) {
    for (const key of ["roleConfirmed", "identityConfirmed", "excluded"])
      if (typeof s[key] !== "boolean") fail("确认状态必须为明确的开关值");
    if (typeof s.text !== "string" || s.text.length > 10000)
      fail("朗读文字过长，请拆分片段");
    if (!s.excluded && !s.text.trim()) fail("空白正文需明确排除");
    if (typeof s.performance !== "string" || s.performance.length > 2000)
      fail("表演指导过长");
    if (!["narration", "dialogue", "thought"].includes(s.type))
      fail("片段类型无效");
    if (store.get("roles", s.roleId).projectId !== c.projectId)
      fail("角色不属于当前项目");
    if (s.voiceId) store.get("voices", s.voiceId);
    if (!s.config || typeof s.config !== "object" || Array.isArray(s.config) ||
      Object.keys(s.config).some(key => !["speech_rate", "loudness_rate", "pitch_rate"].includes(key)))
      fail("音频设置仅允许语速、音量与音高");
    for (const [key, min, max] of [
      ["speech_rate", -50, 100],
      ["loudness_rate", -50, 100],
      ["pitch_rate", -12, 12],
    ])
      if (
        !Number.isInteger(s.config[key]) ||
        s.config[key] < min ||
        s.config[key] > max
      )
        fail("音频数值设置超出允许范围");
    const target = templateOf(s.template);
    if (target.scope && target.scope !== "single") fail("此模板属于增强目标，不能用于旧单条片段");
    compile(s);
  }
  let enhancement;
  const api = {
    list,
    previewTemplate(p) {
      const c = editable(p.chapterId,p.revision), s = store.get("segments",p.id);
      if (s.chapterId !== c.id || s.retired) fail("片段已改变",409);
      const target = templateOf(p.template);
      let before = "", unavailable = "";
      try { before = compile(s); } catch(e) { unavailable = e.message; }
      return {from:s.template,to:p.template,name:target.name,description:target.description,before,after:compile({...s,template:p.template}),unavailable};
    },
    editable,
    touch,
    context,
    validate,
    voiceUsage(id) {
      store.get("voices", id);
      const refs = store
        .all("segments")
        .filter((s) => !s.retired && s.voiceId === id);
      const chapters = [...new Set(refs.map((s) => s.chapterId))].map((cid) => {
        const c = store.get("chapters", cid);
        return {
          id: cid,
          title: c.title,
          project: store.get("projects", c.projectId).name,
          count: refs.filter((s) => s.chapterId === cid).length,
        };
      });
      return {
        chapters,
        roles: store
          .all("roles")
          .filter((r) => r.voiceId === id)
          .map((r) => r.name),
        count: refs.length,
      };
    },
    snapshot() {
      const usedVoices = new Set(
        store.all("audios").map((a) => a.input.voiceId),
      );
      const jobs = store.all("jobs");
      return {
        templates: listTemplates(),
        projects: store.all("projects"),
        chapters: store.all("chapters").map(c => {
          const rows = list(c.id), included = rows.filter(s => !s.excluded);
          const task = jobs.find(j => j.chapterId === c.id && active(j));
          const statuses = included.map(s => segmentStatus(store, s));
          const productionStatus = task ? (task.status === "queued" ? "排队中" : "制作中")
            : !rows.length ? "待整理" : !included.length ? "全已排除"
            : !coverage(c, rows).valid ? "待校对"
            : included.some(s => !configurationDecided(s) || !s.voiceId) ? "待确认"
            : included.some(s => s.latest === "unknown") ? "结果待核对"
            : statuses.some(s => s.validity === "missing") ? "待生成"
            : statuses.some(s => s.validity !== "matched") ? "待更新"
            : statuses.some(s => s.review === "rework") ? "需返工"
            : statuses.every(s => s.review === "passed") ? "已检查" : "待检查";
          return { ...c, productionStatus };
        }),
        roles: store.all("roles").map(r => ({...r, aliasValidity:Object.fromEntries((r.aliasSources || []).map(a => [a.name, validAliasSource(store, a, r.projectId)]))})),
        voices: store
          .all("voices")
          .map((v) => ({ ...v, tested: usedVoices.has(v.id), inspectionCurrent: !!v.inspection?.checked &&
            (v.inspection.target === "reference" ? !!v.path && existsSync(join(store.directory,v.path)) :
              v.inspection.audioId === v.sampleAudioId && !!store.maybe("audios",v.sampleAudioId) && !storedAudioUnavailable(store,store.get("audios",v.sampleAudioId))) })),
        jobs: jobs.slice(-100).reverse().map(j => {
          const attempts = store.all("attempts", j.id);
          const sample = j.kind === "voice-test" ? attempts.find(a => a.status === "success" && store.maybe("audios", a.id)) : null;
          return { ...j, ...(sample ? { resultAudioId: sample.id, resultNotSelected: sample.selectedAsSample === false } : {}), ...(attempts.length ? {
            done: attempts.filter(a => a.status === "success").length,
            failed: attempts.filter(a => a.status === "failed").length,
            stopped: attempts.filter(a => a.status === "stopped").length,
            unknown: attempts.filter(a => a.status === "unknown").length,
            localRecoveryAttemptIds: attempts.filter(a => a.phase === 'localRecoveryPending').map(a => a.id),
            localRecoveredAudioIds: attempts.filter(a => a.phase === 'registered' && a.status !== 'success' && store.maybe('audios', a.id)).map(a => a.id),
            currentSegmentId: attempts.find(a => a.status === "sending")?.segmentId,
            attempts: attempts.map((a,index) => ({ id:a.id, ordinal:a.ordinal ?? index, segmentId:a.segmentId, unitId:a.unitId, mode:a.mode, phase:a.phase || a.status, status:a.status,
              submitted: !!a.deliveryVersion || a.quota?.state === 'used' || ['sending','success','unknown'].includes(a.status) ? true : ['queued','stopped'].includes(a.status) ? false : null,
              memberNumbers: (a.input?.members?.map(m=>m.id) || (a.segmentId?[a.segmentId]:[])).map(id=>store.maybe('segments',id)?.order).filter(n=>Number.isInteger(n)).map(n=>n+1),
            })).sort((a,b)=>a.ordinal-b.ordinal),
          } : {}), elapsedSeconds: j.finishedAt || active(j) ? Math.max(0, Math.floor((Date.parse(j.finishedAt || new Date().toISOString()) - Date.parse(j.createdAt)) / 1000)) : undefined };
        }),
      };
    },
    chapter(id) {
      const c = store.get("chapters", id);
      const segments = list(id);
      const included = segments.filter(s => !s.excluded);
      const reviewItems = included.map(s => ({id:s.id, audioId:s.current, basis:basisOf(s)}));
      const exportReady = included.length > 0 && coverage(c, segments).valid && included.every(s => {
        const status = segmentStatus(store, s);
        return status.validity === "matched" && status.review === "passed" && configurationDecided(s);
      });
      return {
        ...c,
        outputDirectory: join(store.directory, projectFile(store, id, 'output', '')),
        segments: segments.map((s) => ({ ...s, ...segmentStatus(store, s) })),
        playbackItems: segments.filter(s => !s.excluded).map(s => ({id:s.id, audioId:s.current, basis:basisOf(s), validity:segmentStatus(store,s).validity})),
        coverage: coverage(c, segments),
        masters: store
          .all("masters", id)
          .filter(
            (m) => !m.invalid && !m.superseded && existsSync(join(store.directory, m.path)),
          ),
        exports: store.all("exports", id).map(e => {
          const fileExists = !!e.path && existsSync(join(store.directory, e.path));
          return {...e, fileExists, current: fileExists && !e.superseded && exportReady && e.arrangement === c.arrangement && same(e.confirmation?.reviewItems, reviewItems)};
        }),
        knownRoles: knownRoles(store, c),
        suggestions: store.all("suggestions", id),
      };
    },
    mutate(action, p) {
      let undoFolder;
      try { return store.transaction(() => {
        if (action !== "segment.update") enhancement.assertStructural(action, p);
        const apply = () => {
        if (action === "settings.update") {
          const previous = store.maybe("settings", "models") || {
            id: "models",
            textModel: textModel(store),
          };
          checkEntityRevision(previous, p.entityRevision);
          const name = text(
            p.textModel ?? previous.textModel,
            "文本分析模型名称",
            150,
          ).trim();
          if (/[\s\u0000-\u001f]/u.test(name))
            fail("模型名称不能包含空格或控制字符");
          const gap = p.defaultGap ?? previous.defaultGap ?? 0.5;
          if (!Number.isFinite(gap) || gap < 0 || gap > 10)
            fail("默认间隔应为 0～10 秒");
          const features = { ...defaultFeatures, ...previous.features, ...p.features };
          if (Object.keys(features).some(k => !Object.hasOwn(defaultFeatures, k) || typeof features[k] !== "boolean")) fail("增强功能开关必须是明确的开关值");
          return store.put("settings", {
            ...previous,
            features,
            id: "models",
            revision: (previous.revision ?? 1) + 1,
            textModel: name,
            defaultGap: gap,
          });
        }
        if (action === "project.create") {
          const project = {
            id: uid(),
            name: text(p.name, "项目名称", 100).trim(),
            contextRevision: 1,
            createdAt: new Date().toISOString(),
          };
          if (store.maybe('settings', 'project-folders')?.enabled) {
            createProjectFolder(store, project);
            undoFolder = () => rmSync(join(store.directory, project.folder), { recursive: true, force: true });
          }
          store.put("projects", project);
          store.put(
            "roles",
            {
              id: uid(),
              projectId: project.id,
              name: "旁白",
              aliases: [],
              voiceId: null,
              facts: [],
              narrator: true,
            },
            project.id,
          );
          return project;
        }
        if (action === "project.rename") {
          const v = store.get("projects", p.id);
          checkEntityRevision(v, p.entityRevision);
          const name = text(p.name, "项目名称", 100).trim();
          undoFolder = renameProjectFolder(store, v, name);
          v.name = name;
          v.revision = (v.revision ?? 1) + 1;
          return store.put("projects", v);
        }
        if (action === "chapter.create") {
          store.get("projects", p.projectId);
          const operationKey = p.operationId === undefined ? null : `ux-chapter-create:${text(p.operationId,'操作标识',100)}`;
          const receipt = operationKey && store.maybe('settings',operationKey);
          if (receipt) {
            if (!same(receipt.request,p)) fail('同一操作标识的内容不同',409);
            return store.get('chapters',receipt.chapterId);
          }
          const fieldErrors = importProblems(p);
          if (Object.keys(fieldErrors).length) fail(Object.values(fieldErrors).join('；'),400,{
            code:'import-validation-rejected',outcome:'notApplied',notApplied:true,fieldErrors,
            scope:{kind:'operation',action:'chapter.create',projectId:p.projectId,operationId:p.operationId},
          });
          const source =
            typeof p.source === "string"
              ? p.source.replace(/\r\n?/g, "\n")
              : "";
          const c = {
            id: uid(),
            projectId: p.projectId,
            title: p.title,
            source,
            sourceVersion: 1,
            importedSource:
              typeof p.importedSource === "string" ? p.importedSource : source,
            sourceFilename:
              typeof p.sourceFilename === "string"
                ? p.sourceFilename.slice(0, 200)
                : null,
            revision: 1,
            arrangement: 1,
            gap: store.maybe("settings", "models")?.defaultGap ?? 0.5,
            order: store.all("chapters", p.projectId).length,
            updatedAt: new Date().toISOString(),
          };
          store.put("chapters", c, p.projectId);
          context(p.projectId);
          const narrator = store
            .all("roles", p.projectId)
            .find((r) => r.narrator);
          if (p.segment && source)
            pieces(source).forEach((span, i) =>
              store.put(
                "segments",
                makeSegment(
                  c,
                  span.text,
                  narrator,
                  {
                    kind: "original",
                    version: 1,
                    spans: [{ start: span.start, end: span.end }],
                  },
                  i,
                ),
                c.id,
              ),
            );
          if (operationKey) store.put('settings',{id:operationKey,projectId:p.projectId,chapterId:c.id,request:JSON.parse(JSON.stringify(p)),at:new Date().toISOString()});
          return c;
        }
        if (action === "role.create") {
          store.get("projects", p.projectId);
          if (
            p.chapterId &&
            store.get("chapters", p.chapterId).projectId !== p.projectId
          )
            fail("角色与章节不属于同一项目");
          const role = {
            id: uid(),
            projectId: p.projectId,
            name: text(p.name, "角色名称", 100),
            aliases: [],
            voiceId: null,
            facts: [],
            introducedIn: p.chapterId || null,
            narrator: false,
          };
          context(p.projectId);
          return store.put("roles", role, p.projectId);
        }
        if (action === "role.update") {
          const r = store.get("roles", p.id);
          checkEntityRevision(r, p.entityRevision);
          const first = !r.voiceId;
          if (p.archived !== undefined) {
            if (typeof p.archived !== "boolean") fail("归档状态无效");
            if (
              p.archived &&
              (r.narrator ||
                store
                  .all("segments")
                  .some((s) => !s.retired && s.roleId === r.id))
            )
              fail("请先处理所有引用片段；旁白不能归档");
            if (!!r.archived !== p.archived) {
              r.archived = p.archived;
              context(r.projectId);
            }
          }
          if (p.name !== undefined) {
            const name = text(p.name, "角色名称", 100);
            if (name !== r.name) {
              r.name = name;
              context(r.projectId);
            }
          }
          if (p.aliases !== undefined && !same(r.aliases, p.aliases))
            fail("请逐项填写别名的来源与依据后保存");
          if (p.aliasSources !== undefined) {
            if (!Array.isArray(p.aliasSources)) fail("别名来源格式无效");
            const before = r.aliasSources || (r.aliases || []).map(name => ({name, chapterId:null, needsReview:true}));
            if (!same(before, p.aliasSources)) {
              const c = editable(p.chapterId, p.revision);
              if (c.projectId !== r.projectId) fail("角色与章节不属于同一项目");
              const sources = p.aliasSources.map(a => {
                if (!a || typeof a !== "object") fail("别名来源格式无效");
                if (before.some(b => same(a, b))) return a;
                if (a.chapterId !== c.id) fail("请到别名的来源章节修改或重新确认");
                const item = {
                  name: text(a.name, "别名", 100).trim(), chapterId:c.id,
                  kind:a.kind, sourceQuote:a.sourceQuote || "", reason:a.reason || "",
                  sourceVersion:a.sourceVersion,
                };
                if (typeof item.sourceQuote !== "string" || item.sourceQuote.length > 3000 || typeof item.reason !== "string" || item.reason.length > 3000)
                  fail("别名的引文或说明格式无效");
                if (item.sourceVersion !== (c.sourceVersion || 1) || !validAliasSource(store, item, r.projectId))
                  fail("请核对别名依据：明示或推断需本章逐字引文，推断还需说明；用户补充不填原文引文");
                return item;
              });
              if (new Set(sources.map(a => a.name)).size !== sources.length) fail("同一角色的别名不能重复");
              if (before.some(a => a.chapterId && a.chapterId !== c.id && !sources.some(b => same(a,b))))
                fail("请到别名的来源章节修改或移除；其他章的记录保持原样");
              r.aliasSources = sources;
              r.aliases = sources.map(a => a.name);
              context(r.projectId);
            }
          }
          if (p.note !== undefined) {
            const c = editable(p.chapterId, p.revision);
            if (c.projectId !== r.projectId) fail("角色与章节不属于同一项目");
            if (
              typeof p.note !== "string" ||
              p.note.length > 3000 ||
              typeof p.quote !== "string"
            )
              fail("人物备注格式无效");
            if (p.quote && !c.source.includes(p.quote))
              fail("原文依据须逐字来自当前章节");
            const facts = (r.facts || []).filter((f) => f.chapterId !== c.id);
            const gender =
              p.gender ??
              (r.facts || []).find((f) => f.chapterId === c.id)?.gender ??
              "未知";
            if (!["未知", "女", "男", "其他"].includes(gender))
              fail("性别信息无效");
            if (p.note.trim() || gender !== "未知")
              facts.push({
                chapterId: c.id,
                text: p.note,
                gender,
                sourceQuote: p.quote,
                sourceVersion: c.sourceVersion || 1,
                kind: p.quote ? "原文明示" : "用户补充",
              });
            if (!same(r.facts, facts)) {
              r.facts = facts;
              context(r.projectId);
            }
          }
          if (p.voiceId !== undefined) {
            if (
              p.voiceId &&
              p.voiceId !== r.voiceId &&
              store.get("voices", p.voiceId).state !== "active"
            )
              fail("请选择可用音色");
            const c = p.chapterId ? editable(p.chapterId, p.revision) : null;
            if (c && c.projectId !== r.projectId)
              fail("角色和章节不属于同一项目");
            const chapterOnly = p.chapterOnly === true && !first;
            if (chapterOnly && !c) fail('本章声音选择需要明确章节');
            if (chapterOnly) c.roleVoices = {...c.roleVoices,[r.id]:p.voiceId || null};
            else {
              r.voiceId = p.voiceId || null;
              if (c && p.apply && c.roleVoices) { c.roleVoices = {...c.roleVoices}; delete c.roleVoices[r.id]; }
            }
            const voiceId = chapterOnly ? p.voiceId || null : r.voiceId;
            if (c && ((first && voiceId) || p.apply)) {
              for (const s of list(c.id))
                if (
                  s.roleId === r.id &&
                  s.voiceSource !== "override" &&
                  (p.apply || !s.voiceId)
                ) {
                  s.voiceId = voiceId;
                  if (p.identityChosen === true || policyOf(store,r.projectId).revision) s.identityConfirmed = true;
                  store.put("segments", s, c.id);
                }
              touch(c, true, false);
            }
          }
          r.revision = (r.revision ?? 1) + 1;
          return store.put("roles", r, r.projectId);
        }
        if (action === "voice.delete") {
          if (p.confirm !== true) fail("请明确确认删除参考素材");
          const v = store.get("voices", p.id);
          if (v.state === "deleted") return v;
          checkEntityRevision(v, p.entityRevision);
          v.state = "stopped";
          v.deletePending = true;
          v.revision = (v.revision ?? 1) + 1;
          return store.put("voices", v);
        }
        if (action === "voice.update") {
          const v = store.get("voices", p.id);
          if (v.deletePending || v.state === "deleted")
            fail("参考素材正在删除或已删除");
          checkEntityRevision(v, p.entityRevision);
          if (p.name !== undefined) v.name = text(p.name, "音色名称", 100);
          if (p.observations !== undefined) {
            if (!p.observations || typeof p.observations !== "object" || Array.isArray(p.observations)) fail("参考观察格式无效");
            const observations = {};
            for (const key of ["tone", "accent", "performance", "volume"]) {
              const value = p.observations[key] ?? "";
              if (typeof value !== "string" || value.length > 1000) fail("每项参考观察最多 1000 字");
              observations[key] = value.trim();
            }
            if (!same(v.observations, observations)) {
              v.observations = observations;
              const affected = new Set(store.all("roles").filter(r => r.voiceId === v.id).map(r => r.projectId));
              for (const s of store.all("segments").filter(s => !s.retired && s.voiceId === v.id)) {
                const c = store.maybe("chapters",s.chapterId); if (c) affected.add(c.projectId);
              }
              for (const id of affected) context(id);
            }
          }
          if (p.inspection !== undefined) {
            const r = p.inspection;
            if (!r || !["reference","sample"].includes(r.target) || typeof r.checked !== "boolean") fail("音色检查记录无效");
            if (r.target === "sample" && (!v.sampleAudioId || r.audioId !== v.sampleAudioId)) fail("测试样音已变化，请核对当前样音后重新检查",409);
            if (r.target === "reference" && r.audioId != null) fail("参考检查不能关联测试样音");
            const sample = r.target === "sample" ? store.maybe("audios",r.audioId) : null;
            if (r.checked && (r.target === "reference" ? !v.path || !existsSync(join(store.directory,v.path)) : !sample || storedAudioUnavailable(store,sample))) fail("所选音频不可用，不能记录已检查");
            v.inspection = {target:r.target,audioId:r.target === "sample" ? r.audioId : null,checked:r.checked,at:new Date().toISOString()};
          }
          if (p.state !== undefined) {
            if (!["active", "archived", "stopped"].includes(p.state))
              fail("素材状态无效");
            v.state = p.state;
          }
          v.revision = (v.revision ?? 1) + 1;
          return store.put("voices", v);
        }
        if (action === "job.stop") {
          const j = store.get("jobs", p.id);
          if (active(j)) {
            j.stop = true;
            store.put("jobs", j, j.chapterId || "");
          }
          return j;
        }
        const c = editable(p.chapterId, p.revision);
        if (action === "chapter.update") {
          const oldGap = c.gap;
          const oldTitle = c.title;
          if (p.title !== undefined) c.title = text(p.title, "章节名称", 150);
          if (p.gap !== undefined) {
            if (!Number.isFinite(p.gap) || p.gap < 0 || p.gap > 10)
              fail("片段间隔应为 0～10 秒");
            c.gap = p.gap;
          }
          if (c.gap !== oldGap) touch(c);
          else {
            if (c.title !== oldTitle) c.revision++;
            store.put("chapters", c, c.projectId);
          }
          return c;
        }
        if (action === "chapter.move") {
          const chapters = store
            .all("chapters", c.projectId)
            .sort((a, b) => a.order - b.order);
          const i = chapters.findIndex((x) => x.id === c.id),
            next = chapters[i + (p.direction === -1 ? -1 : 1)];
          if (next) {
            editable(next.id, next.revision);
            const order = c.order;
            c.order = next.order;
            next.order = order;
            touch(c, true, false);
            touch(next, true, false);
            context(c.projectId);
          }
          return c;
        }
        if (action === "segment.create") {
          const r = store.all("roles", c.projectId).find((r) => r.narrator);
          const s = makeSegment(
            c,
            text(p.text, "正文", 10000),
            r,
            {
              kind: "manual",
              version: c.sourceVersion || 1,
              spans: [],
              text: p.text,
            },
            list(c.id).length,
          );
          store.put("segments", s, c.id);
          touch(c);
          return s;
        }
        if (action === "segment.rebind") {
          if (
            !Array.isArray(p.ids) ||
            !p.ids.length ||
            new Set(p.ids).size !== p.ids.length
          )
            fail("请选择待改绑片段");
          const rows = p.ids.map((id) => store.get("segments", id));
          if (rows.some((s) => s.chapterId !== c.id || s.retired))
            fail("所选片段已经变化", 409);
          for (const s of rows) {
            rebind(s, p.roleId);
            validate(s, c);
            store.put("segments", s, c.id);
          }
          touch(c, true, false);
          return c;
        }
        if (action === "segment.confirm") {
          if (
            !Array.isArray(p.ids) ||
            !p.ids.length ||
            new Set(p.ids).size !== p.ids.length
          )
            fail("请选择待确认片段");
          const rows = p.ids.map((id) => store.get("segments", id));
          if (rows.some((s) => s.chapterId !== c.id || s.retired))
            fail("所选片段已经变化", 409);
          for (const s of rows) {
            s.roleConfirmed = true;
            if (p.roleOnly !== true) s.identityConfirmed = true;
            store.put("segments", s, c.id);
          }
          touch(c, true, false);
          return c;
        }
        const s = store.get("segments", p.id);
        if (s.chapterId !== c.id || s.retired) fail("片段已改变", 409);
        if (action === "segment.template") {
          if (p.confirm !== true) fail("请先核对提示词差异并明确应用模板");
          templateOf(p.template);
          if (p.template === s.template) return s;
          s.template = p.template;
          validate(s,c);
          store.put("segments",s,c.id);
          touch(c,true,false);
          return s;
        }
        if (action === "segment.update") {
          if (p.autosave && typeof p.text === 'string' && !p.text.trim() && p.excluded !== true) fail('正文为空，暂存内容尚未应用；请继续输入或明确选择不朗读');
          if (p.template !== undefined && p.template !== s.template) fail("请使用明确的模板切换操作");
          const wasExcluded = s.excluded;
          const allowed = [
            "text",
            "type",
            "roleConfirmed",
            "identityConfirmed",
            "performance",
            "excluded",
            "config",
          ];
          for (const key of allowed) if (p[key] !== undefined) s[key] = p[key];
          if (p.roleId !== undefined) rebind(s, p.roleId);
          if (p.voiceId !== undefined) {
            if (p.voiceId && store.get("voices", p.voiceId).state !== "active")
              fail("请选择可用音色");
            s.voiceId = p.voiceId;
            s.voiceSource = "override";
            s.identityConfirmed = true;
          }
          if (p.resetVoice) {
            s.voiceId = roleVoice(c,store.get("roles", s.roleId));
            s.voiceSource = "default";
            s.identityConfirmed = true;
          }
          if (
            p.text !== undefined &&
            p.text !== store.get("segments", s.id).text
          ) {
            const previous = store.get("segments", s.id);
            s.editHistory = [
              ...(s.editHistory || []),
              { revision: c.revision, text: previous.text },
            ];
          }
          if (typeof s.text === "string" && !s.text.trim()) {
            s.excluded = true;
            s.exclusionReason = "用户清空朗读正文";
          }
          enhancement.assertStructural(action, { ...p, excluded: s.excluded });
          validate(s, c);
          store.put("segments", s, c.id);
          touch(c, true, wasExcluded !== s.excluded);
          return { ...s, chapterRevision: c.revision };
        }
        if (action === "segment.split") {
          const chars = Array.from(s.text);
          if (!p.parts && (
            !Number.isInteger(p.offset) ||
            p.offset <= 0 ||
            p.offset >= chars.length
          ))
            fail("请选择正文中间的拆分位置");
          const parts = p.parts || [chars.slice(0,p.offset).join(''),chars.slice(p.offset).join('')];
          if (!Array.isArray(parts) || parts.length < 2 || parts.some(part => typeof part !== 'string' || !part.trim()) || parts.join('') !== s.text) fail('拆分结果必须按顺序逐字覆盖原正文');
          if (s.performance && (!Array.isArray(p.performance) || p.performance.length !== parts.length || p.performance.some(x => typeof x !== "string"))) fail("请明确分配拆分后两条的表演指导");
          const group = s.source.group || uid();
          let offset = 0;
          const children = parts.map((t, i) => {
            const splitOffset = offset; offset += Array.from(t).length;
            return inheritStructure({
            ...s,
            id: uid(),
            text: t,
            order: s.order + i / parts.length,
            performance: p.performance?.[i] ?? "",
            source: {
              ...s.source,
              spans: s.source.spans.map((span) => ({
                ...span,
                origin: span.origin || s.source.group || s.id,
              })),
              kind: "edited",
              group,
              parentIds: [s.id],
              parentRevision: c.revision,
              splitOffset: p.parts ? splitOffset : p.offset,
            },
            current: null,
            previous: null,
            approved: null,
            review: null,
            latest: "none",
          },[s],action,p.operationId); });
          children.forEach((v) => {
            validate(v, c);
            store.put("segments", v, c.id);
          });
          s.retired = true;
          store.put("segments", s, c.id);
          list(c.id).forEach((v, i) => {
            v.order = i;
            store.put("segments", v, c.id);
          });
          touch(c);
          return children;
        }
        if (action === "segment.merge") {
          const rows = list(c.id);
          const n = rows[rows.findIndex((v) => v.id === s.id) + 1];
          if (
            !n ||
            s.roleId !== n.roleId ||
            s.type !== n.type ||
            s.excluded ||
            n.excluded
          )
            fail("只能合并相邻、同角色、同类型的有效片段");
          if (
            !same(
              [s.voiceId, s.config, s.template, inputOf(s).model],
              [n.voiceId, n.config, n.template, inputOf(n).model],
            ) &&
            !["first", "second"].includes(p.choice)
          )
            fail("音色或配置不同，请明确选择合并后的设置", 409);
          if ((s.performance || n.performance) && typeof p.performance !== "string") fail("请确认合并后的表演指导");
          const chosen = p.choice === "second" ? n : s;
          const merged = inheritStructure({
            ...chosen,
            id: uid(),
            text: s.text + n.text,
            order: s.order,
            voiceSource:
              s.voiceSource === n.voiceSource ? s.voiceSource : "override",
            performance: p.performance ?? "",
            identityConfirmed: s.identityConfirmed && n.identityConfirmed,
            roleConfirmed: s.roleConfirmed && n.roleConfirmed,
            source: {
              kind: "edited",
              version: c.sourceVersion || 1,
              parentRevision: c.revision,
              spans: [s, n]
                .flatMap((row) =>
                  row.source.spans.map((span) => ({
                    ...span,
                    origin: span.origin || row.source.group || row.id,
                  })),
                )
                .filter((v, i, a) => a.findIndex((w) => same(v, w)) === i),
              group: s.source.group === n.source.group ? s.source.group : uid(),
              parentIds: [s.id, n.id],
            },
            current: null,
            previous: null,
            approved: null,
            review: null,
            latest: "none",
          },[s,n],action,p.operationId);
          validate(merged, c);
          s.retired = n.retired = true;
          store.put("segments", s, c.id);
          store.put("segments", n, c.id);
          store.put("segments", merged, c.id);
          list(c.id).forEach((v, i) => {
            v.order = i;
            store.put("segments", v, c.id);
          });
          touch(c);
          return merged;
        }
        if (action === "segment.review") {
          if (!["passed", "rework"].includes(p.state)) fail("检查状态无效");
          if (
            segmentStatus(store, s).validity !== "matched" ||
            s.current !== p.audioId ||
            !same(p.basis, basisOf(s))
          )
            fail("试听版本已变化，请重新检查当前音频", 409);
          s.review = {
            audioId: s.current,
            basis: basisOf(s),
            state: p.state,
            at: new Date().toISOString(),
          };
          if (p.state === "passed") s.approved = s.current;
          store.put("segments", s, c.id);
          const a = store.get("audios", s.current);
          a.review = s.review;
          store.put("audios", a, c.id);
          return s;
        }
        if (action === "segment.restore") {
          if (![s.previous, s.approved].includes(p.audioId))
            fail("只能恢复上一版或最近通过版");
          const a = store.get("audios", p.audioId);
          if (!audioMatches(s, a) && !p.restoreSettings)
            fail("此音频设置不同，请确认恢复设置", 409);
          const rework = s.review?.state === "rework";
          if (p.restoreSettings) {
            if (s.voiceId !== a.input.voiceId) s.voiceSource = "override";
            Object.assign(s, audioInput(a));
          }
          const old = s.current;
          s.current = a.id;
          if (old !== a.id) s.previous = old;
          s.review =
            a.review &&
            same(reviewBasis(a.review.basis, a.model), basisOf(s)) &&
            !rework
              ? { ...a.review, basis: reviewBasis(a.review.basis, a.model) }
              : {
                  audioId: s.current,
                  basis: basisOf(s),
                  state: rework ? "rework" : "pending",
                };
          validate(s, c);
          store.put("segments", s, c.id);
          touch(c, true, old !== s.current);
          return s;
        }
        fail("未知操作");
        };
        const result = apply();
        enhancement.syncLegacy();
        return result;
      }); } catch (error) { undoFolder?.(); throw error; }
    },
  };
  enhancement = createEnhancement(store, { ...api, inputOf, basisOf, reviewBasis, coverage, performanceIssues });
  api.enhancement = enhancement;
  api.textModel = () => textModel(store);
  api.roleVoice = roleVoice;
  api.configurationDecided = configurationDecided;
  api.deletionPlan = deletionPlan;
  api.structuralRepairPlan = ({chapterId}) => {
    const c=store.get('chapters',chapterId), rows=list(c.id), targets=rows.filter(s=>!configurationDecided(s));
    const proof=s=>s && Object.fromEntries(['id','chapterId','retired','source','text','roleId','type','voiceId','voiceSource','config','template','model','roleConfirmed','identityConfirmed','decisions'].map(field=>[field,s[field]??null]));
    const scope=targets.map(s=>({target:proof(s),parents:(s.source?.parentIds || []).map(id=>proof(store.maybe('segments',id)))}));
    return {chapterId:c.id,revision:c.revision,dryRun:true,scope,items:targets.map(s=>{
      const parentIds=s.source?.parentIds || [], parents=parentIds.map(id=>store.maybe('segments',id)), siblings=rows.filter(r=>same(r.source?.parentIds,parentIds));
      const proven=parentIds.length>0 && Number.isInteger(s.source.parentRevision) && s.source.parentRevision<=c.revision && parents.every(p=>p?.retired && p.chapterId===c.id && p.roleId===s.roleId && p.type===s.type) && (parents.length===1 ? siblings.map(r=>r.text).join('')===parents[0].text : s.text===parents.map(p=>p.text).join('')) && parents.some(p=>same([s.voiceId,s.config,s.template,inputOf(s).model],[p.voiceId,p.config,p.template,inputOf(p).model]));
      const next=JSON.parse(JSON.stringify(s));
      const fields=proven ? ['role','identity'].filter(field=>s.decisions?.[field] && parents.some(p=>same(p.decisions?.[field],s.decisions[field])) && !same(s.decisions[field].values,field==='role'?[s.roleId,s.type]:[s.roleId,s.voiceId,s.voiceSource]) && parents.every(configurationDecided)) : [];
      for(const field of fields) decide(next,field,'structural',{parentIds:s.source.parentIds,parentRevision:s.source.parentRevision,action:'repair',previousDecision:s.decisions[field]});
      return {id:s.id,parentIds,eligible:fields.length>0 && configurationDecided(next),fields,before:s.decisions || null,proposed:fields.length?next.decisions:null,reason:fields.length?'父记录与最终结构可核对，旧决定值未转换':'缺少可证明来源或存在待确认父项，请人工核对'};
    })};
  };
  api.actionReadiness = (u, mode=u.mode, st=enhancement.status(u,mode), history) => {
    const scope={unitId:u.id,memberIds:u.members,mode}, issue=(code,message,resolution)=>({code,scope,message,resolution});
    const members=u.members.map(id=>store.maybe('segments',id)), identity=!members.length || members.some(s=>!s || s.retired || s.excluded || !configurationDecided(s)), outstandingAttemptIds=outstandingAttempts(store,[{targetKind:'unit',targetId:u.id,mode}],history).map(a=>a.id);
    const generate=[], play=[], exported=[], warnings=[];
    if(identity) { const i=issue('configuration-undecided','角色或声音决定与当前设置不一致','confirm-configuration');generate.push(i);exported.push(i); }
    if(members.some(s=>{const v=s?.voiceId && store.maybe('voices',s.voiceId);return !v || !['active','archived'].includes(v.state) || v.deletePending || !v.path || !existsSync(join(store.directory,v.path));})) generate.push(issue('reference-unavailable','参考声音已停用或缺失','choose-reference'));
    if(st.promptIssues?.length || Array.from(st.prompt || '').length>3000) generate.push(issue('prompt-invalid',st.promptIssues?.join('；') || '完整提示超过3000字符','edit-settings'));
    const relatedAttemptIds=outstandingAttempts(store,[{targetKind:'unit',targetId:u.id,mode}],history,true).map(a=>a.id);
    if(relatedAttemptIds.length) generate.push({...issue('request-unknown','相关目标的上次请求结果不明，继续生成需要一次明确决定','decide-unknown'),attemptIds:relatedAttemptIds});
    if(outstandingAttemptIds.length) warnings.push({...issue('request-unknown','上次请求结果不明，现有声音仍可使用','decide-unknown'),attemptIds:outstandingAttemptIds});
    if(['missing','broken'].includes(st.validity)) play.push(issue('audio-'+st.validity,st.validity==='missing'?'没有可试听音频':'原音频损坏或缺失','restore-audio'));
    if(st.validity!=='matched') exported.push(issue('audio-'+st.validity,'当前成品没有匹配的完整音频','restore-or-generate'));
    if(st.review==='rework') exported.push(issue('audio-rework','当前声音已标记返工','redo-rejected'));
    else if(st.review!=='passed') exported.push(issue('audio-unreviewed','当前声音尚未检查通过','review-audio'));
    return {outstandingAttemptIds,generate:{allowed:!generate.length,blockers:generate,warnings:[]},play:{allowed:!play.length,blockers:play,warnings},export:{allowed:!exported.length,blockers:exported,warnings}};
  };
  const originalMutate = api.mutate, originalSnapshot = api.snapshot, originalChapter = api.chapter;
  api.mutate = (action, p, executionContext) => {
    const actor = assistantActor(executionContext);
    if (actor && action === 'segment.create' && executionContext.textMutationPolicy !== 'explicitSpecifiedEdit') fail('本次任务要求保留原文，不能新增朗读正文',403);
    if (actor && ['segment.review','unit.review'].includes(action) && p.state === 'passed' && !executionContext.humanReview?.audioIds?.includes(p.audioId)) fail('未取得用户对这份声音的人工听评决定',403);
    return action === 'project.delete' ? deleteProject(p, executionContext) : assistantMutation(store,action,p,executionContext,()=>store.transaction(() => {
    if (action === 'chapter.repair-structural-decisions') {
      const c=editable(p.chapterId,p.revision),plan=api.structuralRepairPlan({chapterId:c.id});
      if (!p.scope || !same(p.scope,plan.scope)) fail('结构修复预览范围已变化，请重新核对；未修改任何决定',409);
      if (!Array.isArray(p.ids) || !p.ids.length || new Set(p.ids).size!==p.ids.length || p.ids.some(id=>!plan.items.some(item=>item.id===id && item.eligible))) fail('仅可修复本次预览中有可证明来源的目标；未知来源需人工核对',409);
      const changeId=uid(),items=p.ids.map(id=>{const s=store.get('segments',id),decisions=plan.items.find(item=>item.id===id).proposed;return {id,before:{decisions:s.decisions},after:{decisions}};});
      const change={id:`ux-change:${changeId}`,changeId,kind:'structural-repair',projectId:c.projectId,chapterId:c.id,revision:c.revision,items,scope:p.scope,at:new Date().toISOString()};
      store.put('settings',change);
      for (const item of items) store.put('segments',{...store.get('segments',item.id),...item.after},c.id);
      touch(c,true,false);
      return {changeId,chapterId:c.id,chapterRevision:c.revision,repairedIds:p.ids};
    }
    if (['segment.split','segment.merge'].includes(action)) p={...p,operationId:p.operationId || uid()};
    const effectsBefore = actor ? assistantEffectState(store,api,action==='chapter.create'?null:p.chapterId,action==='role.update'?p.id:null) : null;
    const before = p.chapterId && (/^segment\./.test(action) || action === 'role.update') ? api.list(p.chapterId) : [];
    const previousUnit = actor && /^(unit|event)\./.test(action) && (p.unitId || action.startsWith('unit.') && p.id) ? store.maybe('units',p.unitId || p.id) : null;
    const protectedEvents=actor&&action==='unit.restore'?store.all('events',p.id).filter(e=>e.state==='adopted'&&(!e.source?.kind||['user','inherited_user'].includes(e.source.kind))):[];
    if(actor&&action==='unit.dissolve'&&!previousUnit?.creationSource&&!assistantOverride(executionContext,p.id,'state'))fail('这项人工一起演绎设置受保护，请先核对具体修改',409);
    const previousEvent = actor && action.startsWith('event.') && p.id ? store.maybe('events',p.id) : null;
    const result = /^(voice-session|voice-candidate|unit|event)\./.test(action) ? enhancement.mutate(action,p) : originalMutate(action,p);
    if (actor) assertAssistantEffects(assistantEffects(effectsBefore,assistantEffectState(store,api,action==='chapter.create'?result.id:p.chapterId,action==='role.update'?p.id:null)),executionContext);
    for (const previous of before) {
      const current = store.get('segments',previous.id);
      if (!actor && p.identityChosen !== true && !previous.decisions && !policyOf(store,store.get('chapters',current.chapterId).projectId).revision) continue;
      if ((actor ? assistantChanges(previous,current,action,p,executionContext) : humanChanges(previous,current,action,p))) store.put('segments',current,current.chapterId);
    }
    for(const old of protectedEvents){const current=store.get('events',old.id);if(['kind','description','memberId','position','startMemberId','endMemberId','startPosition','endPosition','transition','evidence','state'].some(field=>!same(old[field],current[field]))&&!assistantOverride(executionContext,old.id,'state'))fail('这项人工声音事件受保护，请先核对具体修改',409);}
    if (actor && ['unit.create','unit.update','unit.restore'].includes(action)) {
      const unit = store.get('units',result.id), mode = p.mode || unit.mode, variant = unit.variants[mode], previous = previousUnit?.variants[mode];
      for (const field of ['guidance','backgroundPresence']) if ((p[field] !== undefined || action === 'unit.restore') && !same(previous?.[field],variant[field])) {
        const source = previous?.[field+'Source']?.kind, manual = previous?.[field] && (!source || ['user','inherited_user'].includes(source));
        if (manual && !assistantOverride(executionContext,unit.id,field)) fail('这项人工声音设置受保护，请先核对具体修改',409);
        variant[field+'Source'] = {kind:'policy_ai',at:new Date().toISOString(),...actor};
      }
      if(action==='unit.create')unit.creationSource=actor;unit.executionSource = actor; store.put('units',unit,unit.chapterId);
    }
    if(actor && action==='voice-session.create' && p.projectId){store.get('projects',p.projectId);result.projectId=p.projectId;result.executionSource=actor;store.put('voiceSessions',result);}
    if (actor && action.startsWith('event.')) {
      const event = store.get('events',result.id);
      const changed = ['kind','description','memberId','position','startMemberId','endMemberId','startPosition','endPosition','transition','evidence'].filter(field=>!same(previousEvent?.[field],event[field]));
      if(previousEvent?.state==='adopted'&&event.state!=='adopted')changed.push('state');
      if (previousEvent && (!previousEvent.source?.kind || ['user','inherited_user'].includes(previousEvent.source.kind))) for (const field of changed) if (!assistantOverride(executionContext,event.id,field)) fail('这项人工声音事件受保护，请先核对具体修改',409);
      if (changed.length) event.source = {kind:'policy_ai',...actor};
      if (previousEvent?.state !== event.state) event.adoptionSource = actor;
      store.put('events',event,event.unitId);
    }
    if (result.id && /^segment\./.test(action) && store.maybe('segments',result.id)) return {...store.get('segments',result.id),...(result.chapterRevision ? {chapterRevision:result.chapterRevision} : {})};
    return result;
  })); };
  api.previewAssistantEffects = (action,p,candidateVoiceId,apply) => {
    if (!/^(segment|role)\./.test(action) && action!=='chapter.create' && !apply) return {voiceAssignments:[]};
    const receipt = {};
    try { store.transaction(() => {
      if(candidateVoiceId && !store.maybe('voices',candidateVoiceId)) store.put('voices',{id:candidateVoiceId,state:'active'});
      const before = assistantEffectState(store,api,action==='chapter.create'?null:p.chapterId,action==='role.update'?p.id:null);
      const result=apply?apply():api.mutate(action,p);
      receipt.effects = assistantEffects(before,assistantEffectState(store,api,action==='chapter.create'?result.id:p.chapterId,action==='role.update'?p.id:null));
      throw receipt;
    }); } catch (error) { if (error!==receipt) throw error; }
    return receipt.effects;
  };
  api.snapshot = () => {
    enhancement.syncLegacy();
    const result = originalSnapshot();
    return { ...result, ...enhancement.snapshot(), enhancementTemplates:listUnitTemplates(), jobs: result.jobs.map(j => { if (!['voice-create','unit-generate'].includes(j.kind)) return j; const a=store.all('attempts',j.id).find(a=>a.status==='success' && store.maybe('audios',a.id)); return {...j,...(a?{resultAudioId:a.id,resultNotSelected:a.adopted===false}:{})}; }), chapters: result.chapters.map(c => {
      const task = result.jobs.find(j => j.chapterId === c.id && active(j));
      const { rows, issues: arrangementIssues } = enhancement.inspectArrangement(c.id);
      const base = ['待整理','全已排除','待校对','待确认'].includes(c.productionStatus);
      const unknown = rows.some(r => enhancement.getUnit(r.s.id).variants[r.s.mode].latest === 'unknown');
      return { ...c, arrangementIssues, productionStatus: arrangementIssues.length ? '编排需修复' : task ? c.productionStatus : base ? c.productionStatus : unknown ? '结果待核对' : rows.some(r => r.validity === 'missing') ? '待生成' : rows.some(r => r.validity !== 'matched') ? '待更新' : rows.some(r => r.review === 'rework') ? '需返工' : rows.every(r => r.review === 'passed') ? '已检查' : '待检查' };
    }) };
  };
  api.chapter = id => {
    enhancement.syncLegacy();
    const result = originalChapter(id), { rows, issues: arrangementIssues } = enhancement.inspectArrangement(id,result), reviewItems = rows.map(r => ({ id: r.s.id, audioId: r.a?.id || null, basis: r.basis }));
    const exportReady = !arrangementIssues.length && rows.length > 0 && result.coverage.valid && result.segments.filter(s => !s.excluded).every(configurationDecided) && rows.every(r => r.validity === 'matched' && r.review === 'passed');
    const history=store.all('attempts');
    const units = store.all('units', id).filter(u => u.state !== 'retired').map(u=>{
      const v=enhancement.view(u,result), readiness=api.actionReadiness(u,u.mode,v.status,history);
      return {...v,outstandingAttemptIds:readiness.outstandingAttemptIds,readiness,variants:Object.fromEntries(Object.entries(v.variants).map(([mode,variant])=>[mode,{...variant,outstandingAttemptIds:outstandingAttempts(store,[{targetKind:'unit',targetId:u.id,mode}],history).map(a=>a.id)}]))};
    });
    const playbackItems=rows.map(r=>{const u=units.find(u=>u.id===r.s.id);return {id:r.s.id,unitId:r.s.id,members:r.s.members,mode:r.s.mode,audioId:r.a?.id || null,basis:r.basis,validity:r.validity,review:r.review,latest:u?.outstandingAttemptIds.length?'unknown':u?.variants[r.s.mode].latest,outstandingAttemptIds:u?.outstandingAttemptIds || [],readiness:u?.readiness};});
    return { ...result, arrangementIssues, units, events: units.flatMap(u => u.events), reviewItems, playbackItems, segments: result.segments.map(s => { const group = units.find(u => u.kind === 'group' && u.state === 'active' && u.members.includes(s.id)); return { ...s, configurationDecided:configurationDecided(s), ...(group ? {groupId:group.id} : {}) }; }), exports: result.exports.map(e => ({ ...e, current: e.fileExists && !e.superseded && exportReady && e.arrangement === result.arrangement && same(e.confirmation?.reviewItems, reviewItems) })) };
  };
  return api;
}
