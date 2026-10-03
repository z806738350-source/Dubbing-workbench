import { mkdir, readFile, writeFile, rename, rm } from "node:fs/promises";
import { existsSync, createWriteStream, statSync } from "node:fs";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { join, dirname } from "node:path";
import { projectFile } from './workspace.mjs';
import {
  active,
  basisOf,
  compile,
  coverage,
  inputOf,
  audioMatches,
  performanceIssues,
  segmentStatus,
  checkEntityRevision,
} from "./domain.mjs";
import { buildMaster, exportMaster, inspect, validateStoredAudio } from "./audio.mjs";
import { fail, same, uid } from "./store.mjs";
import { templateCatalog, templateOf } from "./templates.mjs";
import { configurationDecided, reserveGrant, settleGrant } from './experience.mjs';

export function createWorker(store, domain, config) {
  if (config.callLimit !== undefined && (!Number.isSafeInteger(config.callLimit) || config.callLimit < 1)) fail("本地调用额度应为正整数");
  const quotaScope = config.usageScope || "audio-calls-v1";
  if (typeof quotaScope !== "string" || !quotaScope || quotaScope.length > 100) fail("调用额度范围无效");
  let running = false,
    closing = false;
  const routeBlocked = () => !!store.maybe("settings", "audio-route")?.blocked;
  const setRouteBlocked = blocked => store.put("settings", { id: "audio-route", blocked });
  const requestOf = p => JSON.parse(JSON.stringify({ ...p, kind: p.kind || "generate" }));
  const existingCommand = p => {
    if (typeof p?.commandId !== "string" || !p.commandId || p.commandId.length > 100) fail("生成命令标识缺失");
    const existing = store.all("jobs").find(j => j.commandId === p.commandId);
    if (existing?.request && !same(existing.request, requestOf(p))) fail("相同命令标识的请求内容不同，请核对后使用新命令", 409);
    if (existing && !existing.request) {
      const kind = p.kind || "generate", attempt = store.all("attempts", existing.id)[0];
      let matches = kind === existing.kind;
      if (kind === "voice-test") matches &&= same([p.voiceId, p.text, p.entityRevision], [existing.voiceId, attempt?.input.text, existing.voiceRevision]);
      else {
        matches &&= p.chapterId === existing.chapterId && p.revision === existing.revision;
        if (kind === "generate") matches &&= Array.isArray(p.ids) && same([...p.ids].sort(), [...existing.ids].sort());
        if (kind === "export") matches &&= p.format === existing.format && p.arrangement === existing.arrangement && same(p.reviewItems, existing.confirmation?.reviewItems);
      }
      if (!matches) fail("旧命令的实际目标或内容不同，请使用新命令", 409);
    }
    return existing;
  };
  const setJob = (j) => store.put("jobs", j, j.chapterId || "");
  const referenceIds = a => a.input.referenceVoiceIds || (a.input.voiceId ? [a.input.voiceId] : []);
  async function inspectReference(v) {
    const file = join(store.directory, v.path), bytes = statSync(file).size;
    if (!bytes || bytes > 10 * 1024 * 1024) fail("参考声音应为 1 字节～10 MB，本次未发送");
    const meta = await inspect(file);
    if (meta.duration > 30 || !/^(wav|mp3)$/.test(meta.format)) fail("参考声音须为 WAV/MP3 且不超过 30 秒，本次未发送");
  }
  function reserve(attempts, p) {
    reserveGrant(store,config,p,attempts);
    if (config.callLimit === undefined || !attempts.length) return;
    const id = `audio-usage:${quotaScope}`;
    const usage = store.maybe("settings", id) || { id, scope: quotaScope, limit: config.callLimit, reserved: 0, used: 0 };
    if (usage.limit !== config.callLimit) fail("调用额度范围已使用其他上限，请使用明确的新额度范围", 409);
    if (usage.used + usage.reserved + attempts.length > usage.limit) fail("本地授权调用额度不足；结果不明和在途请求仍占用额度");
    usage.reserved += attempts.length;
    store.put("settings", usage);
    for (const a of attempts) a.quota = { scope: quotaScope, state: "reserved" };
  }
  function moveQuota(a, state) {
    settleGrant(store,config,a,state);
    if (a.quota?.state !== "reserved") return;
    const usage = store.get("settings", `audio-usage:${a.quota.scope}`);
    usage.reserved--;
    if (state === "used") usage.used++;
    a.quota = { ...a.quota, state };
    store.put("settings", usage);
  }
  function saveAttempt(a, jobId) {
    store.transaction(() => {
      if (["stopped", "failed"].includes(a.status)) moveQuota(a, "released");
      store.put("attempts", a, jobId);
      domain.enhancement?.setAttemptStatus(store.get("jobs", jobId), a, a.status);
    });
  }
  function preflight(c, ids, whole = false) {
    if (!Array.isArray(ids) || new Set(ids).size !== ids.length) fail("生成片段列表无效");
    const all = domain.list(c.id),
      selected = all.filter((s) => !s.excluded && ids.includes(s.id));
    if (!selected.length || selected.length !== ids.length)
      fail("请选择有效片段");
    if (whole && !coverage(c, all).valid)
      fail("原文覆盖不完整，请先核对缺漏与重复");
    for (const s of selected) {
      const conflicts = performanceIssues(s);
      if (conflicts.length) fail(conflicts.join("；"));
      if (!configurationDecided(s))
        fail("请先确认所有所选片段的角色与声音身份");
      if (!s.voiceId) fail("部分片段尚未选择音色");
      const v = store.get("voices", s.voiceId);
      if (
        v.state === "stopped" ||
        v.state === "deleted" ||
        !existsSync(join(store.directory, v.path))
      )
        throw Object.assign(
          new Error("部分参考声音已停用或缺失，尚未提交的请求已停止"),
          { status: 400, stopped: true },
        );
      if (Array.from(compile(s)).length > 3000)
        fail("提示超过 3000 字符，请拆分片段");
      domain.validate(s, c);
    }
    domain.enhancement?.assertLegacyGeneration?.(c, selected);
    return selected;
  }
  function prepareEnhancement(p) {
    const prepared = domain.enhancement.prepare(p, config);
    if (p.kind === "unit-generate") {
      prepared.arrangement = store.get("chapters", p.chapterId).arrangement;
      if (p.arrangement !== undefined && p.arrangement !== prepared.arrangement) fail("实际声音编排在核对后已变化，请重新查看生成范围", 409);
    }
    return prepared;
  }
  function enqueue(p, checked) {
    return store.transaction(() => {
      const existing = existingCommand(p);
      if (existing) return existing;
      if (["voice-create", "unit-generate"].includes(p.kind)) {
        if (!config.key) fail("请先配置 Kunpo API Key");
        if (routeBlocked() && !p.resumeRoute) fail("接口已暂停，请核对配置后重新启用");
        const prepared = prepareEnhancement(p);
        if (checked && !same(prepared, checked)) fail("生成范围、声音版本或设置在预检期间已变化，本批尚未入队", 409);
        const job = { ...prepared.job, id: uid(), commandId: p.commandId, request: requestOf(p), kind: p.kind, chapterId: prepared.job.chapterId || "", status: "queued", done: 0, total: prepared.attempts.length, stop: false, createdAt: new Date().toISOString() };
        const attempts = prepared.attempts.map(a => ({ ...a, id: uid(), jobId: job.id, status: "queued", prompt: compile(a.input), model: a.input.model }));
        for (const a of attempts) {
          a.path = projectFile(store, job.chapterId, 'audio', `${a.id}.wav`);
          if (Array.from(a.prompt).length > 3000) fail("提示超过 3000 字符，请拆组或缩减说明");
          if (referenceIds(a).length > 3 || new Set(referenceIds(a)).size !== referenceIds(a).length) fail("参考声音最多三份且应去重");
        }
        reserve(attempts,p);
        setJob(job);
        for (const a of attempts) {
          store.put("attempts", a, job.id);
          domain.enhancement.setAttemptStatus(job, a, "queued");
        }
        setRouteBlocked(false);
        return job;
      }
      if (p.kind === "voice-test") {
        if (!config.key) fail("请先配置 Kunpo API Key");
        if (routeBlocked() && !p.resumeRoute)
          fail("接口已暂停，请核对配置后重新启用");
        const v = store.get("voices", p.voiceId);
        checkEntityRevision(v, p.entityRevision);
        if (v.state !== "active") fail("请选择可用参考声音");
        if (
          typeof p.text !== "string" ||
          !p.text.trim() ||
          Array.from(p.text).length > 300
        )
          fail("试音正文应为 1～300 字符");
        if (store.all("jobs").some((j) => j.voiceId === v.id && active(j)))
          fail("该音色已有试音任务");
        const last = store
          .all("jobs")
          .filter((j) => j.voiceId === v.id)
          .at(-1);
        if (last?.status === "unknown" && !p.retryUnknown)
          fail("上次试音结果不明，请核对可能重复计费后重试");
        setRouteBlocked(false);
        const input = {
          model: config.model,
          text: p.text,
          voiceId: v.id,
          performance: "自然清楚地朗读。",
          config: { ...templateOf(templateCatalog.current).defaults },
          template: templateCatalog.current,
        };
        const job = {
          id: uid(),
          commandId: p.commandId,
          chapterId: "",
          kind: "voice-test",
          targetKind: "voice-test",
          targetId: v.id,
          request: requestOf(p),
          voiceId: v.id,
          status: "queued",
          voiceRevision: v.revision ?? 1,
          done: 0,
          total: 1,
          stop: false,
          createdAt: new Date().toISOString(),
        };
        setJob(job);
        const attempt = {
          id: uid(),
          jobId: job.id,
          input,
          prompt: compile(input),
          status: "queued",
          model: config.model,
          targetKind: "voice-test", targetId: v.id,
        };
        reserve([attempt],p);
        store.put("attempts", attempt, job.id);
        return job;
      }
      const c = domain.editable(p.chapterId, p.revision);
      const kind = p.kind || "generate";
      if (!["generate", "master", "export"].includes(kind))
        fail("任务类型无效");
      const all = domain.list(c.id).filter((s) => !s.excluded);
      let selected = all;
      let preparedRender;
      if (kind === "generate") {
        if (!config.key) fail("请先在服务端配置 Kunpo API Key");
        if (routeBlocked() && !p.resumeRoute)
          fail("上次调用发生共享接口错误，请检查配置后选择重新启用接口");
        if (!Array.isArray(p.ids) || new Set(p.ids).size !== p.ids.length)
          fail("生成片段列表无效");
        selected = preflight(c, p.ids, p.whole);
        if (selected.some((s) => s.latest === "unknown") && !p.retryUnknown)
          fail("所选包含结果不明的请求，需明确确认可能重复计费");
        setRouteBlocked(false);
      } else if (domain.enhancement?.prepareRender) {
        preparedRender = domain.enhancement.prepareRender(p, c);
        selected = preparedRender.rows.map(row => row.s);
      } else {
        if (!all.length) fail("章节没有有效朗读片段");
        if (all.some((s) => segmentStatus(store, s).validity !== "matched"))
          fail("仍有片段缺少匹配音频，请完成生成后重试");
        if (kind === "export") {
          if (!["wav", "mp3"].includes(p.format)) fail("导出格式无效");
          if (!coverage(c, domain.list(c.id)).valid)
            fail("原文覆盖不完整，不能正式导出");
          if (all.some((s) => !configurationDecided(s)))
            fail("请完成角色和声音身份核对");
          if (all.some((s) => segmentStatus(store, s).review === "rework"))
            fail("仍有需返工的片段");
          if (
            p.arrangement !== c.arrangement ||
            !same(
              p.reviewItems,
              all.map((s) => ({
                id: s.id,
                audioId: s.current,
                basis: basisOf(s),
              })),
            )
          )
            fail("章节版本已变化，请重新检查后导出", 409);
          if (
            !p.confirm &&
            all.some((s) => segmentStatus(store, s).review !== "passed")
          )
            fail("请先确认待检查的音频");
          if (p.confirm)
            for (const s of all) {
              if (segmentStatus(store, s).review === "passed") continue;
              s.review = {
                audioId: s.current,
                basis: basisOf(s),
                state: "passed",
                at: new Date().toISOString(),
              };
              s.approved = s.current;
              store.put("segments", s, c.id);
              const a = store.get("audios", s.current);
              a.review = s.review;
              store.put("audios", a, c.id);
            }
        }
      }
      const job = {
        id: uid(),
        chapterId: c.id,
        commandId: p.commandId,
        request: requestOf(p),
        targetKind: kind === "generate" ? "single" : "chapter",
        targetId: c.id,
        kind,
        status: "queued",
        revision: c.revision,
        arrangement: c.arrangement,
        ids: selected.map((s) => s.id),
        format: p.format || "wav",
        done: 0,
        total: selected.length,
        stop: false,
        createdAt: new Date().toISOString(),
        ...(kind === "export" ? { confirmation: preparedRender?.confirmation || { arrangement: c.arrangement, reviewItems: p.reviewItems, at: new Date().toISOString() } } : {}),
      };
      setJob(job);
      if (kind === "generate") {
        const attempts = [];
        for (const s of selected) {
          s.latest = "queued";
          store.put("segments", s, c.id);
          domain.enhancement?.syncLegacySegment(s);
          const attempt = {
            id: uid(),
            jobId: job.id,
            chapterId: c.id,
            segmentId: s.id,
            input: inputOf(s),
            basis: basisOf(s),
            prompt: compile(s),
            roleId: s.roleId,
            status: "queued",
            model: inputOf(s).model,
            targetKind: "single", targetId: s.id,
          };
          attempt.path = projectFile(store, c.id, 'audio', `${attempt.id}.wav`);
          attempts.push(attempt);
        }
        reserve(attempts,p);
        for (const a of attempts) store.put("attempts", a, job.id);
      }
      return job;
    });
  }
  function register(attempt, meta) {
    attempt = { ...attempt };
    store.transaction(() => {
      const s = attempt.segmentId
        ? store.get("segments", attempt.segmentId)
        : null;
      const j = store.get("jobs", attempt.jobId);
      const c = (s?.chapterId || j.chapterId) ? store.get("chapters", s?.chapterId || j.chapterId) : null;
      const audio = {
        id: attempt.id,
        path: attempt.path || `audio/${attempt.id}.wav`,
        input: attempt.input,
        basis: attempt.basis,
        prompt: attempt.prompt,
        model: attempt.model,
        targetKind: attempt.targetKind || (s ? "single" : "voice-test"),
        targetId: attempt.targetId || s?.id || attempt.input.voiceId,
        ...(attempt.input.slots ? { slots: attempt.input.slots, memberIds: attempt.input.members.map(m => m.id), mode: attempt.mode } : {}),
        ...(["candidate", "unit"].includes(attempt.targetKind) ? { referenceVoiceIds: referenceIds(attempt) } : { slot: {
          speaker: "A",
          roleId: attempt.roleId,
          voiceId: attempt.input.voiceId,
        } }),
        ...meta,
        createdAt: new Date().toISOString(),
      };
      store.put("audios", audio, c?.id || "");
      if (["candidate", "unit"].includes(attempt.targetKind)) {
        attempt.adopted = domain.enhancement.register(j, attempt, audio);
        attempt.status = "success";
        store.put("attempts", attempt, j.id);
        return;
      }
      if (!s) {
        const v = store.get("voices", attempt.input.voiceId);
        const history = store.all("attempts");
        const newer = history.slice(history.findIndex(a => a.id === attempt.id) + 1)
          .some(a => !a.segmentId && a.input.voiceId === v.id);
        attempt.selectedAsSample = active(j) && j.voiceRevision === (v.revision ?? 1) && !newer && !v.deletePending && v.state !== "deleted";
        if (attempt.selectedAsSample) {
          v.sampleAudioId = audio.id;
          store.put("voices", v);
        }
        attempt.status = "success";
        store.put("attempts", attempt, j.id);
        return;
      }
      const history = store.all("attempts");
      const newer = history
        .slice(history.findIndex((a) => a.id === attempt.id) + 1)
        .some((a) => a.segmentId === s.id);
      if (
        active(j) && !s.retired &&
        c.revision === j.revision &&
        audioMatches(s, attempt) &&
        !newer
      ) {
        s.previous = s.current;
        s.current = audio.id;
        s.latest = "success";
        s.review = null;
        store.put("segments", s, c.id);
        domain.enhancement?.syncLegacySegment(s);
        domain.touch(c, false);
      }
      attempt.status = "success";
      store.put("attempts", attempt, j.id);
    });
  }
  async function generate(job) {
    for (const a of store.all("attempts", job.id)) {
      if (a.status !== "queued") continue;
      const fresh = store.get("jobs", job.id);
      if (!active(fresh)) break;
      if (store.get("attempts", a.id).status !== "queued") continue;
      let s = a.segmentId ? store.get("segments", a.segmentId) : null;
      if (fresh.stop || routeBlocked() || closing) {
        a.status = "stopped";
        if (s) {
          s.latest = "stopped";
          store.put("segments", s, job.chapterId);
          domain.enhancement?.syncLegacySegment(s);
        }
        saveAttempt(a, job.id);
        continue;
      }
      try {
        for (const id of referenceIds(a)) {
          const reference = store.get("voices", id);
          if (reference.path && !["stopped", "deleted"].includes(reference.state)) {
            try {
              await inspectReference(reference);
            } catch (e) {
              if (e.status) throw e;
              fail("参考声音损坏或不可解码，本条未发送");
            }
          }
        }
        const references = await Promise.all(referenceIds(a).map(async id => {
          const voice = store.get("voices", id);
          if (!["active", "archived"].includes(voice.state) || voice.deletePending || !voice.path)
            throw Object.assign(new Error("参考已停用，尚未发送的请求已停止"), { status: 400, stopped: true });
          const data = await readFile(join(store.directory, voice.path));
          if (!data.length || data.length > 10 * 1024 * 1024) fail("参考声音读取后超出 10 MB 规格，本次未发送");
          return { audio_data: data.toString("base64") };
        }));
        const dispatch = store.transaction(() => {
          const latest = store.get("jobs", job.id);
          if (!active(latest) || store.get("attempts", a.id).status !== "queued") return false;
          if (latest.stop || closing || routeBlocked())
            throw Object.assign(new Error("尚未提交的请求已停止"), { status: 400, stopped: true });
          if (["candidate", "unit"].includes(a.targetKind)) {
            domain.enhancement.validateDispatch(latest, a);
          } else if (s) {
            preflight(store.get("chapters", job.chapterId), [s.id]);
            if (store.get("chapters", job.chapterId).revision !== job.revision)
              fail("章节修订已改变", 409);
          } else {
            const v = store.get("voices", a.input.voiceId);
            if (
              !["active", "archived"].includes(v.state) ||
              !existsSync(join(store.directory, v.path))
            )
              throw Object.assign(new Error("参考已停用，试音未发送"), {
                status: 400,
                stopped: true,
              });
          }
          for (const id of referenceIds(a)) {
            const v = store.get("voices", id);
            if (!["active", "archived"].includes(v.state) || v.deletePending || !v.path || !existsSync(join(store.directory, v.path)))
              throw Object.assign(new Error("参考已停用，尚未发送的请求已停止"), { status: 400, stopped: true });
          }
          a.status = "sending";
          moveQuota(a, "used");
          a.createdAt = new Date().toISOString();
          store.put("attempts", a, job.id);
          domain.enhancement?.setAttemptStatus(latest, a, "running");
          if (s) {
            s.latest = "running";
            store.put("segments", s, job.chapterId);
            domain.enhancement?.syncLegacySegment(s);
          }
          return true;
        });
        if (!dispatch) continue;
        const response = await fetch(config.audioUrl, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.key}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: a.model,
            text_prompt: a.prompt,
            ...(references.length ? { references } : {}),
            audio_config: {
              format: "wav",
              sample_rate: 48000,
              speech_rate: a.input.config.speech_rate,
              loudness_rate: a.input.config.loudness_rate,
              pitch_rate: a.input.config.pitch_rate,
            },
          }),
          signal: AbortSignal.timeout(config.timeout || 180000),
        });
        if (!response.ok) {
          a.httpStatus = response.status;
          let durationError = false;
          try {
            let errorText = '', bytes = 0;
            for await (const chunk of Readable.fromWeb(response.body)) {
              bytes += chunk.length;
              if (bytes > 64 * 1024) break;
              errorText += chunk.toString('utf8');
            }
            durationError = ![401, 403, 429].includes(response.status) && /\bDurationOutOfRange\b/.test(errorText);
          } catch {} // An unreadable error body keeps the existing HTTP protection.
          if (durationError) a.providerErrorCode = 'DurationOutOfRange';
          if (!durationError && [401, 402, 403, 429].includes(response.status)) setRouteBlocked(true);
          throw Object.assign(
            new Error(
              durationError ? '音频服务拒绝本条时长：参考须不超过30秒，输出不超过120秒；请拆短正文后再生成，短句仍失败时请核对参考素材。' : `音频服务返回 ${response.status}，请检查权限、额度或稍后手动重试`,
            ),
            { known: true },
          );
        }
        if (
          !/audio\/(wav|x-wav|wave)|application\/octet-stream/i.test(
            response.headers.get("content-type") || "",
          )
        )
          throw new Error("音频服务返回类型不正确，结果待核对");
        const file = join(store.directory, a.path || `audio/${a.id}.wav`);
        await mkdir(dirname(file), { recursive: true });
        let size = 0;
        await pipeline(
          Readable.fromWeb(response.body),
          new Transform({
            transform(chunk, encoding, done) {
              size += chunk.length;
              done(
                size > 100 * 1024 * 1024 ? new Error("响应音频过大") : null,
                chunk,
              );
            },
          }),
          createWriteStream(file + ".part"),
        );
        const length = Number(response.headers.get("content-length"));
        if (!size || (length && length !== size))
          throw new Error("音频接收长度不完整");
        const meta = await inspect(file + ".part");
        await rename(file + ".part", file);
        register(a, meta);
      } catch (e) {
        const persisted = store.get("attempts", a.id);
        a.quota = persisted.quota;
        a.createdAt = persisted.createdAt;
        const unknown = ["sending", "unknown"].includes(persisted.status) && !e.known;
        a.status = unknown ? "unknown" : e.stopped ? "stopped" : "failed";
        a.error = e.status
          ? e.message
          : e.known
            ? e.message
            : "本次音频未能完整确认，保留记录，请核对后手动处理";
        saveAttempt(a, job.id);
        if (s && active(store.get("jobs", job.id))) {
          s = store.get("segments", a.segmentId);
          s.latest = a.status;
          store.put("segments", s, job.chapterId);
          domain.enhancement?.syncLegacySegment(s);
        }
        job.error = a.error;
        if (unknown) job.stop = true;
      }
      job.done = store.all("attempts", job.id).filter(a => a.status === "success").length;
      const latest = store.get("jobs", job.id);
      if (!active(latest)) return;
      job.stop = job.stop || latest.stop;
      setJob(job);
    }
    const attempts = store.all("attempts", job.id);
    job.status = attempts.every((a) => a.status === "success")
      ? "success"
      : attempts.some((a) => a.status === "unknown")
        ? "unknown"
        : attempts.some((a) => a.status === "failed")
          ? "failed"
          : "stopped";
  }
  async function render(job) {
    const c = store.get("chapters", job.chapterId);
    const isCurrent = () => active(store.get("jobs", job.id)) && store.get("chapters", c.id).arrangement === job.arrangement;
    const rows = domain.enhancement?.resolve(c.id) || domain.list(c.id).filter(s => !s.excluded).map(s => ({s,a:s.current && store.maybe("audios",s.current)}));
    for (const [index,{s,a}] of rows.entries()) {
      if (!a || !await validateStoredAudio(store, a)) fail(`第 ${(s.order ?? index) + 1} 条音频损坏或缺失，请先恢复文件`);
    }
    let master = store
      .all("masters", c.id)
      .find(
        (m) =>
          !m.invalid && !m.superseded &&
          m.arrangement === c.arrangement &&
          existsSync(join(store.directory, m.path)),
      );
    if (master) {
      try {
        const meta = await inspect(join(store.directory, master.path));
        if (Math.abs(meta.duration * 48000 - master.frames) > 1)
          throw new Error("frames");
      } catch {
        master.invalid = true;
        store.put("masters", master, c.id);
        master = null;
      }
    }
    if (!master) {
      const id = uid();
      const info = await buildMaster(store, rows, c.gap, id);
      master = {
        id,
        jobId: job.id,
        superseded: !isCurrent(),
        chapterId: c.id,
        arrangement: c.arrangement,
        ...info,
        createdAt: new Date().toISOString(),
      };
      store.put("masters", master, c.id);
      if (master.superseded) fail("旧构建已保留，未替换当前母版");
    }
    if (job.kind === "export") {
      if (!isCurrent()) fail("构建任务或编排已失效，请按当前版本重新准备");
      const id = uid(),
        path = await exportMaster(store, master, id, job.format);
      const superseded = !isCurrent();
      store.put(
        "exports",
        {
          id,
          jobId: job.id,
          superseded,
          path,
          format: job.format,
          chapterId: c.id,
          arrangement: c.arrangement,
          masterId: master.id,
          confirmation: job.confirmation,
          createdAt: new Date().toISOString(),
        },
        c.id,
      );
      if (superseded) fail("旧导出已保留，未替换当前结果");
    }
    job.done = job.total;
    job.status = "success";
  }
  async function tick() {
    if (running || closing) return;
    const job = store.all("jobs").find((j) => j.status === "queued");
    if (!job) return;
    running = true;
    job.status = "running";
    setJob(job);
    try {
      if (["generate", "voice-test", "voice-create", "unit-generate"].includes(job.kind)) await generate(job);
      else await render(job);
    } catch (e) {
      job.status = "failed";
      job.error = e.message;
    } finally {
      if (active(store.get("jobs", job.id))) {
        job.finishedAt = new Date().toISOString();
        setJob(job);
      }
      running = false;
    }
  }
  async function recover() {
    for (const j of store.all("jobs")) {
      const interrupted = active(j);
      for (const a of store.all("attempts", j.id)) {
        const file = join(store.directory, a.path || `audio/${a.id}.wav`);
        // Only the completed, decoded response is renamed to this final path; .part never qualifies.
        if (
          ["sending", "unknown"].includes(a.status) &&
          !store.maybe("audios", a.id) && !file.endsWith(".part") && existsSync(file)
        ) {
          try {
            register(a, await inspect(file));
            continue;
          } catch {}
        }
        if (!interrupted) {
          if ((a.quota?.state === "reserved" || a.grantReservation?.state === 'reserved') && ["queued", "failed", "stopped"].includes(a.status))
            store.transaction(() => { moveQuota(a, "released"); store.put("attempts", a, j.id); });
          continue;
        }
        if (["queued", "sending"].includes(a.status)) {
          a.status = a.status === "sending" ? "unknown" : "stopped";
          saveAttempt(a, j.id);
          if (a.segmentId) {
            const s = store.get("segments", a.segmentId);
            s.latest = a.status;
            store.put("segments", s, j.chapterId);
            domain.enhancement?.syncLegacySegment(s);
          }
        }
      }
      if (!interrupted) continue;
      const recovered = store.all("attempts", j.id);
      j.finishedAt = new Date().toISOString();
      if (recovered.length && recovered.every((a) => a.status === "success")) {
        j.status = "success";
        j.done = j.total;
        setJob(j);
        continue;
      }
      j.status = recovered.some((a) => a.status === "unknown")
        ? "unknown"
        : "stopped";
      j.error = "服务曾中断；未自动重发请求，请核对后新建任务";
      setJob(j);
    }
  }
  return {
    enqueue,
    async submit(p) {
      const existing = existingCommand(p);
      if (existing) return existing;
      let checked;
      // Decode every required file before accepting the batch; enqueue rechecks revisions and locks after awaits.
      if (p.kind === "voice-test" || !p.kind || p.kind === "generate") {
        const rows = p.kind === "voice-test" ? [{ voiceId: p.voiceId }] : preflight(domain.editable(p.chapterId, p.revision), p.ids || [], p.whole);
        for (const id of new Set(rows.map(s => s.voiceId))) {
          const v = store.get("voices", id);
          if (["stopped", "deleted"].includes(v.state) || !v.path) fail("参考声音已停用或删除");
          try { await inspectReference(v); }
          catch { fail(`参考声音「${v.name || id}」损坏或缺失，或不符合 30 秒/10 MB 规格；本批尚未入队`); }
        }
      } else if (p.kind === "unit-generate") {
        checked = prepareEnhancement(p);
        for (const id of new Set(checked.attempts.flatMap(referenceIds))) {
          const v = store.get("voices", id);
          if (["stopped", "deleted"].includes(v.state) || !v.path) fail("参考声音已停用或删除");
          try { await inspectReference(v); }
          catch { fail(`参考声音「${v.name || id}」损坏或缺失，或不符合 30 秒/10 MB 规格；本批尚未入队`); }
        }
      } else if (["master", "export"].includes(p.kind)) {
        const c = domain.editable(p.chapterId, p.revision);
        const rows = domain.enhancement?.resolve(c.id) || domain.list(c.id).filter(s => !s.excluded).map(s => ({s,a:segmentStatus(store,s).audio}));
        for (const [index,{s,a}] of rows.entries()) {
          if (!a) fail(`第 ${(s.order ?? index) + 1} 条没有音频`);
          if (!await validateStoredAudio(store, a)) fail(`第 ${(s.order ?? index) + 1} 条音频损坏或缺失，请恢复备份或明确重做；本批未提交`);
        }
      }
      return enqueue(p, checked);
    },
    tick,
    recover,
    close() {
      closing = true;
      for (const j of store.all("jobs").filter((j) => j.status === "queued")) {
        for (const a of store.all("attempts", j.id)) {
          a.status = "stopped";
          saveAttempt(a, j.id);
          if (a.segmentId) {
            const s = store.get("segments", a.segmentId);
            s.latest = "stopped";
            store.put("segments", s, j.chapterId);
            domain.enhancement?.syncLegacySegment(s);
          }
        }
        j.status = "stopped";
        j.finishedAt = new Date().toISOString();
        setJob(j);
      }
    },
    get running() {
      return running;
    },
    get routeBlocked() {
      return routeBlocked();
    },
  };
}
