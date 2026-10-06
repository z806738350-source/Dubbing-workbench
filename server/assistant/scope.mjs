import { fail, same } from '../store.mjs';

export function assertCreationScope(store,action,p,ctx={}) {
  if(!ctx.actorKind?.startsWith('assistant') && ctx.actorKind!=='human_approved_proposal')return;
  if(!['project.create','chapter.create'].includes(action))return;
  const run=ctx.runId&&store.maybe('assistantRuns',ctx.runId),scope=run?.creationScope;
  const source=scope&&store.maybe('assistantMessages',scope.sourceMessageId);
  if(!scope || !same(scope,ctx.creationScope) || source?.role!=='user'||source.runId!==run.id||source.sessionId!==run.sessionId||!same(source.binding,scope.binding))fail('本任务没有新建对象的具体范围；请说明要新建的项目或章节',403,{code:'creation-scope-required'});
  const kind=action.split('.')[0],slot=scope.slots.find(item=>item.kind===kind && (kind==='project'||item.parentProjectId===p.projectId));
  if(!slot || slot.name && slot.name!==(p.name||p.title))fail('新建对象超出用户指定范围，尚未创建',403,{code:'creation-scope-required'});
  if(kind==='chapter'&&p.source?.trim()){
    const existingSource=scope.binding.chapterId&&store.maybe('chapters',scope.binding.chapterId)?.source;
    if(!source.content.includes(p.source) && !(existingSource===p.source&&/(?:当前|本章|原文|这段|这些)/u.test(source.content.split('\n')[0])))fail('新章正文不在用户提供或指定的文字中，尚未创建',403);
  }
  const created=(scope.created||[]).filter(row=>row.kind===kind);
  if(created.some(row=>row.operationId===ctx.operationId))return;
  if(created.length>=slot.count)fail('本次指定数量已经创建，不能重复另建',403,{code:'creation-scope-required'});
}


// Only the human instruction portion can authorize a new sibling object. Text
// pasted after a labelled source is content, and model proposals never add slots.
export function creationScope(store,binding,messageId,content) {
  const instruction=content.split(/\n\s*(?:正文|文本|小说|原文)[：:]/u)[0].split('\n')[0].slice(0,2000);
  const clauses=instruction.split(/[。；;\n]/u).filter(c=>!/(?:不要|不能|禁止|不允许|不(?:要)?(?:再)?)[^，,]{0,20}(?:新建|创建|另建|新增)/u.test(c));
  const creationIntent=clauses.some(c=>!/(?:怎么|如何|怎样|解释|说明|用法)[^，,]{0,40}(?:新建|创建|导入|制作|配音|准备)/u.test(c)&&/(?:新建|创建|另建|新增|导入|制作|配(?:音|好|完)|准备(?:这些|本|这|小说|文本)|把[^。]{0,50}(?:文字|文本|小说)[^。]{0,30}(?:做好|安排|完成))/u.test(c));
  const slots=[];
  for(const kind of ['project','chapter']){
    const object=kind==='project'?'项目':'(?:章(?:节)?|章节)',clause=clauses.find(c=>!/(?:怎么|如何|怎样|解释|说明|用法)[^，,]{0,40}(?:新建|创建|另建|新增)/u.test(c)&&new RegExp('(?:新建|创建|另建|新增)[^，,]{0,45}'+object,'u').test(c));
    const newProjectChapter=kind==='chapter'&&slots.some(s=>s.kind==='project'&&s.followCreated)&&/(?:文本|文字|小说|原文|导入|配好)/u.test(instruction);
    const initial=creationIntent&&(kind==='project'?!binding.projectId:!binding.chapterId)||newProjectChapter;
    if(!initial&&!clause)continue;
    let parentProjectId=newProjectChapter?null:binding.projectId||null;
    if(kind==='chapter'&&clause){
      const named=store.all('projects').filter(p=>clause.includes(p.name) && /(?:在|给|为|到|项目)/u.test(clause));
      if(named.length===1)parentProjectId=named[0].id;
      if(named.length>1)continue;
    }
    const countMatch=clause?.match(/(?:新建|创建|另建|新增)\s*(\d+|[一二两三四五六七八九十])\s*(?:个)?(?:项目|章|章节)/u);
    const numerals={一:1,二:2,两:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9,十:10};
    const count=countMatch?(numerals[countMatch[1]]||Number(countMatch[1])):1;
    if(!Number.isSafeInteger(count)||count<1||count>20)continue;
    const nameMatch=clause?.match(new RegExp('(?:'+object+')[“「"]([^”」"]{1,150})[”」"]','u')) || clause?.match(new RegExp('名为\\s*[“「"]?([^”」"，,。\\s]{1,150}?)[”」"]?(?:的)?(?:'+object+')','u'));
    slots.push({kind,parentProjectId,count,...(nameMatch?{name:nameMatch[1]}:{}),followCreated:initial||!!clause&&!/(?:继续当前|保持当前|后台|不切换)/u.test(clause)});
  }
  return {sourceMessageId:messageId,binding:{...binding},slots,created:[]};
}

export function recordCreated(store,action,result,ctx) {
  if(!['project.create','chapter.create'].includes(action)||!ctx.runId)return;
  const run=store.get('assistantRuns',ctx.runId),oldBinding={...run.binding},scope=run.creationScope,kind=action.split('.')[0],id=result?.id;
  if(!scope||!id)return;
  if(!scope.created.some(row=>row.operationId===ctx.operationId))scope.created.push({kind,id,operationId:ctx.operationId});
  const slot=scope.slots.find(row=>row.kind===kind);
  if(kind==='project'&&(!run.binding.projectId||slot?.followCreated)){
    run.binding={projectId:id,chapterId:null};delete run.readingRange;
    for(const child of scope.slots.filter(row=>row.kind==='chapter'&&!row.parentProjectId))child.parentProjectId=id;
  }
  else if(kind==='chapter'&&slot?.followCreated){run.binding={projectId:store.get('chapters',id).projectId,chapterId:id};delete run.readingRange;}
  if(!same(oldBinding,run.binding))run.scopeBudgetStage=0;
  store.put('assistantRuns',run,run.sessionId);
  const session=store.get('assistantSessions',run.sessionId);
  if(!same({projectId:session.projectId,chapterId:session.chapterId},run.binding)){Object.assign(session,run.binding);session.revision++;store.put('assistantSessions',session,run.binding.projectId||'');}
}
