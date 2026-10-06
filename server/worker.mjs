import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync, createWriteStream, statSync } from "node:fs";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { join, dirname } from "node:path";
import { createLocalPool, createFairPicker, createReferenceCache, referenceVersion, hasNewerAttempt } from './scheduler.mjs';
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
import { sealAudioDelivery, prepareAudioDelivery, hasAudioDelivery, saveAudioAttempt } from './audio-delivery.mjs';
import { fail, same, uid } from "./store.mjs";
import { templateCatalog, templateOf } from "./templates.mjs";
import { configurationDecided, attemptScope, relatedTarget, outstandingAttempts, reserveGrant, settleGrant } from './experience.mjs';

export function createWorker(store, domain, config) {
  if (config.callLimit !== undefined && (!Number.isSafeInteger(config.callLimit) || config.callLimit < 1)) fail("本地调用额度应为正整数");
  const quotaScope = config.usageScope || "audio-calls-v1";
  if (typeof quotaScope !== "string" || !quotaScope || quotaScope.length > 100) fail("调用额度范围无效");
  for (const [name, max] of [['audioConcurrency',8],['routeConcurrencyCap',8],['localAudioConcurrency',2]])
    if (config[name] !== undefined && (!Number.isSafeInteger(config[name]) || config[name] < 1 || config[name] > max)) fail(`${name} 应为1至${max}的整数`);
  if (config.audioStartIntervalMs !== undefined && (!Number.isSafeInteger(config.audioStartIntervalMs) || config.audioStartIntervalMs < 0 || config.audioStartIntervalMs > 60000)) fail('发送间隔应为0至60000毫秒');
  for (const name of ['timeout', 'audioResponseTimeoutMs', 'audioReceiveTimeoutMs'])
    if (config[name] !== undefined && (!Number.isSafeInteger(config[name]) || config[name] < 1 || config[name] > 2147483647)) fail(`${name} 应为有效的正整数毫秒数`);
  const local = createLocalPool(config.localAudioConcurrency || 1), picker = createFairPicker();
  const executing = new Map(), renders = new Map(), idleWaiters = [];
  const referenceCache = createReferenceCache(store.directory, local, inspectReference, config.referenceCacheBytes);
  const audioKinds = new Set(['generate','voice-test','voice-create','unit-generate']);
  const responseLimit = 100 * 1024 * 1024, pendingLimit = config.maxPendingAudio || 8, pendingBytesLimit = config.maxPendingAudioBytes || 800 * 1024 * 1024;
  if (!Number.isSafeInteger(pendingLimit) || pendingLimit < 1 || !Number.isSafeInteger(pendingBytesLimit) || pendingBytesLimit < responseLimit) fail('音频积压上限无效');
  let closing = false, localRecovery = false, admissionStopped = false, storageBlocked = false, schedulingError = "", pumping = false, nextSendAt = 0, timer;
  const desiredConcurrency = () => store.maybe('settings','scheduler')?.desiredAudioConcurrency ?? config.audioConcurrency ?? 1;
  const concurrency = () => Math.min(Number.isSafeInteger(desiredConcurrency()) ? Math.max(1, Math.min(8, desiredConcurrency())) : 1, config.routeConcurrencyCap || 1, pendingLimit, Math.floor(pendingBytesLimit / responseLimit));
  const networkActive = () => [...executing.values()].filter(item => item.network).length;
  const busy = () => executing.size > 0 || renders.size > 0 || localRecovery || local.active > 0 || local.queued > 0 || !!timer;
  const routeBlocked = () => !!store.maybe("settings", "audio-route")?.blocked;
  const setRouteBlocked = (blocked, details = {}) => store.put("settings", { id: "audio-route", blocked, ...details });
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
  function acknowledgeUnknown(job, attempts, p) {
    const local = store.all('attempts').filter(a => a.status !== 'success' && a.deliveryVersion &&
      (a.phase === 'localRecoveryPending' || hasAudioDelivery(store, a)) && attempts.some(target => relatedTarget(store, target, a)));
    if (local.length) fail('原件已完整接收，请先免费恢复本地处理，不要重新请求模型', 409,
      { code: 'raw-received-local-pending', retryClass: 'recover-local', scope: { kind: 'attempt', ids: local.map(a => a.id) } });
    const history = store.all('attempts');
    attempts.forEach((a, ordinal) => {
      a.ordinal = ordinal; a.phase = 'queued';
      a.generationEpoch = 1 + Math.max(0, ...history.filter(old => relatedTarget(store, a, old)).map(old => old.generationEpoch || 0));
    });
    const ids=outstandingAttempts(store,attempts,undefined,true).map(a=>a.id);
    if (p.acknowledgedAttemptIds !== undefined && (!Array.isArray(p.acknowledgedAttemptIds) || !same([...p.acknowledgedAttemptIds].sort(),[...ids].sort()))) fail('结果不明的请求范围已变化，请重新核对后决定',409);
    if (ids.length && p.retryUnknown !== true) fail('所选包含结果不明的请求，需明确确认可能重复计费');
    job.acknowledgedAttemptIds=ids;
    job.targetScopes=attempts.map(attemptScope);
    job.requestCount=attempts.length;
    for (const a of attempts) a.acknowledgedAttemptIds=ids.filter(id=>relatedTarget(store,store.get('attempts',id),a));
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
    if (a.phase !== 'localRecoveryPending') a.phase = a.status === 'stopped' ? 'stoppedNotSent' :
      a.status === 'failed' ? a.createdAt ? 'rejected' : 'rejectedNotSent' : a.status === 'unknown' ? 'outcomeUnknown' : a.phase;
    store.transaction(() => {
      if (["stopped", "failed"].includes(a.status)) moveQuota(a, "released");
      saveAudioAttempt(store, a, jobId);
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
      if (p.resumeRoute) storageBlocked = false;
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
        acknowledgeUnknown(job,attempts,p);
        reserve(attempts,p);
        setJob(job);
        for (const a of attempts) {
          saveAudioAttempt(store, a, job.id);
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
        const attempt = {
          id: uid(),
          jobId: job.id,
          input,
          prompt: compile(input),
          status: "queued",
          model: config.model,
          targetKind: "voice-test", targetId: v.id,
        };
        acknowledgeUnknown(job,[attempt],p);
        reserve([attempt],p);
        setJob(job);
        saveAudioAttempt(store, attempt, job.id);
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
        acknowledgeUnknown(job,attempts,p);
        reserve(attempts,p);
        setJob(job);
        for (const a of attempts) saveAudioAttempt(store, a, job.id);
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
      if (audio.originalAudioId) {
        const original = { ...audio, id: audio.originalAudioId, path: audio.delivery.rawPath,
          ...audio.delivery.mediaMetadata, provenance: 'provider-original', sourceAttemptId: attempt.id };
        delete original.originalAudioId; delete original.processing; delete original.tailRepair;
        store.put("audios", original, c?.id || "");
      }
      store.put("audios", audio, c?.id || "");
      attempt.phase = "registered";
      delete attempt.localError; delete attempt.error;
      if (["candidate", "unit"].includes(attempt.targetKind)) {
        attempt.adopted = domain.enhancement.register(j, attempt, audio);
        attempt.status = "success";
        saveAudioAttempt(store, attempt, j.id);
        return;
      }
      if (!s) {
        const v = store.get("voices", attempt.input.voiceId);
        const newer = hasNewerAttempt(store.all("attempts"), attempt, a => !a.segmentId && a.input.voiceId === v.id);
        attempt.selectedAsSample = active(j) && j.voiceRevision === (v.revision ?? 1) && !newer && !v.deletePending && v.state !== "deleted";
        if (attempt.selectedAsSample) {
          v.sampleAudioId = audio.id;
          store.put("voices", v);
        }
        attempt.status = "success";
        saveAudioAttempt(store, attempt, j.id);
        return;
      }
      const newer = hasNewerAttempt(store.all("attempts"), attempt, a => a.segmentId === s.id);
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
      saveAudioAttempt(store, attempt, j.id);
    });
  }
  function claimAttempt(id) {
    return store.transaction(() => {
      const a = store.get('attempts', id), j = store.get('jobs', a.jobId);
      if (!active(j) || a.status !== 'queued' || a.ownerToken) return null;
      a.ownerToken = uid(); a.claimedAt = new Date().toISOString(); a.phase = 'preparing';
      saveAudioAttempt(store, a, j.id); j.status = 'running'; setJob(j); return a;
    });
  }
  function updateCounts(job, attempts) {
      job.done = attempts.filter(a => a.status === 'success').length;
      job.counts = { queued: 0, preparing: 0, inFlight: 0, local: 0, success: 0, failed: 0, unknown: 0, stopped: 0 };
      for (const a of attempts) {
        const bucket = a.status === 'queued' ? a.phase === 'preparing' ? 'preparing' : 'queued' :
          a.status === 'sending' ? ['rawSealed','processing'].includes(a.phase) ? 'local' : 'inFlight' : a.status;
        if (bucket in job.counts) job.counts[bucket]++;
      }
  }
  function summarize(jobId, pending = false) {
    return store.transaction(() => {
      const job = store.get('jobs', jobId);
      if (!active(job)) return job;
      const attempts = store.all('attempts', jobId);
      updateCounts(job, attempts);
      if (!pending && !attempts.some(a => ['queued','sending'].includes(a.status))) {
        job.status = attempts.every(a => a.status === 'success') ? 'success' : attempts.some(a => a.status === 'unknown') ? 'unknown' :
          attempts.some(a => a.status === 'failed') ? 'failed' : 'stopped';
        job.finishedAt = new Date().toISOString();
      }
      setJob(job); return job;
    });
  }
  async function executeAttempt(job, a, onSealed = () => {}) {
      const leases = [];
      const started = performance.now(); let sentAt, receivedAt, localAt, networkTimer;
      const controller = new AbortController();
      const deadline = (phase, milliseconds) => {
        clearTimeout(networkTimer);
        networkTimer = setTimeout(() => { a.timeoutPhase = phase; controller.abort(new DOMException(phase === 'upstream' ? '等待音频响应超时' : '接收音频超时', 'TimeoutError')); }, milliseconds);
      };
      const fresh = store.get('jobs', job.id);
      let s = a.segmentId ? store.get("segments", a.segmentId) : null;
      if (fresh.stop || routeBlocked() || closing) {
        a.status = "stopped";
        if (s) {
          s.latest = "stopped";
          store.put("segments", s, job.chapterId);
          domain.enhancement?.syncLegacySegment(s);
        }
        saveAttempt(a, job.id);
        return;
      }
      try {
        for (const id of referenceIds(a)) {
          const voice = store.get('voices', id);
          if (!['active','archived'].includes(voice.state) || voice.deletePending || !voice.path)
            throw Object.assign(new Error('参考已停用，尚未发送的请求已停止'), { status: 400, stopped: true });
          try { leases.push(await referenceCache.acquire(voice)); }
          catch (e) { if (e.status) throw e; fail('参考声音损坏或不可解码，本条未发送'); }
        }
        const references = leases.map(item => item.payload);
        a.referenceAssets = leases.map(item => item.asset);
        const dispatch = store.transaction(() => {
          const latest = store.get("jobs", job.id);
          if (!active(latest) || store.get("attempts", a.id).status !== "queued" || store.get("attempts", a.id).ownerToken !== a.ownerToken) return false;
          if (latest.stop || closing || routeBlocked())
            throw Object.assign(new Error("尚未提交的请求已停止"), { status: 400, stopped: true });
          const unresolved=outstandingAttempts(store,[a],undefined,true).map(v=>v.id);
          if (unresolved.some(id=>!(a.acknowledgedAttemptIds || []).includes(id))) fail('结果不明的请求范围已变化，本条未发送，请重新明确决定',409);
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
          for (const asset of a.referenceAssets) {
            const voice = store.get('voices', asset.voiceId);
            if (voice.path !== asset.path || referenceVersion(statSync(join(store.directory, voice.path))) !== asset.fileVersion)
              fail('参考素材在发送前已变化，本条未发送', 409);
          }
          a.status = "sending";
          a.deliveryVersion = 1;
          a.phase = "sending";
          moveQuota(a, "used");
          a.createdAt = new Date().toISOString();
          saveAudioAttempt(store, a, job.id);
          domain.enhancement?.setAttemptStatus(latest, a, "running");
          if (s) {
            s.latest = "running";
            store.put("segments", s, job.chapterId);
            domain.enhancement?.syncLegacySegment(s);
          }
          return true;
        });
        if (!dispatch) return;
        sentAt = performance.now();
        a.timings = { preparingMs: sentAt - started };
        deadline('upstream', config.audioResponseTimeoutMs ?? config.timeout ?? 180000);
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
          signal: controller.signal,
        });
        receivedAt = performance.now(); a.timings.upstreamMs = receivedAt - sentAt;
        deadline('receiving', config.audioReceiveTimeoutMs ?? config.timeout ?? 180000);
        if (!response.ok) {
          a.httpStatus = response.status;
          let durationError = false;
          try {
            let errorText = '', bytes = 0;
            for await (const chunk of Readable.fromWeb(response.body, { signal: controller.signal })) {
              bytes += chunk.length;
              if (bytes > 64 * 1024) break;
              errorText += chunk.toString('utf8');
            }
            durationError = ![401, 403, 429].includes(response.status) && /\bDurationOutOfRange\b/.test(errorText);
          } catch {} // An unreadable error body keeps the existing HTTP protection.
          if (durationError) a.providerErrorCode = 'DurationOutOfRange';
          if (!durationError && [401, 402, 403, 429].includes(response.status)) {
            const retry = response.headers.get('retry-after');
            a.retryAfterSeconds = retry ? Math.max(0, Number.isFinite(Number(retry)) ? Number(retry) : (Date.parse(retry) - Date.now()) / 1000) : undefined;
            setRouteBlocked(true, { status: response.status, reason: response.status === 429 ? 'rate-or-quota-limit' : 'permission-or-quota',
              ...(Number.isFinite(a.retryAfterSeconds) ? { retryAfterSeconds: a.retryAfterSeconds } : {}) });
          }
          throw Object.assign(
            new Error(
              durationError ? '音频服务拒绝本条时长：参考须不超过30秒，输出不超过120秒；请拆短正文后再生成，短句仍失败时请核对参考素材。' : `音频服务返回 ${response.status}，请检查权限、额度或稍后手动重试`,
            ),
            { known: durationError || response.status < 500 },
          );
        }
        a.phase = "receiving"; saveAudioAttempt(store, a, job.id);
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
          Readable.fromWeb(response.body, { signal: controller.signal }),
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
        clearTimeout(networkTimer);
        localAt = performance.now(); a.timings.receivingMs = localAt - receivedAt;
        await local.run(() => sealAudioDelivery(store, a, size, response));
        onSealed(size);
        await local.run(async () => {
          const metadata = await prepareAudioDelivery(store, a);
          a.timings.localMs = performance.now() - localAt; a.timings.totalMs = performance.now() - started;
          register(a, metadata);
        });
      } catch (e) {
        const persisted = store.get("attempts", a.id);
        a.quota = persisted.quota;
        a.createdAt = persisted.createdAt;
        if (hasAudioDelivery(store, a)) a.phase = "localRecoveryPending";
        if (localAt !== undefined || e.code === "ENOSPC") storageBlocked = true;
        const unknown = ["sending", "unknown"].includes(persisted.status) && !e.known;
        a.status = unknown ? "unknown" : e.stopped ? "stopped" : "failed";
        a.error = e.status
          ? e.message
          : e.known
            ? e.message
            : "本次音频未能完整确认，保留记录，请核对后手动处理";
        if (a.phase === 'localRecoveryPending') {
          a.error = '原件已完整接收，本地处理或登记未完成；请免费恢复，不需要重新生成';
          a.localError = e.message;
        }
        saveAttempt(a, job.id);
        if (s && active(store.get("jobs", job.id))) {
          s = store.get("segments", a.segmentId);
          s.latest = a.status;
          store.put("segments", s, job.chapterId);
          domain.enhancement?.syncLegacySegment(s);
        }
        store.transaction(() => {
          const latest = store.get('jobs', job.id);
          if (!active(latest)) return;
          latest.error = a.error;
          if (unknown) latest.stop = true;
          setJob(latest);
        });
      } finally { clearTimeout(networkTimer); controller.abort(); for (const lease of leases) lease.release(); }
  }
  function rememberOutput(job,kind,record) {
    const current=store.get('jobs',job.id);
    if(!active(current)||current.stop)return false;
    job.outputRecords={...job.outputRecords,[kind]:record};
    job.masterId=kind==='master'?record.id:record.masterId;
    if(kind==='export')job.exportId=record.id;
    job.result={chapterId:job.chapterId,arrangement:job.arrangement,masterId:job.masterId,...(job.exportId?{exportId:job.exportId,format:job.format}:{})};
    job.localOutputPending=true;
    setJob({...current,outputRecords:job.outputRecords,masterId:job.masterId,...(job.exportId?{exportId:job.exportId}:{}),result:job.result,localOutputPending:true});return true;
  }
  async function recoverOutputs(job) {
    if(!['master','export'].includes(job.kind))return false;
    const before=JSON.stringify(job);
    for(const [kind,record]of Object.entries(job.outputRecords || {})) {
      const table=kind==='master'?'masters':kind==='export'?'exports':null;
      if(!table || record.chapterId!==job.chapterId || record.arrangement!==job.arrangement || !record.id || !record.path || !existsSync(join(store.directory,record.path)))continue;
      if(!store.maybe(table,record.id)) {
        try {const meta=await inspect(join(store.directory,record.path));if(kind==='master'&&Math.abs(meta.duration*48000-record.frames)>1)continue;}
        catch {continue;}
        store.put(table,record,job.chapterId);
      }
    }
    let masters=store.all('masters',job.chapterId).filter(m=>m.id===(job.masterId||job.result?.masterId||job.outputRecords?.master?.id)||m.jobId===job.id);
    const exports=store.all('exports',job.chapterId).filter(e=>e.id===(job.exportId||job.result?.exportId)||e.jobId===job.id);
    if(!masters.length&&job.kind==='master'&&job.status==='success')masters=store.all('masters',job.chapterId).filter(m=>m.arrangement===job.arrangement&&!m.invalid&&!m.superseded&&existsSync(join(store.directory,m.path)));
    const exported=exports.length===1&&exports[0].format===job.format?exports[0]:null;
    const master=exported?store.maybe('masters',exported.masterId):masters.length===1?masters[0]:null;
    if(!master || master.arrangement!==job.arrangement || master.invalid || !existsSync(join(store.directory,master.path)) || job.kind==='export'&&(!exported || !existsSync(join(store.directory,exported.path))))return false;
    job.masterId=master.id;if(exported)job.exportId=exported.id;
    job.result={chapterId:job.chapterId,arrangement:job.arrangement,masterId:master.id,...(exported?{exportId:exported.id,format:exported.format}:{})};
    if((active(job)||job.localOutputPending)&&!job.stop&&!master.superseded&&!exported?.superseded) {job.status='success';job.done=job.total;job.finishedAt=new Date().toISOString();delete job.error;}
    job.localOutputPending=false;if(JSON.stringify(job)!==before)setJob(job);return true;
  }
  async function render(job) {
    const c = store.get("chapters", job.chapterId);
    const isCurrent = () => {const current=store.get('jobs',job.id);return active(current)&&!current.stop&&store.get("chapters", c.id).arrangement === job.arrangement;};
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
      if (!isCurrent()) fail('构建任务或编排已失效，请按当前版本重新准备');
      const id = job.masterId || uid();
      job.masterId=id;setJob({...store.get('jobs',job.id),masterId:id});
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
      rememberOutput(job,'master',master);
      store.put("masters", master, c.id);
      if (master.superseded) {job.localOutputPending=false;fail("旧构建已保留，未替换当前母版");}
    }
    if(job.masterId!==master.id || !job.outputRecords?.master)rememberOutput(job,'master',master);
    if (job.kind === "export") {
      if (!isCurrent()) fail("构建任务或编排已失效，请按当前版本重新准备");
      const id = job.exportId || uid();job.exportId=id;setJob({...store.get('jobs',job.id),exportId:id});
      const path = await exportMaster(store, master, id, job.format);
      const superseded = !isCurrent();
      const output={id,jobId:job.id,superseded,path,format:job.format,chapterId:c.id,arrangement:c.arrangement,masterId:master.id,confirmation:job.confirmation,createdAt:new Date().toISOString()};
      rememberOutput(job,'export',output);
      store.put(
        "exports",
        output,
        c.id,
      );
      if (superseded) {job.localOutputPending=false;fail("旧导出已保留，未替换当前结果");}
    }
    job.done = job.total;
    job.status = "success";
    job.localOutputPending=false;
  }
  const pendingJob = id => [...executing.values()].some(item => item.jobId === id);
  function stopQueued(job) {
    for (const a of store.all('attempts', job.id)) {
      if (a.status !== 'queued' || executing.has(a.id)) continue;
      a.status = 'stopped'; saveAttempt(a, job.id);
      if (a.segmentId) {
        const segment = store.get('segments', a.segmentId); segment.latest = 'stopped';
        store.put('segments', segment, job.chapterId); domain.enhancement?.syncLegacySegment(segment);
      }
    }
    summarize(job.id, pendingJob(job.id));
  }
  function wakeIdle() {
    if (!busy()) for (const wake of idleWaiters.splice(0)) wake();
  }
  function launch(job, queued) {
    const a = claimAttempt(queued.id);
    if (!a) return false;
    const latest = store.get('jobs', job.id);
    const item = { jobId: job.id, network: true, bytes: responseLimit }; executing.set(a.id, item);
    item.promise = executeAttempt(latest, a, bytes => { item.network = false; item.bytes = bytes; pump(); })
      .catch(() => { storageBlocked = true; schedulingError = '本地任务登记未完成，请核对存储后恢复'; })
      .finally(() => {
        executing.delete(a.id);
        try { summarize(job.id, pendingJob(job.id)); }
        catch { storageBlocked = true; schedulingError = '本地任务汇总未完成，请核对存储后恢复'; }
        pump(); wakeIdle();
      });
    return true;
  }
  function pump() {
    if (pumping || localRecovery) return;
    pumping = true;
    try {
      let jobs = store.all('jobs').filter(active);
      if (closing || admissionStopped) for (const job of jobs.filter(j => j.status === 'queued' && !audioKinds.has(j.kind))) {
        job.status = 'stopped'; job.finishedAt = new Date().toISOString(); setJob(job);
      }
      for (const job of jobs.filter(j => audioKinds.has(j.kind)))
        if (job.stop || routeBlocked() || closing || admissionStopped || storageBlocked) stopQueued(job);
      if (!closing && !admissionStopped && !storageBlocked && !routeBlocked()) {
        while (networkActive() < concurrency() && executing.size < pendingLimit &&
          [...executing.values()].reduce((sum, item) => sum + item.bytes, 0) + responseLimit <= pendingBytesLimit) {
          jobs = store.all('jobs').filter(j => active(j) && !j.stop && audioKinds.has(j.kind)).map(j => ({ ...j,
            inFlight: pendingJob(j.id), next: store.all('attempts', j.id).find(a => a.status === 'queued' && !a.ownerToken) })).filter(j => j.next);
          const job = picker(jobs); if (!job) break;
          const wait = nextSendAt - performance.now();
          if (wait > 0) { if (!timer) timer = setTimeout(() => { timer = undefined; pump(); wakeIdle(); }, wait); break; }
          if (!launch(job, job.next)) break;
          nextSendAt = performance.now() + (config.audioStartIntervalMs ?? 100);
        }
      }
      if (!closing && !admissionStopped) {
        const job = store.all('jobs').find(j => j.status === 'queued' && !audioKinds.has(j.kind) && !renders.has(j.id));
        if (job && !renders.size) {
          job.status = 'running'; setJob(job);
          const promise = local.run(async () => {
            try { await render(job); } catch (error) { job.status = 'failed'; job.error = error.message; }
            if (active(store.get('jobs', job.id))) { job.finishedAt = new Date().toISOString(); setJob(job); }
          });
          renders.set(job.id, promise);
          promise.finally(() => { renders.delete(job.id); pump(); wakeIdle(); }).catch(() => {});
        }
      }
    } catch { storageBlocked = true; schedulingError = '本地调度未完成，请核对存储后恢复'; }
    finally { pumping = false; }
  }
  async function tick() {
    const alreadyRunning = busy(); pump();
    if (alreadyRunning) return;
    while (busy() || timer) await new Promise(resolve => idleWaiters.push(resolve));
  }
  async function drain() {
    while (busy() || timer) await new Promise(resolve => idleWaiters.push(resolve));
  }
  async function recover() {
    for (const j of store.all("jobs")) {
      if(await recoverOutputs(j))continue;
      const interrupted = active(j);
      for (const a of store.all("attempts", j.id)) {
        const file = join(store.directory, a.path || `audio/${a.id}.wav`);
        // New deliveries require a matching completion receipt. Legacy final files
        // remain recoverable as history, without claiming an unprocessed original.
        if (
          ["sending", "unknown"].includes(a.status) &&
          !store.maybe("audios", a.id) && (a.deliveryVersion ? hasAudioDelivery(store, a) : !file.endsWith(".part") && existsSync(file))
        ) {
          try {
            register(a, await prepareAudioDelivery(store, a));
            continue;
          } catch (error) {
            if (a.deliveryVersion && hasAudioDelivery(store, a)) {
              a.phase = "localRecoveryPending"; a.error = error.message;
              saveAudioAttempt(store, a, j.id);
            }
          }
        }
        if (!interrupted) {
          if ((a.quota?.state === "reserved" || a.grantReservation?.state === 'reserved') && ["queued", "failed", "stopped"].includes(a.status))
            store.transaction(() => { moveQuota(a, "released"); saveAudioAttempt(store, a, j.id); });
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
      updateCounts(j, recovered);
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
          try { await local.run(() => inspectReference(v)); }
          catch { fail(`参考声音「${v.name || id}」损坏或缺失，或不符合 30 秒/10 MB 规格；本批尚未入队`); }
        }
      } else if (p.kind === "unit-generate") {
        checked = prepareEnhancement(p);
        for (const id of new Set(checked.attempts.flatMap(referenceIds))) {
          const v = store.get("voices", id);
          if (["stopped", "deleted"].includes(v.state) || !v.path) fail("参考声音已停用或删除");
          try { await local.run(() => inspectReference(v)); }
          catch { fail(`参考声音「${v.name || id}」损坏或缺失，或不符合 30 秒/10 MB 规格；本批尚未入队`); }
        }
      } else if (["master", "export"].includes(p.kind)) {
        const c = domain.editable(p.chapterId, p.revision);
        const rows = domain.enhancement?.resolve(c.id) || domain.list(c.id).filter(s => !s.excluded).map(s => ({s,a:segmentStatus(store,s).audio}));
        for (const [index,{s,a}] of rows.entries()) {
          if (!a) fail(`第 ${(s.order ?? index) + 1} 条没有音频`);
          if (!await local.run(() => validateStoredAudio(store, a))) fail(`第 ${(s.order ?? index) + 1} 条音频损坏或缺失，请恢复备份或明确重做；本批未提交`);
        }
      }
      return enqueue(p, checked);
    },
    tick,
    recover,
    getActivity() {
      return { active: busy(), storageBlocked, schedulingError, routeBlocked: routeBlocked(), accepting: !closing && !admissionStopped && !storageBlocked && !routeBlocked(), desiredAudioConcurrency: desiredConcurrency(),
        effectiveAudioConcurrency: concurrency(), routeConcurrencyCap: config.routeConcurrencyCap || 1,
        queuedAttempts: store.all('attempts').filter(a => a.status === 'queued' && a.phase !== 'preparing' && active(store.maybe('jobs', a.jobId) || {})).length,
        networkActive: networkActive(), attemptsActive: executing.size, localActive: local.active, localQueued: local.queued, localPeak: local.peak,
        rendersActive: renders.size, localRecovery, pendingAudioBytes: [...executing.values()].reduce((sum,item) => sum + item.bytes,0),
        referenceCacheBytes: referenceCache.bytes, referenceCachePeakBytes: referenceCache.peak,
        phaseCounts: store.all('attempts').filter(a => executing.has(a.id)).reduce((counts,a) => ({...counts,[a.phase]:(counts[a.phase] || 0)+1}),{}) };
    },
    stopAdmission() { admissionStopped = true; if (timer) { clearTimeout(timer); timer = undefined; } pump(); wakeIdle(); },
    drain,
    get referenceReads() { return referenceCache.reading; },
    async recoverLocal(attemptId) {
      if (busy() || localRecovery || closing) fail('本地工作正在进行，请稍后恢复', 409);
      const a = store.get('attempts', attemptId);
      if (store.maybe('audios', a.id)) return store.get('audios', a.id);
      if (!a.deliveryVersion || !hasAudioDelivery(store, a)) fail('未找到完整接收凭据，不能按原件恢复', 409);
      localRecovery = true;
      try {
        register(a, await local.run(() => prepareAudioDelivery(store, a)));
        storageBlocked = false;
        return store.get('audios', a.id);
      } catch (error) {
        a.phase = 'localRecoveryPending'; a.localError = error.message;
        saveAudioAttempt(store, a, a.jobId);
        throw error;
      } finally { localRecovery = false; pump(); wakeIdle(); }
    },
    close() {
      closing = true;
      if (timer) { clearTimeout(timer); timer = undefined; }
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
      pump(); wakeIdle();
    },
    get running() {
      return busy();
    },
    get routeBlocked() {
      return routeBlocked();
    },
  };
}
