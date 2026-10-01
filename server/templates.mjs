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
  },
};
export function templateOf(id) {
  if (!Object.hasOwn(templateCatalog.versions, id)) fail(`模板 ${id} 的实现不可用；请恢复对应应用版本或明确切换模板，不能自动替换`);
  return templateCatalog.versions[id];
}
export const compile = s => templateOf(s.template).compile(s);
export const listTemplates = () => Object.entries(templateCatalog.versions).map(([id,t]) => ({id,name:t.name,description:t.description,current:id===templateCatalog.current}));
