import http from "node:http";
import { readFile, stat, writeFile, rm, mkdir } from "node:fs/promises";
import { existsSync, createReadStream } from "node:fs";
import { join, resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { openStore, fail } from "./store.mjs";
import { createDomain, textModel } from "./domain.mjs";
import { createWorker } from "./worker.mjs";
import {
  uploadVoice,
  saveCandidateVoice,
  toolsAvailable,
  drainReferenceDeletes,
  validateStoredAudio,
  inspect,
} from "./audio.mjs";
import { createAnalysis } from "./analysis.mjs";
import { createExperience } from './experience.mjs';
import { workspaceDirectory, workspaceIdentity, workspaceConfig as defaultWorkspaceConfig, copyWorkspace, saveWorkspaceLocation, recoverProjectFolders, chooseWorkspaceDirectory, readRuntime, workspaceDiagnostics } from './workspace.mjs';

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
if (existsSync(join(root, ".env.kunpo")))
  process.loadEnvFile(join(root, ".env.kunpo"));
if (existsSync(join(root, ".env"))) process.loadEnvFile(join(root, ".env"));
export function settings() {
  const base = (process.env.KUNPO_BASE_URL || "https://llm.ziy.cc/v1").replace(
    /\/$/,
    "",
  );
  return {
    key: process.env.KUNPO_API_KEY || "",
    audioUrl: base.replace(/\/v1$/, "") + "/v1/audio/speech",
    baseUrl: base.replace(/\/v1$/, "") + "/v1",
    model: process.env.KUNPO_TTS_MODEL || "seed-audio-1.0",
    ...(process.env.KUNPO_AUDIO_CALL_LIMIT ? { callLimit: Number(process.env.KUNPO_AUDIO_CALL_LIMIT) } : {}),
    usageScope: process.env.KUNPO_AUDIO_USAGE_SCOPE || "audio-calls-v1",
  };
}
export async function startServer({
  port = Number(process.env.PORT || 4318),
  directory = workspaceDirectory(),
  config = settings(),
  workspaceConfig = defaultWorkspaceConfig,
} = {}) {
  directory = resolve(directory);
  await mkdir(directory, { recursive: true });
  let runtime = join(directory, "runtime.json");
  if (existsSync(runtime)) {
    const { pid } = readRuntime(runtime);
    try {
      process.kill(pid, 0);
      throw new Error("此数据目录已有工作台服务，请使用现有服务");
    } catch (e) {
      if (e.code !== "ESRCH") throw e;
      await rm(runtime);
    }
  }
  await writeFile(runtime, JSON.stringify({ pid: process.pid, port }), {
    flag: "wx",
  });
  let store, domain, worker, analysis, experience, audioTools;
  try {
    store = openStore(directory);
    domain = createDomain(store);
    recoverProjectFolders(store);
    worker = createWorker(store, domain, config);
    analysis = createAnalysis(store, domain, config);
    experience = createExperience(store,domain,worker,analysis,config);
    await worker.recover();
    analysis.recover();
    audioTools = await toolsAvailable();
    if (audioTools) {
      const audios = store.all("audios");
      if (audios.length > 20) console.log(`正在校验已有音频（${audios.length} 份），原文件与历史保留，请稍候…`);
      for (const [i, a] of audios.entries()) {
        await validateStoredAudio(store, a);
        if (audios.length > 20 && (i + 1 === audios.length || (i + 1) % 25 === 0)) console.log(`音频校验：${i + 1} / ${audios.length}`);
      }
    }
  } catch (e) {
    if (analysis) await analysis.close();
    store?.close();
    await rm(runtime, { force: true });
    throw e;
  }
  const send = (res, status, data) => {
    if (status >= 400 || data?.error || data?.outcome === 'unknown') {
      const errorStatus = status >= 400 ? status : data.errorStatus || 500;
      const recovery = data.outcome === 'unknown' ? ['request-unknown', 'explicit-retry-unknown'] : {
        400: ['invalid-request', 'edit-request'], 401: ['permission-denied', 'review-permission'], 403: ['permission-denied', 'review-permission'],
        404: ['object-unavailable', 'review-target'], 409: ['state-conflict', 'refresh-and-review'], 413: ['request-too-large', 'edit-request'],
        416: ['invalid-range', 'review-target'], 503: ['service-unavailable', 'wait-for-service'],
      }[errorStatus] || ['operation-result-unconfirmed', 'check-existing-operation'];
      data = { ...data, code: data.code || recovery[0], scope: { kind: data.operationId ? 'operation' : 'request', path: (res.req.url || '').split('?')[0], ...data.dependencies, ...data.scope, ...(data.operationId ? { operationId: data.operationId } : {}) }, retryClass: data.retryClass || recovery[1] };
      if(status < 400 && data.retryClass === 'check-existing-operation') data.error = (data.error || '本次操作结果尚未确认。') + ' 请先查看现有记录并核对原操作，再决定下一步。';
    }
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(JSON.stringify(data));
  };
  async function body(req) {
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 15 * 1024 * 1024) fail("请求内容过大", 413);
      chunks.push(chunk);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      fail("请求内容不是有效 JSON");
    }
  }
  const referenceReads = new Map();
  let activeRequests = 0, moving = false, closing = false, movePromise = null, choosingDirectory = false;
  async function serveFile(req, res, file, type) {
    const info = await stat(file);
    const headers = {
      "Content-Type": type,
      "X-Content-Type-Options": "nosniff",
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-cache",
    };
    const range = req.headers.range;
    if (range) {
      const match = /^bytes=(\d+)-(\d*)$/.exec(range);
      if (!match) fail("音频范围无效", 416);
      const start = Number(match[1]),
        end = match[2]
          ? Math.min(Number(match[2]), info.size - 1)
          : info.size - 1;
      if (start > end || start >= info.size) fail("音频范围无效", 416);
      res.writeHead(206, {
        ...headers,
        "Content-Range": `bytes ${start}-${end}/${info.size}`,
        "Content-Length": end - start + 1,
      });
      createReadStream(file, { start, end }).on('error', () => res.destroy()).pipe(res);
    } else {
      res.writeHead(200, { ...headers, "Content-Length": info.size });
      createReadStream(file).on('error', () => res.destroy()).pipe(res);
    }
  }
  const server = http.createServer(async (req, res) => {
    let counted = false;
    try {
      const host = req.headers.host || "";
      if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host))
        fail("仅允许本机访问", 403);
      if (
        req.headers.origin &&
        ![
          "http://127.0.0.1:5173",
          "http://localhost:5173",
          `http://127.0.0.1:${port}`,
          `http://localhost:${port}`,
        ].includes(req.headers.origin)
      )
        fail("跨站请求已拒绝", 403);
      const path = new URL(req.url, `http://${host}`).pathname;
      if (moving || closing) fail('工作区正在迁移或停止，请稍后重试；未保存内容请保留', 503);
      activeRequests++;
      counted = true;
      if (req.method === 'POST' && path === '/api/workspace/choose') {
        if (choosingDirectory) fail('文件夹选择窗口已打开，请先完成选择', 409);
        choosingDirectory = true;
        try { return send(res, 200, { directory: await chooseWorkspaceDirectory() }); }
        finally { choosingDirectory = false; }
      }
      if (req.method === 'POST' && path === '/api/workspace/move') {
        const p = await body(req);
        if (p.source !== directory) fail('保存位置已改变，请重新打开设置后再操作', 409);
        if (activeRequests !== 1 || referenceReads.size || worker.running ||
            store.all('jobs').some(j => ['queued', 'running'].includes(j.status)) ||
            store.all('suggestions').some(s => s.status === 'running'))
          fail('仍有任务或资料正在处理，请等任务结束、停止试听后再迁移', 409);
        moving = true;
        movePromise = (async () => {
          await analysis.close();
          const target = await copyWorkspace(store, p.directory);
          let nextStore;
          try {
            await writeFile(join(target, 'runtime.json'), JSON.stringify({ pid: process.pid, port: server.address().port }), { flag: 'wx' });
            nextStore = openStore(target);
            const nextDomain = createDomain(nextStore), nextWorker = createWorker(nextStore, nextDomain, config), nextAnalysis = createAnalysis(nextStore, nextDomain, config);
            await saveWorkspaceLocation(target, workspaceConfig);
            worker.close();
            analysis.stop();
            store.close();
            const oldRuntime = runtime;
            directory = target;
            runtime = join(target, 'runtime.json');
            store = nextStore; domain = nextDomain; worker = nextWorker; analysis = nextAnalysis;
            experience = createExperience(store,domain,worker,analysis,config);
            await rm(oldRuntime, { force: true }).catch(() => console.warn('旧位置运行标记未能移除；原资料仍保留。'));
            return { directory, previousDirectory: p.source };
          } catch (error) {
            nextStore?.close();
            await rm(target, { recursive: true, force: true });
            throw error;
          }
        })();
        try { return send(res, 200, await movePromise); }
        finally { moving = false; movePromise = null; }
      }
      if (req.method === "GET" && path === "/api/state")
        return send(res, 200, {
          ...domain.snapshot(),
          settings: {
            revision: store.maybe("settings", "models")?.revision ?? 1,
            configured: !!config.key,
            model: config.model,
            audioTools,
            routeBlocked: worker.routeBlocked,
            textModel: textModel(store),
            defaultGap: store.maybe("settings", "models")?.defaultGap ?? 0.5,
            workspaceDirectory: directory,
            workspaceIdentity: workspaceIdentity(directory),
            runtimePid: process.pid,
            projectFolders: !!store.maybe('settings', 'project-folders')?.enabled,
            features: domain.enhancement.features(),
            schemaVersion: store.get('settings', 'data-schema').version,
            audioUsage: (() => { const u = store.maybe("settings", `audio-usage:${config.usageScope || "audio-calls-v1"}`); return { limit: u?.limit ?? config.callLimit, reserved: u?.reserved || 0, used: u?.used || 0 }; })(),
          },
        });
      if (req.method === "GET" && /^\/api\/voices\/[^/]+\/usage$/.test(path))
        return send(res, 200, domain.voiceUsage(path.split("/")[3]));
      if (req.method === 'GET' && path === '/api/workspace/diagnostics') return send(res,200,workspaceDiagnostics(store));
      if (req.method === 'GET' && /^\/api\/projects\/[^/]+\/deletion-plan$/.test(path))
        return send(res, 200, domain.deletionPlan({id:path.split('/')[3]}));
      if (req.method === 'GET' && /^\/api\/chapters\/[^/]+\/structural-repair-plan$/.test(path))
        return send(res, 200, domain.structuralRepairPlan({ chapterId: path.split('/')[3] }));
      if (req.method === 'GET' && path === '/api/diagnostics/compiler-compatibility')
        return send(res, 200, domain.enhancement.compilerCompatibility());
      if (req.method === "GET" && path.startsWith("/api/chapters/")) {
        const id = path.split("/").pop();
        if (audioTools) for (const row of domain.enhancement.inspectArrangement(id).rows) {
          if (row.a) await validateStoredAudio(store, row.a);
        }
        return send(res, 200, domain.chapter(id));
      }
      if (req.method === "GET" && path.startsWith("/api/attempts/"))
        return send(res, 200, store.all("attempts", path.split("/").pop()));
      if (req.method === "GET" && path.startsWith("/api/audio-record/"))
        return send(res, 200, store.get("audios", path.split("/").pop()));
      if (req.method === 'GET' && /^\/api\/projects\/[^/]+\/experience$/.test(path)) return send(res,200,experience.project(path.split('/')[3]));
      if (req.method === 'GET' && path.startsWith('/api/operations/')) return send(res,200,experience.get(decodeURIComponent(path.split('/').pop())));
      if (req.method === 'POST' && path === '/api/operations/plan') return send(res,200,experience.plan(await body(req)));
      if (req.method === 'POST' && path === '/api/operations') return send(res,200,await experience.run(await body(req)));
      if (req.method === 'POST' && /^\/api\/experience\/(policy|grant|revoke|undo|unprotect)$/.test(path)) return send(res,200,experience[path.split('/').pop()](await body(req)));
      if (req.method === "POST" && path === "/api/enhancement-preview")
        return send(res, 200, domain.enhancement.preview(await body(req)));
      if (req.method === "POST" && path === "/api/voices/candidate")
        return send(res, 200, await saveCandidateVoice(store, await body(req)));
      if (req.method === "POST" && path === "/api/templates/preview")
        return send(res,200,domain.previewTemplate(await body(req)));
      if (req.method === "POST" && path === "/api/analysis")
        return send(res, 200, await analysis.start(await body(req)));
      if (req.method === "POST" && path === "/api/analysis/apply")
        return send(res, 200, analysis.apply(await body(req)));
      if (req.method === "POST" && path === "/api/analysis/reuse")
        return send(res, 200, analysis.reuse(await body(req)));
      if (req.method === "GET" && path === "/api/analysis/reuse-preview") {
        const p = Object.fromEntries(new URL(req.url, `http://${host}`).searchParams);
        for (const field of ['revision','unitRevision','draftVersion','contextRevision']) if (p[field] !== undefined) p[field] = Number(p[field]);
        return send(res, 200, analysis.previewReuse(p));
      }
      if (req.method === "POST" && path === "/api/analysis/edit")
        return send(res, 200, analysis.edit(await body(req)));
      if (req.method === "POST" && path === "/api/analysis/resume")
        return send(res, 200, analysis.resume(await body(req)));
      if (req.method === "POST" && path === "/api/action") {
        const p = await body(req);
        if (p.action === 'project.delete' && experience.projectBusy(p.id))
          fail('这个项目仍有操作正在处理，请等操作结束后再删除', 409);
        if (p.action === 'project.rename' && store.maybe('projects', p.id)?.folder && (activeRequests !== 1 || referenceReads.size))
          fail('资料正在读取或保存，请稍后再改项目名称', 409);
        if (["segment.review", "unit.review", "unit.restore", "unit.select-result"].includes(p.action)) {
          if (!audioTools) fail("请先配置音频处理程序以核对文件");
          const a = store.get("audios", p.audioId);
          if (!await validateStoredAudio(store, a)) fail("音频损坏或缺失，不能记录检查通过");
        }
        if (p.action === "voice.update" && p.inspection?.checked) {
          if (!audioTools) fail("请先配置音频处理程序以核对文件");
          const v = store.get("voices",p.id);
          if (p.inspection.target === "sample") {
            if (!v.sampleAudioId || p.inspection.audioId !== v.sampleAudioId) fail("测试样音已变化，请重新检查",409);
            if (!await validateStoredAudio(store,store.get("audios",v.sampleAudioId))) fail("测试样音不可用，不能记录已检查");
          } else {
            if (!v.path) fail("参考文件已删除");
            try { await inspect(join(directory,v.path)); } catch { fail("参考文件不可用，不能记录已检查"); }
          }
        }
        const result = domain.mutate(p.action, p);
        return send(res, 200, result);
      }
      if (req.method === "POST" && path === "/api/voices")
        return send(res, 200, await uploadVoice(store, await body(req)));
      if (req.method === "GET" && /^\/api\/voices\/[^/]+$/.test(path))
        return send(res,200,store.get('voices',decodeURIComponent(path.split('/').at(-1))));
      if (req.method === "POST" && path === "/api/jobs") {
        if (!audioTools) fail("没有找到 FFmpeg，请先配置音频处理程序");
        const result = await worker.submit(await body(req));
        void worker.tick();
        return send(res, 200, result);
      }
      if (req.method === "GET" && path.startsWith("/api/media/")) {
        const [, , , kind, id] = path.split("/");
        if (!["voices", "audios", "masters", "exports"].includes(kind))
          fail("文件类型无效", 404);
        const record = store.get(kind, id);
        if (!record.path) fail("文件已删除", 404);
        if (kind === "audios" && audioTools && !await validateStoredAudio(store, record))
          fail("音频损坏或缺失，请恢复备份或明确选择重做", 409);
        if (kind === "voices") {
          if (record.deletePending)
            fail("参考素材等待删除，不再开始新的读取", 409);
          referenceReads.set(id, (referenceReads.get(id) || 0) + 1);
          res.once("close", () => {
            const count = referenceReads.get(id) - 1;
            if (count) referenceReads.set(id, count);
            else referenceReads.delete(id);
          });
        }
        return await serveFile(
          req,
          res,
          join(directory, record.path),
          record.path.endsWith(".mp3") ? "audio/mpeg" : "audio/wav",
        );
      }
      if (path.startsWith("/api/")) fail("接口不存在", 404);
      const requested =
        path === "/" ? "index.html" : decodeURIComponent(path.slice(1));
      const file = resolve(root, "dist", requested);
      const dist = resolve(root, "dist");
      if (!file.startsWith(dist + "/")) fail("无效路径", 403);
      const target = existsSync(file) ? file : join(dist, "index.html");
      if (!existsSync(target))
        return send(res, 503, {
          error: "前端尚未构建，请运行 npm run dev 或 npm run build",
        });
      return await serveFile(
        req,
        res,
        target,
        {
          ".html": "text/html; charset=utf-8",
          ".js": "text/javascript",
          ".css": "text/css",
          ".woff2": "font/woff2",
          ".svg": "image/svg+xml",
          ".mp3": "audio/mpeg",
          ".wav": "audio/wav",
        }[extname(target)] || "application/octet-stream",
      );
    } catch (e) {
      if (!res.headersSent)
        send(res, e.status || 500, {
          error: e.status
            ? e.message
            : e.code === "ENOENT"
              ? "音频文件缺失，请重新准备或恢复备份"
              : "本地服务处理失败，请保留当前编辑",
          ...(e.status && e.retryClass ? { code: e.code, scope: e.scope, retryClass: e.retryClass, ...(e.notApplied === true ? {outcome:e.outcome,notApplied:true,fieldErrors:e.fieldErrors} : {}) } : {}),
        });
      else res.destroy();
    } finally { if (counted) activeRequests--; }
  });
  const interval = setInterval(() => {
    if (moving || closing) return;
    void worker.tick();
    drainReferenceDeletes(store, referenceReads);
  }, 1000);
  try {
    await new Promise((r, j) => {
      server.once("error", j);
      server.listen(port, "127.0.0.1", r);
    });
  } catch (e) {
    clearInterval(interval);
    worker.close();
    await analysis.close();
    store.close();
    await rm(runtime, { force: true });
    throw e;
  }
  return {
    server,
    get store() { return store; },
    get domain() { return domain; },
    get worker() { return worker; },
    async close() {
      closing = true;
      if (movePromise) await movePromise.catch(() => {});
      worker.close();
      analysis.stop();
      clearInterval(interval);
      await new Promise((r) => server.close(r));
      while (worker.running) await new Promise((r) => setTimeout(r, 100));
      await analysis.close();
      drainReferenceDeletes(store, referenceReads);
      store.close();
      await rm(runtime, { force: true });
    },
  };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const app = await startServer();
  console.log(
    `配音工作台本地服务：http://127.0.0.1:${app.server.address().port}`,
  );
  let stopping = false;
  for (const signal of ["SIGTERM", "SIGINT"])
    process.on(signal, async () => {
      if (stopping) return;
      stopping = true;
      await app.close();
      process.exit(0);
    });
}
