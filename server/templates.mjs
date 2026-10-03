import { fail } from "./store.mjs";

export const sceneContract = Object.freeze({ descriptionMax: 1500, promptMax: 3000, countUnit: 'Unicode code point' });
export const validEventDescription = value => typeof value === 'string' && !!value.trim() && Array.from(value).length <= sceneContract.descriptionMax;

// Keep each published implementation under its existing ID. Changing the
// current version affects new units only; existing units keep their saved ID.
export const templateCatalog = {
  current: "dry-v1",
  versions: {
    "dry-v1": {
      name: "逐条干声 v1",
      description: "单说话者参考、正文与表演分开；清晰干声。",
      mode: "dry",
      defaults: {speech_rate:0, loudness_rate:0, pitch_rate:0},
      compile(s) {
        return `[任务]\n生成一条中文有声书干声，只朗读正文一次。说话者标签、参考编号、标题和说明不读出。\n\n[角色]\n说话者 A，声音身份参考 @音频1。\n\n[表演]\n${s.performance || "自然、清楚地朗读，不增加喘息、笑声或额外台词。"}\n\n[正文]\n${s.text}\n\n[声音呈现]\n清晰干声，无音乐、环境声和额外音效，无明显空间混响。`;
      },
    },
    "voice-design-v1": {
      name: "声音创建 v1", scope: "candidate", mode: "dry",
      defaults: {speech_rate:0, loudness_rate:0, pitch_rate:0},
      compile(s) {
        return `[任务]\n生成一段中文声音候选，只朗读样文一次。标题和说明不读出。\n\n[声音设计]\n${s.description}\n不增加额外台词、笑声或喘息。\n\n[样文]\n${s.text}\n\n[声音呈现]\n单人清晰干声，无音乐、环境声、额外音效和明显空间混响。`;
      },
    },
    "dialogue-dry-v1": {
      name: "多人干声 v1", scope: "group", mode: "group",
      defaults: {speech_rate:0, loudness_rate:0, pitch_rate:0},
      compile: s => compileUnit(s, false),
    },
    "scene-v1": {
      name: "场景 v1", scope: "unit", mode: "scene",
      defaults: {speech_rate:0, loudness_rate:0, pitch_rate:0},
      compile: s => compileUnit(s, true),
    },
    "scene-v2": {
      name: "场景 v2 · 背景清楚可辨", scope: "unit", mode: "scene",
      defaults: {speech_rate:0, loudness_rate:0, pitch_rate:0},
      compile: s => compileUnit(s, true, true),
    },
    "scene-v3-native": {
      name: "场景 v3 · 原生完整声景（试验）", scope: "unit", mode: "scene",
      description: "先组织完整声景，保留已采用背景、表演和正文；效果待听评。",
      defaults: {speech_rate:0, loudness_rate:0, pitch_rate:0},
      compile: compileNativeScene,
    },
    "native3-frozen-cd": {
      name: "原生 v3 · C/D 历史编译", scope: "unit", mode: "scene", historical: true,
      description: "冻结已保存的字段式原生声景语法；仅按原input与prompt逐字匹配识别。",
      defaults: {speech_rate:0, loudness_rate:0, pitch_rate:0},
      compile: s => compileNativeScene({...s, members:s.members.map(member=>({...member,type:'dialogue'}))}).replace('不增加已采用事件或整体场景指导之外的声音或角色。','不增加未采用的独立声音事件或角色。'),
    },
    "native3-paragraph-k": {
      name: "原生 v3 · 自然段历史编译", scope: "unit", mode: "scene", historical: true,
      description: "冻结 a291 的自然段与多人编译实现。",
      defaults: {speech_rate:0, loudness_rate:0, pitch_rate:0},
      compile: compileNativeScene,
    },
    "scene-v4-presence-1": {
      name: "场景 v4 · 背景存在感（试验）", scope: "unit", mode: "scene",
      description: "表达用户选定的轻、自然或清楚存在感；效果待听评，不自动替换已有模板。",
      defaults: {speech_rate:0, loudness_rate:0, pitch_rate:0},
      compile: compilePresenceScene,
    },
  },
};
export function templateOf(id) {
  if (!Object.hasOwn(templateCatalog.versions, id)) fail(`模板 ${id} 的实现不可用；请恢复对应应用版本或明确切换模板，不能自动替换`);
  return templateCatalog.versions[id];
}
export const compile = s => {
  if ((s.events || []).some(event => !validEventDescription(event.description))) fail(`声音事件描述不能为空，且不能超过 ${sceneContract.descriptionMax} 个 Unicode 字符`);
  return templateOf(s.compilerId || s.template).compile(s);
};
export const listTemplates = () => Object.entries(templateCatalog.versions).filter(([,t]) => !t.scope || t.scope === "single").map(([id,t]) => ({id,name:t.name,description:t.description,current:id===templateCatalog.current}));
export const listUnitTemplates = () => Object.entries(templateCatalog.versions).filter(([,t]) => t.scope !== "candidate" && !t.historical).map(([id,t]) => ({id,name:t.name,description:t.description,mode:t.mode,scope:t.scope || "single"}));

