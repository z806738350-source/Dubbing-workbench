import { fail } from "./store.mjs";

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
  },
};
export function templateOf(id) {
  if (!Object.hasOwn(templateCatalog.versions, id)) fail(`模板 ${id} 的实现不可用；请恢复对应应用版本或明确切换模板，不能自动替换`);
  return templateCatalog.versions[id];
}
export const compile = s => templateOf(s.template).compile(s);
export const listTemplates = () => Object.entries(templateCatalog.versions).filter(([,t]) => !t.scope || t.scope === "single").map(([id,t]) => ({id,name:t.name,description:t.description,current:id===templateCatalog.current}));
export const listUnitTemplates = () => Object.entries(templateCatalog.versions).filter(([,t]) => t.scope !== "candidate").map(([id,t]) => ({id,name:t.name,description:t.description,mode:t.mode,scope:t.scope || "single"}));

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
