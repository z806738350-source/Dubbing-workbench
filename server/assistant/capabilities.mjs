import { fail, same } from '../store.mjs';
import { createActionExecutor } from '../actions.mjs';
import { saveCandidateVoice } from '../audio.mjs';
import { revealExport } from '../workspace.mjs';
import { getHelp, pick, scopedChapter } from './context.mjs';

const string = (maxLength = 100) => ({ type: 'string', minLength: 1, maxLength });
const text = (maxLength) => ({ type: 'string', maxLength });
const bool = { type: 'boolean' }, id = string(), ids = { type: 'array', items: id, minItems: 1, uniqueItems: true };
const values = (...items) => ({ enum: items });
const object = (properties = {}, required = []) => ({ type: 'object', additionalProperties: false, properties, required });
const array = (items, minItems = 0) => ({ type: 'array', items, minItems });
const number = (minimum, maximum, integer = false) => ({ type: integer ? 'integer' : 'number', minimum, maximum });
const mode = values('dry', 'scene'), position = values('before', 'during', 'after');
const configSchema = object({ speech_rate: number(-50, 100, true), loudness_rate: number(-50, 100, true), pitch_rate: number(-12, 12, true) }, ['speech_rate', 'loudness_rate', 'pitch_rate']);
const evidence = object({ kind: values('原文明示', '上下文推断', '创作建议', '用户创作选择'), quote: text(3000), quotes: array(string(3000), 1), reason: text(3000) }, ['kind']);
const eventFields = { kind: values('environment', 'effect', 'music'), description: string(1500), memberId: id, position, startMemberId: id, startPosition: position, endMemberId: id, endPosition: position, state: values('draft', 'adopted', 'removed'), evidence, transition: object({ memberId: id, quote: string(3000), occurrence: number(1, 10000, true), development: string(500), volumeChange: text(200) }, ['memberId', 'quote', 'occurrence', 'development']) };
const definitions = [];
function define(id, description, properties, required, options = {}) {
  definitions.push({ id, version: 1, description, inputSchema: object(properties, required), access: 'local-write', delegation: 'allowed-in-mandate', cost: 'local-only', helpRefs: [options.help || 'workflow'], ...options });
}
function action(name, description, properties, required = ['id'], options = {}) {
  const prefix = name.split('.')[0];
  define(name, description, properties, required, { action: name, target: { project: 'projects', role: 'roles', segment: 'segments', unit: 'units', event: 'events', voice: 'voices', 'voice-session': 'voiceSessions', 'voice-candidate': 'attempts', job: 'jobs' }[prefix], sourceFile: ['unit', 'event', 'voice-session', 'voice-candidate'].includes(prefix) ? 'server/enhancement.mjs' : 'server/domain.mjs', handler: 'domain.mutate', ...options });
}
const groupFields = { ids, guidance: text(2000) };
const generationFields = { ids, unitId: id, mode, actionKind: values('fillMissing', 'updateSelected', 'redoRejected', 'forceRegenerate') };
const analysisFields = { analysisKind: values('extract', 'director', 'scene'), ids, unitId: id, splitOnly: bool, autoApply: bool, source: text(1000000) };
action('project.create', '新建项目及旁白角色', { name: string(100) }, ['name'], { chapter: false, help: 'projects' });
action('project.rename', '重命名当前项目及其文件夹', { id, name: string(100) }, ['id', 'name'], { chapter: false, delegation:'explicit-proposal', help: 'projects' });
action('project.delete', '删除已单独确认范围的项目', { id }, ['id'], { chapter: false, access: 'destructive', delegation: 'explicit-proposal', help: 'delete' });
action('chapter.create', '从授权文字新建章节', { title: string(150), source: text(1000000), segment: bool }, ['title', 'source'], { chapter: false, help: 'import' });
action('chapter.update', '修改章节标题或片段间隔', { title: string(150), gap: number(0, 10) }, [], { help: 'export' });
action('chapter.move', '将当前章向前或向后移动一章', { direction: values(-1, 1) }, ['direction'], { help: 'projects' });
action('chapter.repair-structural-decisions', '修复已预览的可证明结构决定', { ids }, ['ids'], { delegation: 'explicit-proposal', help: 'structure' });
action('role.create', '添加本项目角色', { name: string(100) }, ['name'], { help: 'roles' });
action('role.update', '编辑角色名称、本章备注、别名或归档状态', { id, name: string(100), archived: bool, note: text(3000), quote: text(3000), gender: values('未知', '女', '男', '其他'), aliasSources: array(object({ name: string(100), chapterId: id, kind: values('原文明示', '上下文推断', '用户补充'), sourceQuote: text(3000), reason: text(3000), sourceVersion: number(1, Number.MAX_SAFE_INTEGER, true), needsReview: bool }, ['name', 'chapterId', 'kind', 'sourceVersion'])) }, ['id'], { help: 'roles' });
action('segment.create', '添加用户明确要求的新台词', { text: string(10000) }, ['text'], { help: 'editing' });
action('segment.update', '修改指定台词的表演、参数或明确授权正文', { id, text: text(10000), type: values('narration', 'dialogue', 'thought'), roleId: id, voiceId: id, resetVoice: bool, performance: text(2000), excluded: bool, config: configSchema }, ['id'], { help: 'editing' });
action('segment.rebind', '为所选台词指定本项目角色', { ids, roleId: id }, ['ids', 'roleId'], { help: 'roles' });
action('segment.confirm', '记录已确定的说话人与声音配置', { ids, roleOnly: bool }, ['ids'], { help: 'roles' });
action('segment.split', '按已预览的逐字边界拆分台词', { id, offset: number(1, 10000, true), parts: array(string(10000), 2), performance: array(text(2000), 2) }, ['id'], { help: 'structure' });
action('segment.merge', '合并相邻同角色台词', { id, choice: values('first', 'second'), performance: text(2000) }, ['id'], { help: 'structure' });
action('segment.template', '按差异预览切换单句模板', { id, template: id }, ['id', 'template'], { help: 'templates' });
action('segment.restore', '恢复单句上一版或通过版及其设置', { id, audioId: id, restoreSettings: bool }, ['id', 'audioId'], { help: 'history' });
for (const kind of ['segment', 'unit']) action(kind + '.review', '记录明确音频的人工听评或返工', { id, audioId: id, state: values('passed', 'rework'), ...(kind === 'unit' ? { mode } : {}) }, ['id', 'audioId', 'state'], { delegation: 'explicit-proposal', help: 'review' });
action('voice.update', '修改共享参考声音名称、状态或观察', { id, name: string(100), state: values('active', 'archived', 'stopped'), observations: object({ tone: text(1000), accent: text(1000), performance: text(1000), volume: text(1000) }) }, ['id'], { chapter: false, delegation:'explicit-proposal', help: 'voices' });
action('voice.delete', '删除单独确认的参考素材', { id }, ['id'], { chapter: false, access: 'destructive', delegation: 'explicit-proposal', help: 'voices' });
action('voice-session.create', '保存一份声音创建描述', { description: string(2000) }, ['description'], { chapter: false, help: 'voice-create' });
action('voice-session.update', '修改声音创建描述', { id, description: string(2000) }, ['id', 'description'], { chapter: false, help: 'voice-create' });
action('voice-session.abandon', '放弃描述并停止本会话后续请求', { id }, ['id'], { chapter: false, delegation: 'explicit-proposal', help: 'voice-create' });
action('voice-candidate.discard', '放弃已指定的声音候选', { id, sessionId: id }, ['id', 'sessionId'], { chapter: false, help: 'voice-create' });
action('unit.create', '将连续台词建立为共同演绎组', groupFields, ['ids'], {help: 'group' });
action('unit.update', '保存共同演绎或场景设置', { id, mode, guidance: text(2000), backgroundPresence: values('clear', 'natural', 'subtle', 'unspecified') }, ['id', 'mode'], { help: 'scene' });
action('unit.dissolve', '按照预览取消一起演绎', { id }, ['id'], { help: 'group' });
action('unit.switch', '选择已有匹配纯人声或场景版本', { id, mode }, ['id', 'mode'], { help: 'history' });
action('unit.template', '按差异预览切换组或场景模板', { id, mode, template: id }, ['id', 'mode', 'template'], { help: 'templates' });
action('unit.select-result', '采用设置匹配的历史声音', { id, mode, audioId: id }, ['id', 'mode', 'audioId'], { help: 'history' });
action('unit.restore', '恢复历史声音和对应设置', { id, mode, audioId: id, restoreSettings: bool }, ['id', 'mode', 'audioId'], { help: 'history' });
for (const name of ['create', 'update', 'remove', 'reconfirm']) action('event.' + name, { create: '添加场景声音事件', update: '编辑或采用声音事件', remove: '移除声音事件', reconfirm: '重新核对声音事件位置' }[name], { unitId: id, ...(name === 'create' ? {} : { id }), ...(['create', 'update'].includes(name) ? eventFields : {}) }, ['unitId', ...(name === 'create' ? ['kind', 'description'] : ['id'])], { help: 'scene' });
action('job.stop', '只停止指定任务的后续请求', { id }, ['id'], { chapter: false,delegation:'explicit-proposal', help: 'tasks' });
for (const [name, description, fields, required, options] of [
  ['prepareChapter', '让AI准备当前章或所选台词', analysisFields, [], { cost: 'analysis-plan.textRequests', help: 'analysis' }],
  ['useVoice', '把声音应用到本章角色或单句，或保存候选到库', { scope: values('library'), voiceId: id, audioId: id, name: string(100), roleId: id, segmentId: id, apply: bool, updateDefault: bool }, [], { cost: 'local-only', help: 'voices' }],
  ['groupAndGenerate', '建立一起演绎组并生成', groupFields, ['ids'], { cost: 'one-audio-request', help: 'group' }],
  ['sceneAndGenerate', '采用所选事件并生成场景版', { unitId: id, eventIds: array(id) }, ['unitId', 'eventIds'], { cost: 'one-audio-request', help: 'scene' }],
  ['generateSelection', '生成缺失、更新所选或重做返工', generationFields, ['ids'], { cost: 'generation-plan.audioRequests', help: 'generation' }],
  ['voiceCandidate', '生成一个描述声音候选', { sessionId: id }, ['sessionId'], { chapter: false, cost: 'one-audio-request', help: 'voice-create' }],
  ['export', '导出已经人工检查通过的当前成品', { format: values('wav', 'mp3') }, ['format'], { cost: 'local-only', help: 'export' }],
]) define('operation.' + name, description, fields, required, { operation: name, handler: 'experience.run', sourceFile: 'server/experience.mjs', access: options.cost === 'local-only' ? 'local-write' : 'paid', ...options });
define('generation.plan', '免费核对所选生成范围及请求数', generationFields, ['ids'], { access: 'read', handler: 'experience.plan', help: 'generation' });
define('analysis.plan', '免费核对分析范围及文本请求数', analysisFields, [], { access: 'read', handler: 'analysis.plan', help: 'analysis' });
define('analysis.resume', '继续明确未完成的分析批次', { id, batchIds: ids, replace: bool }, ['id'], { target: 'suggestions', handler: 'analysis.resume', access: 'paid', cost: 'selected-analysis-batches', help: 'tasks' });
define('analysis.edit', '校对已有分析中的一条标注', { id, batchId: id, itemId: id, remove: bool, item: object({ from: number(0, 1000000, true), to: number(0, 1000000, true), segmentId: id, roleId: id, newRoleKey: id, newRole: string(100), type: values('narration', 'dialogue', 'thought'), performance: text(2000), evidence: values('原文明示', '上下文推断', '创作建议', '用户补充'), evidenceRefs: array(number(0, 1000000, true)), reason: text(3000), uncertain: bool, unitId: id, ...Object.fromEntries(Object.entries(eventFields).filter(([key]) => !['evidence', 'state', 'transition'].includes(key))) }) }, ['id', 'batchId'], { target: 'suggestions', handler: 'analysis.edit', delegation: 'explicit-proposal', help: 'analysis' });
define('analysis.apply', '采用当前有效建议或AI语义拆分', { id, selected: ids, replaceConfirmed: bool, inheritPerformanceConfirmed: bool }, ['id'], { target: 'suggestions', handler: 'analysis.apply', help: 'analysis' });
for (const name of ['previewReuse', 'reuse']) define('analysis.' + name, name === 'reuse' ? '把历史场景建议加入当前场景' : '免费预检历史场景建议', { id, unitId: id, ...(name === 'reuse' ? { selected: ids } : {}) }, ['id', 'unitId', ...(name === 'reuse' ? ['selected'] : [])], { target: 'suggestions', handler: 'analysis.' + name, access: name === 'reuse' ? 'local-write' : 'read', help: 'suggestions' });
define('experience.undo', '撤销尚未被后续修改的AI安排', { changeId: id }, ['changeId'], { handler: 'experience.undo', help: 'drafts' });
define('experience.unprotect', '允许AI下一次安排此句表演', { segmentId: id }, ['segmentId'], { handler: 'experience.unprotect', delegation: 'explicit-proposal', help: 'drafts' });
define('experience.revoke', '撤回指定任务授权，停止尚未外发的请求', { grantId: id }, ['grantId'], { chapter: false,delegation:'explicit-proposal', handler: 'experience.revoke', help: 'authorization' });
define('job.master', '免费准备整章试听母版', {}, [], { handler: 'worker.submit', help: 'playback' });
define('job.voice-test', '用已有参考朗读指定测试文字', { voiceId: id, text: string(300) }, ['voiceId', 'text'], { handler: 'worker.submit', chapter: false, access: 'paid', cost: 'one-audio-request', help: 'voices' });
define('voice.save-candidate', '免费把合格候选保存到音色库', { audioId: id, name: string(100) }, ['audioId', 'name'], { chapter: false, handler: 'saveCandidateVoice', help: 'voice-create' });
define('export.reveal', '在本机访达中定位已保存成品', { id }, ['id'], { target: 'exports', handler: 'revealExport', access: 'ui-only', help: 'export' });
define('audio.tail.repair','免费预览并清理所选纯人声的尾部异常，保留原件',{unitIds:ids},['unitIds'],{handler:'repairAudio',delegation:'explicit-proposal',help:'original-audio'});
define('audio.original.restore', '免费恢复所选处理版对应的真实供应商原件', { id, mode, audioId: id, restoreSettings: bool }, ['id', 'mode', 'audioId'], { target: 'units', handler: 'unit.select-result / unit.restore', help: 'original-audio' });
define('ui.navigate', '提供已注册功能入口的定位按钮', { target: values('voices','tasks','export','history','scene','assistant-settings','project-overview','segment'), segmentId: id, unitId: id }, ['target'], { chapter: false, access: 'ui-only', handler: 'UI action requiring user click', help: 'workflow' });
define('ui.play', '提供当前任务授权音频的试听按钮', { kind: values('voices','audios','masters','exports'), id }, ['kind','id'], { chapter: false, access: 'ui-only', handler: 'playIntent via UI action requiring user click', help: 'playback' });
for (const [name, target, description] of [['chapter', null, '读取当前任务章节和实际声音状态'], ['segment', 'segments', '读取一条完整台词与表演'], ['voice', 'voices', '读取一个参考声音'], ['audio', 'audios', '读取一个音频的来源与听评'], ['attempts', 'jobs', '读取指定任务的请求记录'], ['operation', null, '读取原持久操作回执'], ['project-deletion-plan', 'projects', '预览指定项目删除范围']]) define('read.' + name, description, target || name === 'operation' ? { id } : {}, target || name === 'operation' ? ['id'] : [], { target, handler: 'bounded projection', access: 'read', chapter: name === 'chapter' || name === 'segment', help: name === 'attempts' || name === 'operation' ? 'tasks' : 'workflow' });
define('read.state', '读取绑定项目的章节、角色、声音和任务摘要', {}, [], { chapter: false, access: 'read', handler: 'bounded snapshot', help: 'workflow' });
define('help.search', '查询当前工具用法与准确入口', { capabilityId: id, pageId: id, errorCode: id, query: text(1000) }, [], { chapter: false, access: 'read', handler: 'getHelp', help: 'workflow' });
for (const [name, description, help] of [
  ['settings.update', '人工修改分析模型、默认间隔与增强功能开关', 'settings'],
  ['settings.assistant', '人工独立配置助手模型、接口和凭据；可选多模态模型', 'assistant-settings'],
  ['experience.grant', '用户批准外发素材、用途、路由和请求上限', 'authorization'],
  ['experience.policy', '用户选择AI先安排或先看建议', 'authorization'],
  ['workspace.choose', '本机用户通过文件夹选择器指定工作区', 'workspace'],
  ['workspace.move', '本机用户独立确认完整工作区迁移', 'workspace'],
  ['voice.upload', '用户上传授权参考录音后才能使用，不接受任意磁盘路径', 'voices'],
  ['application.maintenance', '安装、更新、整库备份和Git发布只提供本机操作说明', 'settings'],
]) define(name, description, {}, [], { chapter: false, delegation: 'human-only', access: 'ui-only', handler: null, help });