export function resolveCompiler(input, prompt) {
  const ids = input.template === 'scene-v3-native' ? ['native3-frozen-cd','native3-paragraph-k'] : [input.compilerId || input.template];
  for (const id of ids) {
    try { if (templateOf(id).compile(input) === prompt) return id; } catch { /* Unknown or invalid snapshots remain read-only. */ }
  }
  return null;
}

export function assertQuoteAnchor(members, anchor) {
  const member = members.find(m => m.id === anchor.memberId);
  if (!member || typeof anchor.quote !== 'string' || !anchor.quote.trim() || Array.from(anchor.quote).length > 200 || !Number.isInteger(anchor.occurrence) || anchor.occurrence < 1) fail('转折需指定本单元成员、真实短引文和出现序号');
  let offset = 0, index = -1;
  for (let i = 0; i < anchor.occurrence; i++) { index = member.text.indexOf(anchor.quote, offset); if (index < 0) fail('转折短引文或出现序号已失效，请核对正文'); offset = index + anchor.quote.length; }
  return members.indexOf(member) + 1;
}

export function sceneIntentConflicts(s) {
  // ponytail: recognise only explicit standalone prohibitions; uncertain prose
  // stays unchanged for human review instead of guessing its meaning.
  const clauses = (s.guidance || '').split(/[，,；;。\n]/u).map(value=>value.trim());
  return [['music',['无音乐','不要音乐','不添加音乐']],['environment',['无环境声','不要环境声','不添加环境声']],['effect',['无音效','不要音效','不添加音效']]].filter(([kind,words])=>(s.events || []).some(e=>e.kind===kind) && clauses.some(clause=>words.includes(clause))).map(([kind])=>`整体场景指导明确禁止${({music:'音乐',environment:'环境声',effect:'音效'})[kind]}，但已采用同类事件，请一次核对这段的指导和事件`);
}

function compilePresenceScene(s) {
  const conflicts = sceneIntentConflicts(s);
  if (conflicts.length) throw Object.assign(new Error(conflicts.join('；')), {status:409,code:'scene-intent-conflict',conflicts});
  const presence = s.backgroundPresence || 'unspecified';
  if (!['clear','natural','subtle','unspecified'].includes(presence)) fail('背景存在感选项无效');
  const wording = {
    clear: '已采用声音按各自范围及发展要求组织。讲话期间，已采用的音乐在其范围内保持可辨识的旋律和明确存在感；环境声在其范围内可辨，每个间歇音效出现时，其声响与采用的回响都能够辨认。音乐转为宁静是情绪和织体的变化，不自动淡出到几乎听不到。讲话与这些声音共同呈现，字词保持清楚。',
    natural: '已采用声音按各自范围及发展要求组织。讲话与背景自然共同呈现；音乐在采用范围内有可辨的旋律，环境及间歇音效自然可辨，字词保持清楚。音乐情绪或织体转为宁静，不自动表示音量淡出。',
    subtle: '已采用声音按各自范围及发展要求组织。按用户选择保持轻柔背景，不抢讲话；音乐、环境声和间歇音效仅在各自采用范围内轻柔呈现，字词保持清楚。音乐情绪或织体变化与音量变化分开安排。',
  };
  let prompt = compileNativeScene(s);
  if (presence !== 'unspecified') prompt = prompt.replace(/已采用声音按各自范围及发展要求组织；环境和音乐可与(?:旁白|说话)同期呈现。/u,wording[presence]);
  const transitions = (s.events || []).filter(event=>event.transition).map(event=>{
    const anchor = event.transition, index = assertQuoteAnchor(s.members,anchor);
    if (typeof anchor.development !== 'string' || !anchor.development.trim() || Array.from(anchor.development).length > 500) fail('转折发展描述不能为空，且不能超过500个Unicode字符');
    if (anchor.volumeChange !== undefined && (typeof anchor.volumeChange !== 'string' || Array.from(anchor.volumeChange).length > 200)) fail('转折音量描述无效');
    return `声音事件发展：在第${index}条正文第${anchor.occurrence}次出现“${anchor.quote}”时，${anchor.development}；音量变化：${anchor.volumeChange || '未指定，不由情绪变化推断淡出'}。`;
  });
  if (transitions.length) prompt = prompt.replace(s.members.length===1 && s.members[0].type==='narration' ? '\n\n只将以下引号' : '\n\n[人物与参考]',`\n${transitions.join('\n')}${s.members.length===1 && s.members[0].type==='narration' ? '\n\n只将以下引号' : '\n\n[人物与参考]'}`);
  return prompt;
}

