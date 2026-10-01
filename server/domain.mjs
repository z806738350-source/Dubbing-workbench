import { existsSync } from "node:fs";
import { join } from "node:path";
import { fail, same, text, uid } from "./store.mjs";
import { storedAudioUnavailable } from "./audio.mjs";
import { compile, templateOf, templateCatalog, listTemplates } from "./templates.mjs";
export { compile } from "./templates.mjs";

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
      : same(audioInput(audio), inputOf(s))
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
  const chars = Array.from(source);
  let start = 0;
  const spans = [];
  for (let i = 0; i < chars.length; i++)
    if (chars[i] === "\n" || /[。！？!?]/u.test(chars[i]) || i - start >= 299) {
      while (i + 1 < chars.length && /[”’」』"']/u.test(chars[i + 1])) i++;
      spans.push([start, i + 1]);
      start = i + 1;
    }
  if (start < chars.length) spans.push([start, chars.length]);
  return spans
    .filter(([a, b]) => chars.slice(a, b).join("").trim())
    .map(([start, end]) => ({
      start,
      end,
      text: chars.slice(start, end).join(""),
    }));
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
  }
  function context(projectId) {
    const p = store.get("projects", projectId);
    p.contextRevision++;
    store.put("projects", p);
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
      voiceId: role.voiceId || null,
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
  function rebind(s, roleId) {
    const r = store.get("roles", roleId);
    if (r.archived) fail("请先恢复已归档角色");
    if (s.roleId === roleId) return;
    s.roleId = r.id;
    s.roleConfirmed = true;
    if (s.voiceSource === "default") {
      s.voiceId = r.voiceId;
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
    compile(s);
  }
  return {
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
            : included.some(s => !s.roleConfirmed || !s.identityConfirmed || !s.voiceId) ? "待确认"
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
            currentSegmentId: attempts.find(a => a.status === "sending")?.segmentId,
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
        return status.validity === "matched" && status.review === "passed" && s.roleConfirmed && s.identityConfirmed;
      });
      return {
        ...c,
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
      return store.transaction(() => {
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
          return store.put("settings", {
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
          v.name = text(p.name, "项目名称", 100).trim();
          v.revision = (v.revision ?? 1) + 1;
          return store.put("projects", v);
        }
        if (action === "chapter.create") {
          store.get("projects", p.projectId);
          const source =
            typeof p.source === "string"
              ? p.source.replace(/\r\n?/g, "\n")
              : "";
          if (source.length > 1000000 || (typeof p.importedSource === "string" && p.importedSource.length > 1000000)) fail("单章文字过长，请按章导入");
          const c = {
            id: uid(),
            projectId: p.projectId,
            title: text(p.title, "章节名称", 150),
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
            r.voiceId = p.voiceId || null;
            if (c && ((first && r.voiceId) || p.apply)) {
              for (const s of list(c.id))
                if (
                  s.roleId === r.id &&
                  s.voiceSource !== "override" &&
                  (p.apply || !s.voiceId)
                ) {
                  s.voiceId = r.voiceId;
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
            store.put("chapters", c, c.projectId);
            store.put("chapters", next, c.projectId);
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
            s.roleConfirmed = s.identityConfirmed = true;
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
            s.voiceId = store.get("roles", s.roleId).voiceId;
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
            if (!s.text.trim()) {
              s.excluded = true;
              s.exclusionReason = "用户清空朗读正文";
            }
          }
          validate(s, c);
          store.put("segments", s, c.id);
          touch(c, true, wasExcluded !== s.excluded);
          return s;
        }
        if (action === "segment.split") {
          if (s.performance && (!Array.isArray(p.performance) || p.performance.length !== 2 || p.performance.some(x => typeof x !== "string"))) fail("请明确分配拆分后两条的表演指导");
          const chars = Array.from(s.text);
          if (
            !Number.isInteger(p.offset) ||
            p.offset <= 0 ||
            p.offset >= chars.length
          )
            fail("请选择正文中间的拆分位置");
          const group = s.source.group || uid();
          const children = [
            chars.slice(0, p.offset).join(""),
            chars.slice(p.offset).join(""),
          ].map((t, i) => ({
            ...s,
            id: uid(),
            text: t,
            order: s.order + i * 0.5,
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
              splitOffset: p.offset,
            },
            current: null,
            previous: null,
            approved: null,
            review: null,
            latest: "none",
          }));
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
          const merged = {
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
          };
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
          if (!same(audioInput(a), inputOf(s)) && !p.restoreSettings)
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
      });
    },
  };
}