export const capabilityWorkflow=(id,input={})=>['unit.create','unit.dissolve','operation.groupAndGenerate'].includes(id)?'group':id.startsWith('event.')||id==='operation.sceneAndGenerate'||input.mode==='scene'||input.analysisKind==='scene'?'scene':null;

export const capabilityDefinitions = definitions.map(item => Object.freeze(item));

export function validateCapabilityInput(schema, value, path = '参数') {
  if (schema.enum) { if (!schema.enum.includes(value)) fail(path + '不在允许范围'); return; }
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(path + '应为对象');
    const properties = schema.properties || {};
    if (schema.additionalProperties === false && Object.keys(value).some(key => !Object.hasOwn(properties, key))) fail(path + '含未注册字段');
    for (const key of schema.required || []) if (!Object.hasOwn(value, key)) fail(path + '缺少' + key);
    for (const [key, child] of Object.entries(value)) if (properties[key]) validateCapabilityInput(properties[key], child, path + '.' + key);
  } else if (schema.type === 'array') {
    if (!Array.isArray(value) || value.length < (schema.minItems || 0) || value.length > (schema.maxItems ?? 10000)) fail(path + '列表无效');
    if (schema.uniqueItems && new Set(value).size !== value.length) fail(path + '不允许重复项');
    value.forEach((child, index) => validateCapabilityInput(schema.items, child, path + '[' + index + ']'));
  } else if (schema.type === 'string') {
    if (typeof value !== 'string' || Array.from(value).length < (schema.minLength || 0) || Array.from(value).length > schema.maxLength) fail(path + '文字长度无效');
  } else if (schema.type === 'boolean') {
    if (typeof value !== 'boolean') fail(path + '应为明确开关');
  } else if (typeof value !== 'number' || !Number.isFinite(value) || schema.type === 'integer' && !Number.isSafeInteger(value) || value < schema.minimum || value > schema.maximum) fail(path + '数值无效');
}