export function compileNativeScene(s) {
  const anchor = (id, position) => {
    const index = s.members.findIndex(member => member.id === id);
    if (index < 0) fail("声音事件锚点已失效");
    return `第${index + 1}条正文${({before:"之前",during:"期间",after:"之后"})[position] || "期间"}`;
  };
  const events = (s.events || []).map(event => {
    const location = event.startMemberId ? `${anchor(event.startMemberId, event.startPosition || "before")}至${anchor(event.endMemberId, event.endPosition || "after")}` : anchor(event.memberId, event.position);
    return `${({environment:"环境声",effect:"一次性音效",music:"音乐"})[event.kind]}：${location}，${event.description}`;
  }).join("\n");
  const roles = s.slots.map(slot => `说话者 ${slot.speaker} 的声音身份参考 @音频${slot.reference}；参考用于声音身份，当前场景与表演按本次要求安排。`).join("\n");
  const lines = s.members.map((member, i) => {
    const slot = s.slots.find(slot => slot.roleId === member.roleId);
    if (!slot) fail("成员缺少说话者槽位");
    return `${i + 1}. 说话者 ${slot.speaker}；表演：${member.performance || "自然清楚地朗读"}；正文：${member.text}`;
  }).join("\n");
  const guidance = s.guidance || s.performance;
  if (s.members.length === 1 && s.members[0].type === "narration") {
    const member = s.members[0];
    return `创作一段完整的中文有声小说声音场景。旁白与已采用的声音共同构成一份音频，字词清楚。\n${roles}${member.performance ? `\n旁白表演：${member.performance}` : ""}\n\n${events || "本次没有单独采用的声音事件。"}${guidance ? `\n整体场景指导：${guidance}` : ""}\n已采用声音按各自范围及发展要求组织；环境和音乐可与旁白同期呈现。\n\n只将以下引号内的正文逐字朗读一次；其余描述作为声音创作要求，不读出。不增加、遗漏或改写台词，不增加已采用事件或整体场景指导之外的声音或角色。\n“${member.text}”`;
  }
  return `[任务]\n在以下${s.members.length}条正文的范围内，一次生成完整中文声景。旁白或对白与已采用的环境、音乐、音效共同构成这次输出；字词清楚可辨。\n\n[已采用声景与发展]\n${events || "无"}${guidance ? `\n\n[整体场景指导]\n${guidance}` : ""}\n\n[人物与参考]\n${roles}\n\n[只朗读以下正文一次]\n${lines}\n\n[文字与范围边界]\n正文文字、顺序和说话者归属保持不变；编号、标题、说话者标签、参考编号和说明不读出。不增加、遗漏或改写台词，不增加已采用事件或整体场景指导之外的声音或角色。已采用声音按各自范围及发展要求组织；环境和音乐可与说话同期呈现。`;
}

function compileUnit(s, scene, audible = false) {
  const roles = s.slots.map(slot => `说话者 ${slot.speaker} 使用 @音频${slot.reference} 的声音身份。`).join("\n");
  const lines = s.members.map((member, i) => {
    const slot = s.slots.find(slot => slot.roleId === member.roleId);
    if (!slot) fail("成员缺少说话者槽位");
    return `${i + 1}. 说话者 ${slot.speaker}；表演：${member.performance || "自然清楚地朗读"}；正文：${member.text}`;
  }).join("\n");
  const anchor = (id, position) => {
    const index = s.members.findIndex(member => member.id === id);
    if (index < 0) fail("声音事件锚点已失效");
    return `第${index + 1}条正文${({before:"之前",during:"期间",after:"之后"})[position] || "期间"}`;
  };
  const events = scene ? (s.events || []).map(event => {
    const location = event.startMemberId ? `${anchor(event.startMemberId, event.startPosition || "before")}至${anchor(event.endMemberId, event.endPosition || "after")}` : anchor(event.memberId, event.position);
    return `${({environment:"环境声",effect:"一次性音效",music:"音乐"})[event.kind]}：${location}，${event.description}`;
  }).join("\n") : "";
  return `[任务]\n按下列顺序生成一段中文${scene ? "有声场景" : "对白干声"}。每条正文只朗读一次；编号、说话者标签、标题和表演说明都不读出。不增加、遗漏或改写台词。\n\n[角色参考]\n${roles}\n\n[互动]\n${s.guidance || s.performance || "轮流说话，不重叠；衔接自然，不增加回应。"}\n\n[逐条正文与表演]\n${lines}\n\n${scene ? `[已采用声音事件]\n${events || "无"}\n\n[声音主次]\n${audible ? "对白始终清晰可懂；已采用的环境声和音乐应在指定范围内持续清楚可辨，不只是几乎听不到的底噪；台词之间的自然停顿中也保持可闻。一次性音效应在指定位置清楚可辨。对白时适度降低背景声音，但不能消失。不遮盖字词，不代替或添加台词，不增加未列出的事件，不延长停顿。" : "对白清楚，声音事件次要，不以事件替代台词，不添加未列出的事件。"}` : "[声音呈现]\n清晰干声，无音乐、环境声、额外音效和明显空间混响。"}`;
}
