export type Attachment = {id:string;sessionId:string;mime:string;bytes:number;width:number;height:number};
export type Session = {id:string;projectId:string|null;chapterId:string|null;title:string;state:string;revision:number;contentDeletion?:{revision:number;at:string}};
export type Limits = {assistant:number;analysis:number;audio:number};
export type AssistantConfig = {revision:number;enabled:boolean;baseUrl:string;model:string;credentialSource:'audio'|'separate';hasKey:boolean;configured:boolean;vision:boolean};
export type AssistantRun = {id:string;state:string;revision:number;objective:string;mode:string;planVersion:number;workflowKinds?:('dry'|'group'|'scene')[];stepLimit?:number;binding:{projectId:string|null;chapterId:string|null};budget:{limits:Limits;used:Limits};summary?:string;error?:string;questions?:string[];materials?:string[];voicePolicy?:string;allowedVoiceIds?:string[];voiceQuestions?:{roleId:string;roleName:string;segmentIds:string[];currentVoiceId?:string;availableVoiceIds:string[]}[];completionTarget?:string;delivery?:{masterId:string;chapterId:string;arrangement:number;review:'pending'};reconciliation?:{assistantRequest?:{id:string;state:string};steps:{stepId:string;description:string;attempts:{id:string;status:string}[];canRetry:boolean}[]};textMutationPolicy?:string};
export type UIAction = {type:'navigate'|'play';kind?:'voices'|'audios'|'masters'|'exports';id?:string;chapterId?:string;segmentId?:string;unitId?:string;target?:'voices'|'tasks'|'export'|'history'|'scene'|'assistant-settings'|'project-overview'|'segment';requiresUserClick?:boolean};
export type AssistantEffects = {voiceAssignments:{segmentId?:string;segmentText?:string;roleId:string;before:string|null;after:string|null;source?:string}[];readingRange?:{before:{text:string;spans:unknown[]};after:{text:string;spans:unknown[]}}};
export type AssistantStep = {id:string;runId:string;ordinal:number;capabilityId:string;description:string;state:string;input?:Record<string,unknown>;preview?:Record<string,unknown>&{effects?:AssistantEffects};error?:string;resultRefs?:{uiAction?:UIAction;audioId?:string;jobIds?:string[]}};
export type AssistantDetail = {session:Session;messages:{id:string;role:string;content:string;attachmentIds:string[]}[];runs:AssistantRun[];steps:AssistantStep[];attachments:Attachment[];capabilities:{id:string;description:string}[]};
export type AssistantDraft = {text:string;attachments:Attachment[];mode:'ask'|'task';workflowKinds?:('dry'|'group'|'scene')[];workflowCustomized?:boolean;stepLimit?:number;stepLimitCustomized?:boolean;completionTarget?:'requested-actions'|'chapter-master';completionCustomized?:boolean;limits:Limits;limitsCustomized?:(keyof Limits)[];voicePolicy:'askMissing'|'chooseFromApprovedSet';allowedVoiceIds:string[];materials:string[];materialsCustomized?:boolean;textMutationPolicy:'preserveExact'|'explicitSpecifiedEdit';pending?:Record<string,unknown>};
export const newAssistantDraft = ():AssistantDraft => ({text:'',attachments:[],mode:'task',workflowCustomized:false,stepLimit:40,stepLimitCustomized:false,completionTarget:'requested-actions',completionCustomized:false,limits:{assistant:12,analysis:3,audio:100},limitsCustomized:[],voicePolicy:'askMissing',allowedVoiceIds:[],materials:['text','reference'],materialsCustomized:false,textMutationPolicy:'preserveExact'});
export function assistantTaskOptions(draft:AssistantDraft) {
  const defaults={assistant:12,analysis:3,audio:100},keys=draft.limitsCustomized ?? (Object.keys(defaults) as (keyof Limits)[]).filter(key=>draft.limits[key]!==defaults[key]);
  return {
    ...(keys.length?{limits:Object.fromEntries(keys.map(key=>[key,draft.limits[key]]))}:{}),
    ...((draft.workflowCustomized ?? (!!draft.workflowKinds&&JSON.stringify(draft.workflowKinds)!==JSON.stringify(['dry'])))?{workflowKinds:draft.workflowKinds}:{}),
    ...((draft.materialsCustomized ?? JSON.stringify(draft.materials)!==JSON.stringify(['text']))?{materials:[...new Set([...draft.materials,...(draft.attachments.length?['image']:[])])]}:{}),
    ...((draft.stepLimitCustomized ?? (draft.stepLimit!==undefined&&draft.stepLimit!==40))?{stepLimit:draft.stepLimit}:{}),
    ...((draft.completionCustomized ?? (draft.completionTarget!==undefined&&draft.completionTarget!=='requested-actions'))?{completionTarget:draft.completionTarget}:{}),
  };
}
export const assistantTerminal = (state:string) => ['completed','cancelled','failed','rejected'].includes(state);
export const assistantState:Record<string,string> = {planning:'正在整理任务',awaitingApproval:'等你确认',executing:'执行中',waitingJobs:'等待声音结果',awaitingUser:'需要你补充',paused:'已暂停',completed:'已完成',needsReconciliation:'结果待核对',cancelled:'已停止',rejected:'未批准',proposed:'待确认',approved:'已批准',running:'执行中',success:'已完成',succeeded:'已完成',failed:'未完成',skipped:'已跳过',superseded:'已调整计划'};
export function checkAssistantFiles(files:File[],held:Attachment[]) {
  if (files.length+held.length>2) throw Error('每条消息最多附两张截图');
  if(files.some(f=>!['image/png','image/jpeg','image/webp'].includes(f.type))) throw Error('请使用 PNG、JPEG 或 WebP 静态截图');
  if(files.some(f=>!f.size||f.size>5*1024*1024)) throw Error('每张截图须在 5 MB 以内');
  if(files.reduce((n,f)=>n+f.size,held.reduce((n,a)=>n+a.bytes,0))>8*1024*1024) throw Error('截图合计不能超过 8 MB');
}
export const attachmentURL = (attachment:Pick<Attachment,'id'|'sessionId'>) => `/api/assistant/attachments/${encodeURIComponent(attachment.id)}?sessionId=${encodeURIComponent(attachment.sessionId)}`;
const labels:Record<string,string> = {text:'朗读正文',name:'名称',title:'标题',voiceId:'音色',roleId:'角色',performance:'表演要求',description:'声音要求',mode:'声音模式',guidance:'生成要求',template:'声音模板',backgroundPresence:'背景存在感',gap:'片段间隔',format:'导出格式',excluded:'排除片段',identityConfirmed:'身份确认',roleConfirmed:'角色确认',type:'内容类型',source:'原文',ids:'目标片段',members:'组成片段',id:'目标',unitId:'声音单元',chapterId:'章节',projectId:'项目',review:'检查状态',confirmed:'确认',analysisKind:'整理范围',data:'修改内容',config:'声音设置',enabled:'启用',dry:'纯人声',scene:'场景声音',current:'当前版本',previous:'旧版本',changes:'变更',blockers:'待处理问题',warnings:'提醒',actionable:'将处理',reused:'复用',unavailable:'不可用',cost:'请求用量',audioCalls:'声音请求',textCalls:'整理请求',arrangement:'编排',items:'内容',count:'数量',total:'合计',before:'原内容',after:'新内容',value:'新值',field:'项目',reason:'原因',impact:'影响'};
export const assistantLabel = (key:string) => labels[key] || key;
// Display every proposed input, including unfamiliar fields, so approval never hides a mutation.
export function assistantPreviewRows(value:unknown, resolve:(id:string)=>string, prefix=''): {label:string;value:string}[] {
  if(value===null||value===undefined)return [];
  if(Array.isArray(value))return value.flatMap((item,index)=>assistantPreviewRows(item,resolve,`${prefix}${value.length>1?` ${index+1}`:''}`));
  if(typeof value==='object')return Object.entries(value).flatMap(([key,item])=>assistantPreviewRows(item,resolve,[prefix,assistantLabel(key)].filter(Boolean).join(' · ')));
  return [{label:prefix||'内容',value:typeof value==='boolean'?(value?'是':'否'):resolve(String(value))}];
}
