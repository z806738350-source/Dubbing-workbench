import { same } from './store.mjs';

export const performanceContract = Object.freeze({maxLength:2000,batchTargets:24,batchUtf16:12000,requestUtf16:65000,maxRepairRounds:1});
export const hasReadableText = value => typeof value === 'string' && !!value.replace(/[\s\p{Cf}\p{Variation_Selector}]/gu,'');
export const eligiblePerformanceSegment = s => !s.retired && !s.deletion && !s.excluded && hasReadableText(s.text);
export const humanPerformance = s => s.protectedFields?.includes('performance') || !!s.performance && !['policy_ai','structural_ai'].includes(s.decisions?.performance?.source) && !s.aiAllowedFields?.includes('performance');

export function inspectPerformance(value, text, meta = {}) {
  meta=meta && typeof meta==='object' ? meta : {};
  const issues = [];
  if (typeof value !== 'string' || value.length > performanceContract.maxLength) return ['表演指导须为不超过2000个UTF-16代码单元的文本'];
  if (!hasReadableText(value) || /^(?:待补充|待填写|待分析|同上|略|暂无|无|未知|待定|TODO|N\/A|…|\.{3})[。.!！\s]*$/iu.test(value.trim())) issues.push('表演指导缺失或仅有占位内容');
  const directives=value.replace(/(?:从|重音(?:落)?在|强调|在)[“「『"']([^”」』"']+)[”」』"']/gu,(quote,words)=>text.includes(words)?' '.repeat(quote.length):quote);
  // ponytail: deterministic directive/negation phrases; ambiguous prose remains non-blocking, add a parser only for demonstrated misses.
  const operations=/(?:添加|加入|插入|补上|发出|增加|伴随)[^，,。；;！？!?]{0,10}?(?:笑声|喘息声?|惊呼|台词|脚步声|衣物声|音效|背景音乐)|(?:播放|添加|加入|关闭|去掉|取消|压低|降低)[^，,。；;！？!?]{0,8}?(?:背景|音乐|音效)|(?:无|不要|禁止)\s*(?:背景音乐|环境声|背景声)|(?:改写|删掉|删除|省略|替换|增加)[^，,。；;！？!?]{0,8}?(?:正文|台词|词句)|(?:换成|改用|切换)[^，,。；;！？!?]{0,8}?(?:音色|声音|角色)|(?:陌生|新|改用).{0,3}口音|(?:停顿?|停留|暂停|持续|时长|延长|压缩|控制在)[^，,。；;！？!?]{0,6}\d+(?:\.\d+)?\s*(?:毫秒|秒钟?)|\d+(?:\.\d+)?\s*(?:毫秒|秒钟?)(?:内|之内|以内)(?:读完|说完|结束|完成)/gu;
  for(const match of directives.matchAll(operations))if(!/(?:不要|别|无需|禁止|不应|不准|不能|避免|勿|不允许)(?:\s*(?:再|额外|主动|自行|继续|擅自|直接|自动))*\s*$/u.test(directives.slice(0,match.index))){issues.push('表演指导包含额外发声、正文、声音身份、背景或时长操作');break;}
  const anchors = meta.performanceAnchors ?? [];
  if (!Array.isArray(anchors) || anchors.some(a => typeof a !== 'string' || !a || !text.includes(a))) issues.push('表演锚点不属于当前片段');
  for (const match of value.matchAll(/(?:从|重音(?:落)?在|强调|在)[“「『"']([^”」』"']+)[”」』"']/gu)) if (!text.includes(match[1])) issues.push('表演引用的词句不在当前片段');
  return [...new Set(issues)];
}

export const performanceDependency = s => ({text:s.text,roleId:s.roleId,type:s.type,source:s.source});
export function performanceRoleFacts(store,chapter,roleId) {
  return (store.maybe('roles',roleId)?.facts || []).filter(f=>(!f.chapterId || (store.maybe('chapters',f.chapterId)?.order ?? Infinity)<=chapter.order) && (!f.sourceQuote || (f.sourceVersion || 1)===(store.maybe('chapters',f.chapterId)?.sourceVersion || 1)));
}
export function segmentPerformanceIssues(store,chapter,s) {
  const decision=s.decisions?.performance;
  if(decision?.waivedBasic===true && !hasReadableText(s.performance))return [];
  const issues=inspectPerformance(s.performance,s.text,decision);
  if(decision?.dependencies && !same(decision.dependencies,performanceDependency(s)))issues.push('表演依据已改变');
  if(decision?.roleFacts && !same(decision.roleFacts,performanceRoleFacts(store,chapter,s.roleId)))issues.push('角色资料已改变');
  return issues;
}
export function performanceCoverage(store, chapterId, {ids,analysisId} = {}) {
  const chapter = store.get('chapters',chapterId), all = store.all('segments',chapterId);
  const eligible = all.filter(eligiblePerformanceSegment).filter(s => !ids || ids.includes(s.id));
  const missingIds = [],reviewRequiredIds = [],waivedBasicIds = [],coveredIds = [];
  for (const s of eligible) {
    const decision = s.decisions?.performance;
    if (decision?.waivedBasic === true && !hasReadableText(s.performance)) {waivedBasicIds.push(s.id);continue;}
    const issues = segmentPerformanceIssues(store,chapter,s);
    if (!issues.length) coveredIds.push(s.id);
    else if (humanPerformance(s) && hasReadableText(s.performance)) reviewRequiredIds.push(s.id);
    else missingIds.push(s.id);
  }
  const record = analysisId ? store.maybe('suggestions',analysisId) : store.all('suggestions',chapterId).filter(r=>r.performancePolicy?.enabled || r.explicitBasic).at(-1);
  const currentRun = Object.fromEntries(['writtenIds','unchangedIds','preservedHumanIds','skippedChangedIds','repairedIds'].map(key=>[key,record?.performanceReceipt?.[key] || []]));
  const uninitialized=!all.length&&hasReadableText(chapter.source);
  return {chapterId,chapterRevision:chapter.revision,sourceVersion:chapter.sourceVersion || 1,analysisContractVersion:record?.analysisContractVersion || 'legacy',eligibleCount:eligible.length,coveredCount:coveredIds.length,coveredIds,missingIds,reviewRequiredIds,waivedBasicIds,uninitialized,excludedCount:all.filter(s=>!s.retired&&!s.deletion&&s.excluded).length,deletedCount:all.filter(s=>!s.retired&&s.deletion).length,retiredCount:all.filter(s=>s.retired).length,currentRun,phase:record?.status==='running' ? record.performancePhase || 'analyzing' : missingIds.length || reviewRequiredIds.length || uninitialized ? 'needsAttention' : 'ready'};
}