export function createCapabilities({ store, domain, worker, analysis, experience, config = {}, executeAction,repairAudio }) {
  const act = executeAction || createActionExecutor({ store, domain, experience });
  const definition = id => { const found = definitions.find(item => item.id === id); if (!found) fail('未注册的助手能力', 400); return found; };
  function prepare(id, input, scope) {
    const def = definition(id);
    validateCapabilityInput(def.inputSchema, input);
    if (!scope?.projectId && !['project.create', 'help.search', 'read.state'].includes(id)) fail('本次任务尚未绑定项目', 403);
    const bound = scope?.projectId ? scopedChapter(store, scope) : {};
    if (def.chapter !== false && !bound.chapter) fail('本次能力需要明确绑定章节', 400);
    const versions = {}, dependencies = {};
    const own = (table, targetId) => {
      const row = store.get(table, targetId);
      let projectId = row.projectId, chapterId = row.chapterId;
      if (table === 'projects') projectId = row.id;
      if (table === 'events') chapterId = store.get('units', row.unitId).chapterId;
      if (table === 'attempts' || table === 'audios' && !chapterId) {
        const attempt = table === 'attempts' ? row : store.maybe('attempts', row.id);
        const job = attempt && store.maybe('jobs', attempt.jobId);
        chapterId = job?.chapterId; projectId = job?.request?.projectId;
      }
      if (table === 'jobs') projectId ||= row.request?.projectId;
      if (chapterId) projectId = store.get('chapters', chapterId).projectId;
      if (projectId && projectId !== scope.projectId || chapterId && scope.chapterId && chapterId !== scope.chapterId) fail('对象超出本次任务范围', 403);
      if (['jobs', 'attempts', 'audios'].includes(table) && !projectId) fail('对象缺少可验证的任务归属', 403);
      versions[table + '/' + row.id] = pick(row, ['revision', 'arrangement', 'contextRevision', 'draftVersion', 'sourceVersion', 'state', 'status', 'current', 'mode', 'stop']);
      // A chapter revision changes for edits to unrelated lines. Compare the
      // actual objects read by this step; execution still uses fresh revisions.
      const fields = table === 'chapters' ? (id === 'chapter.update' ? Object.keys(input) : ['sourceVersion']) :
        table === 'projects' ? (id.startsWith('project.') ? ['name','revision'] : []) :
        table === 'segments' ? ['text','type','roleId','voiceId','voiceSource','performance','config','template','excluded','protectedFields','roleConfirmed','identityConfirmed',...(/review|restore|select-result|job.master|operation.export/.test(id)?['current','review']:[])] :
        table === 'units' ? ['members','kind','mode','state','variants'] :
        ['revision','contextRevision','draftVersion','sourceVersion','state','status','current','mode','stop'];
      dependencies[table + '/' + row.id] = pick(row, fields);
      return row;
    };
    if (bound.project) own('projects', bound.project.id);
    if (bound.chapter) own('chapters', bound.chapter.id);
    const target = def.target && input.id ? own(def.target, input.id) : null;
    if (id === 'ui.play') own(input.kind,input.id);
    for (const [field, table] of [['roleId', 'roles'], ['segmentId', 'segments'], ['unitId', 'units'], ['voiceId', 'voices'], ['audioId', 'audios'], ['sessionId', 'voiceSessions']]) if (input[field]) own(table, input[field]);
    for (const unitId of input.unitIds || []) own('units',unitId);
    for (const segmentId of input.ids || []) own('segments', segmentId);
    if (id==='operation.useVoice' && input.roleId && bound.chapter) for(const s of domain.list(bound.chapter.id).filter(s=>s.roleId===input.roleId))own('segments',s.id);
    for (const eventId of input.eventIds || []) { const event = own('events', eventId); if (event.unitId !== input.unitId) fail('事件不属于指定声音单元', 403); }
    const unit = input.unitId ? own('units', input.unitId) : def.target === 'units' ? target : null;
    if (unit) for (const memberId of unit.members || []) own('segments',memberId);
    if (bound.chapter && ['analysis.apply','operation.prepareChapter','job.master','operation.export'].includes(id)) {
      dependencies['arrangement/' + bound.chapter.id] = {gap:bound.chapter.gap, members:domain.list(bound.chapter.id).map(s=>s.id)};
      for (const member of domain.list(bound.chapter.id)) own('segments',member.id);
      for (const row of store.all('units',bound.chapter.id).filter(u=>u.state==='active')) own('units',row.id);
    }
    const p = { ...input, ...(bound.project ? { projectId: bound.project.id } : {}), ...(bound.chapter ? { chapterId: bound.chapter.id, revision: bound.chapter.revision } : {}) };
    if (target && ['projects', 'roles', 'voices', 'voiceSessions', 'units'].includes(def.target)) p.entityRevision = target.revision ?? 1;
    if (unit) { p.entityRevision = unit.revision; p.unitRevision = unit.revision; }
    if (def.target === 'events') p.eventRevision = target.revision;
    if (target && def.target === 'suggestions') { p.draftVersion = target.draftVersion; p.contextRevision = bound.project.contextRevision; }
    if (input.sessionId) p.entityRevision = store.get('voiceSessions', input.sessionId).revision;
    if (id === 'audio.original.restore') {
      const processed = store.get('audios',input.audioId);
      if (processed.originalAvailability !== 'retained' || !processed.originalAudioId) fail('这份历史声音没有保留可验证的供应商原件');
      own('audios',processed.originalAudioId);
      if (!domain.enhancement.history(target,input.mode).some(a=>a.id===processed.originalAudioId)) fail('原件不属于本次声音单元',403);
      p.audioId = processed.originalAudioId;
    }
    if (id === 'ui.navigate' && ['export','history','scene','segment'].includes(input.target) && !bound.chapter) fail('此入口需要当前任务章节');
    if (id === 'operation.useVoice' && input.roleId) p.entityRevision = store.get('roles', input.roleId).revision ?? 1;
    if (id === 'experience.undo') { const change = store.get('settings', 'ux-change:' + input.changeId); if (change.chapterId !== scope.chapterId || change.projectId !== scope.projectId) fail('修改记录不属于本次任务范围', 403); }
    if (id === 'experience.revoke') { const grant = store.get('settings', 'ux-grant:' + input.grantId); if (grant.projectId !== scope.projectId || scope.chapterId && grant.chapterId !== scope.chapterId) fail('授权不属于本次任务范围', 403); versions['grant/' + grant.grantId] = pick(grant, ['revision', 'revoked']); }
    const requiredWorkflows=[...new Set([capabilityWorkflow(id,input), unit?.kind==='group'?'group':null, unit && (input.mode||unit.mode)==='scene'?'scene':null].filter(Boolean))];
    if (id==='operation.generateSelection' && bound.chapter) for(const u of store.all('units',bound.chapter.id).filter(u=>u.state==='active'&&u.members.some(id=>input.ids.includes(id)))) {if(u.kind==='group'&&!requiredWorkflows.includes('group'))requiredWorkflows.push('group');if((input.mode||u.mode)==='scene'&&!requiredWorkflows.includes('scene'))requiredWorkflows.push('scene');}
    return { def, bound, target, unit, p, versions, dependencies, requiredWorkflows };
  }

  async function read(id, input = {}, scope = {}) {
    const { def, bound, target, p } = prepare(id, input, scope);
    if (def.access !== 'read') fail('该能力不是读取操作');
    if (id === 'help.search') return getHelp(input);
    if (id === 'generation.plan') return experience.plan({ ...p, kind: 'generateSelection' });
    if (id === 'analysis.plan') return analysis.plan({ ...p, kind: input.analysisKind });
    if (id === 'analysis.previewReuse') return analysis.previewReuse(p);
    if (id === 'read.project-deletion-plan') { const result = domain.deletionPlan({ id: input.id }); return pick(result, ['projectId', 'name', 'counts', 'sharedVoiceIds', 'blockers']); }
    if (id === 'read.operation') {
      const operation = experience.get(input.id), request = store.get('settings', 'ux-operation:' + input.id).request || {};
      const projectId = request.projectId || request.data?.projectId || (request.chapterId || request.data?.chapterId) && store.get('chapters', request.chapterId || request.data.chapterId).projectId;
      if (projectId !== scope.projectId || scope.chapterId && (request.chapterId || request.data?.chapterId) !== scope.chapterId) fail('操作不属于本次任务范围', 403);
      return pick(operation, ['operationId', 'kind', 'outcome', 'jobIds', 'createdObjectIds', 'errorStatus']);
    }
    if (id === 'read.segment') return pick(target, ['id', 'chapterId', 'order', 'text', 'type', 'roleId', 'voiceId', 'performance', 'config', 'template', 'excluded', 'protectedFields', 'decisions', 'current', 'review']);
    if (id === 'read.voice') return pick(target, ['id', 'name', 'state', 'duration', 'revision', 'observations', 'inspection', 'sampleAudioId', 'sourceAudioId']);
    if (id === 'read.audio') return pick(target, ['id', 'chapterId', 'targetKind', 'targetId', 'duration', 'createdAt', 'review', 'processingVersion', 'sourceAudioId']);
    if (id === 'read.attempts') return store.all('attempts', target.id).map(a => pick(a, ['id', 'jobId', 'status', 'targetKind', 'targetId', 'unitId', 'mode', 'adopted', 'phase', 'createdAt']));
    if (id === 'read.chapter') {
      const c = domain.chapter(bound.chapter.id);
      return { ...pick(c, ['id', 'title', 'revision', 'arrangement', 'gap', 'coverage', 'arrangementIssues']), segments: c.segments.map(s => pick(s, ['id', 'order', 'text', 'type', 'roleId', 'voiceId', 'performance', 'excluded', 'configurationDecided', 'protectedFields'])), units: c.units.map(u => ({ ...pick(u, ['id', 'members', 'kind', 'mode', 'state', 'revision', 'readiness']), variants: Object.fromEntries(Object.entries(u.variants).map(([mode, variant]) => [mode, pick(variant, ['current', 'previous', 'approved', 'review', 'guidance', 'template', 'backgroundPresence'])])) })), visibility: 'full' };
    }
    if (id === 'read.state') return { projects: store.all('projects').filter(row => !scope.projectId || row.id === scope.projectId).map(row => pick(row, ['id', 'name', 'revision'])), chapters: bound.project ? store.all('chapters', bound.project.id).map(row => pick(row, ['id', 'title', 'order', 'revision', 'arrangement'])) : [], roles: bound.project ? store.all('roles', bound.project.id).map(row => pick(row, ['id', 'name', 'voiceId', 'narrator'])) : [], voices: store.all('voices').map(row => pick(row, ['id', 'name', 'state', 'duration', 'revision'])), features: domain.enhancement.features() };
    fail('尚未实现此读取适配');
  }

  async function preview(id, input = {}, scope = {}) {
    const { def, bound, target, unit, p, versions, dependencies, requiredWorkflows } = prepare(id, input, scope);
    if (def.delegation === 'human-only') return { capabilityId: id, delegation: def.delegation, description: def.description, helpRefs: def.helpRefs };
    let detail;
    if(id==='segment.update'||id==='role.update'||id==='chapter.update'){const before=target||bound.chapter;detail={id:before.id,changes:Object.entries(input).filter(([key])=>key!=='id').map(([field,after])=>({field,before:before[field]??null,after}))};}
    else if (id==='audio.tail.repair') {if(!repairAudio)fail('尾部维护接口尚未就绪');detail=await repairAudio({phase:'preview',projectId:scope.projectId,chapterId:scope.chapterId,unitIds:input.unitIds});}
    else if (id === 'operation.generateSelection') detail = experience.plan({ ...p, kind: 'generateSelection' });
    else if (id === 'operation.prepareChapter') detail = analysis.plan({ ...p, kind: p.analysisKind });
    else if (['unit.create', 'operation.groupAndGenerate'].includes(id)) detail = domain.enhancement.preview({ ...p, kind: 'group' });
    else if (['unit.restore', 'unit.dissolve', 'unit.template'].includes(id)) detail = domain.enhancement.preview({ ...p, kind: id.split('.')[1] === 'dissolve' ? 'dissolve' : id.split('.')[1] === 'template' ? 'template' : 'restore' });
    else if (id === 'segment.template') detail = domain.previewTemplate(p);
    else if (id === 'project.delete') detail = domain.deletionPlan({ id: input.id });
    else if (id === 'chapter.repair-structural-decisions') detail = domain.structuralRepairPlan(p);
    else if (id === 'operation.export') { const c = domain.chapter(bound.chapter.id); detail = { arrangement: c.arrangement, reviewItems: c.reviewItems, blockers: c.units.filter(u => u.state === 'active').flatMap(u => u.readiness?.export?.blockers || []) }; }
    else if (id === 'analysis.reuse') detail = analysis.previewReuse(p);
    else if (id === 'operation.useVoice' && bound.chapter) detail={roleId:input.roleId,updateDefault:input.updateDefault===true,affectedSegments:domain.list(bound.chapter.id).filter(s=>input.segmentId?s.id===input.segmentId:s.roleId===input.roleId).map(s=>({id:s.id,text:s.text,oldVoiceId:s.voiceId,newVoiceId:input.voiceId}))};
    else if(id==='operation.sceneAndGenerate')detail={unitId:unit.id,members:unit.members,guidance:unit.variants.scene.guidance,backgroundPresence:unit.variants.scene.backgroundPresence,events:store.all('events',unit.id).filter(e=>e.state==='adopted'||input.eventIds.includes(e.id)).map(e=>pick(e,['id','kind','description','state','memberId','position','startMemberId','endMemberId','source']))};
    else if (id === 'voice.delete') detail = domain.voiceUsage(input.id);
    else if (id === 'audio.original.restore') detail = domain.enhancement.preview({...p,kind:'restore'});
    return { capabilityId: id, input, baseRevisions: versions, dependencies, requiredWorkflows, cost: def.cost, delegation: id==='operation.useVoice'&&input.updateDefault===true || id.startsWith('voice-session.')&&target&&!target.projectId ? 'explicit-proposal' : def.delegation, preview: detail || null, ...(unit ? { unitId: unit.id } : {}) };
  }

  async function execute(id, input = {}, scope = {}, executionContext = {}) {
    const { def, bound, target, p, versions, requiredWorkflows } = prepare(id, input, scope);
    if (def.access === 'read') return read(id, input, scope);
    if (def.delegation === 'human-only') fail('此项必须由用户通过安全界面操作', 403);
    if (!['human_approved_proposal', 'assistant_delegated'].includes(executionContext.actorKind) || !executionContext.operationId) fail('缺少可信助手执行上下文', 403);
    const receipt = store.maybe('settings','assistant-operation:' + executionContext.operationId);
    if (receipt) {
      if (receipt.capabilityId !== id || !same(receipt.capabilityInput,input)) fail('同一助手步骤的业务参数不同',409);
      return receipt.result;
    }
    if (id!=='audio.tail.repair' && !same(executionContext.baseRevisions, versions)) fail('目标在计划后已变化，请重读并重新核对', 409);
    if ((def.delegation === 'explicit-proposal' || id==='operation.useVoice'&&input.updateDefault===true || id.startsWith('voice-session.')&&target&&!target.projectId) && executionContext.actorKind !== 'human_approved_proposal') fail('此项需要对具体范围作出明确决定', 403);
    const payload = { ...p, operationId: executionContext.operationId, commandId: executionContext.operationId };
    for (const field of ['grantId', 'retryUnknown', 'acknowledgedAttemptIds', 'resumeRoute']) if (executionContext[field] !== undefined) payload[field] = executionContext[field];
    if(executionContext.actorKind==='assistant_delegated' && requiredWorkflows.some(kind=>!executionContext.workflowKinds?.includes(kind)))fail('这项对戏或场景操作超出已批准的制作范围',403);
    if (def.access === 'paid') { if (!payload.grantId) fail('本次模型调用尚未获准', 403); payload.requireGrant = true; }
    if (id.endsWith('.review')) {
      const c = domain.chapter(bound.chapter.id), u = c.units.find(u => u.id === input.id);
      if (!u) fail('试听单元已变化', 409);
      if (input.state === 'passed' && !executionContext.humanReview?.audioIds?.includes(input.audioId)) fail('人工听评需要用户对这份声音作出决定', 403);
      payload.basis = u.variants[input.mode || u.mode].status.basis;
    }
    if (id === 'project.delete') {
      const plan=domain.deletionPlan({id:input.id});
      const comparable=scope=>{const copy=structuredClone(scope);if(copy?.assistant)for(const session of copy.assistant)for(const run of session.runs||[])if(run.id===executionContext.runId){delete run.state;delete run.revision;}return copy;};
      if(!same(comparable(executionContext.preview?.scope),comparable(plan.scope)))fail('删除范围已变化，请重新预览',409);
      payload.scope=plan.scope;
    }
    if (id === 'chapter.repair-structural-decisions') { const plan = domain.structuralRepairPlan(payload); if (!same(executionContext.preview?.scope, plan.scope)) fail('修复范围已变化，请重新预览', 409); payload.scope = plan.scope; }
    if (id === 'voice.delete' || id.endsWith('.template')) payload.confirm = true;
    if (id === 'unit.restore') payload.baseRevisions = executionContext.preview?.baseRevisions;
    if (id === 'unit.dissolve') payload.arrangement = bound.chapter.arrangement;
    executionContext = {...executionContext,capabilityId:id,capabilityInput:input};
    if(id==='audio.tail.repair'){if(!repairAudio)fail('尾部维护接口尚未就绪');return repairAudio({phase:'apply',projectId:scope.projectId,chapterId:scope.chapterId,scope:executionContext.maintenanceScope||executionContext.preview?.scope});}
    if (id === 'ui.navigate') return {uiAction:{type:'navigate',...input,...(scope.chapterId ? {chapterId:scope.chapterId} : {}),requiresUserClick:true}};
    if (id === 'ui.play') return {uiAction:{type:'play',kind:input.kind,id:input.id,requiresUserClick:true}};
    if (id === 'audio.original.restore') {
      const original = domain.enhancement.history(target,input.mode).find(a=>a.id===payload.audioId);
      return act(original?.matched ? 'unit.select-result' : 'unit.restore',{...payload,baseRevisions:executionContext.preview?.baseRevisions},executionContext);
    }
    if (def.action) return act(def.action, payload, executionContext);
    if (def.operation) {
      payload.kind = def.operation;
      if (def.operation === 'prepareChapter' && input.analysisKind === 'scene') payload.sceneEnabled = true;
      if (def.operation === 'generateSelection') payload.arrangement = bound.chapter.arrangement;
      if (def.operation === 'export') { const c = domain.chapter(bound.chapter.id); payload.arrangement = c.arrangement; payload.reviewItems = c.reviewItems; payload.confirm = false; }
      return experience.run(payload, executionContext);
    }
    if (id === 'analysis.resume') return analysis.resume(payload, executionContext);
    if (id === 'analysis.edit') return analysis.edit(payload, executionContext);
    if (id === 'analysis.apply') return analysis.apply(payload, executionContext.actorKind === 'assistant_delegated', executionContext);
    if (id === 'analysis.reuse') return analysis.reuse(payload, executionContext);
    if (id === 'experience.undo') return experience.undo(payload);
    if (id === 'experience.unprotect') return experience.unprotect({ ...payload, field: 'performance' });
    if (id === 'experience.revoke') return experience.revoke(payload);
    if (id === 'job.master') return worker.submit({ ...payload, kind: 'master' });
    if (id === 'job.voice-test') { payload.entityRevision = store.get('voices', input.voiceId).revision ?? 1; return worker.submit({ ...payload, kind: 'voice-test' }); }
    if (id === 'voice.save-candidate') return saveCandidateVoice(store, payload);
    if (id === 'export.reveal') { await revealExport(store, target.id); return { exportId: target.id, revealed: true }; }
    fail('此能力尚未接入受控执行器');
  }
  return { list: () => definitions.map(({ action, operation, target, chapter, ...item }) => item), read, preview, execute, dependencies:(id,input,scope)=>prepare(id,input,scope).dependencies, current:(id,input,scope)=>{const p=prepare(id,input,scope);return {baseRevisions:p.versions,dependencies:p.dependencies};} };
}
