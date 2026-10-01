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
  toolsAvailable,
  drainReferenceDeletes,
  validateStoredAudio,
  inspect,
} from "./audio.mjs";
import { createAnalysis } from "./analysis.mjs";

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
  };
}
export async function startServer({
  port = Number(process.env.PORT || 4318),
  directory = process.env.DATA_DIR || join(root, "data"),
  config = settings(),
} = {}) {
  await mkdir(directory, { recursive: true });
  const runtime = join(directory, "runtime.json");
  if (existsSync(runtime)) {
    const { pid } = JSON.parse(await readFile(runtime, "utf8"));
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
  const store = openStore(directory),
    domain = createDomain(store),
    worker = createWorker(store, domain, config),
    analysis = createAnalysis(store, domain, config);
  await worker.recover();
  analysis.recover();
  const audioTools = await toolsAvailable();
  if (audioTools) for (const a of store.all("audios")) await validateStoredAudio(store, a);
  const send = (res, status, data) => {
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
      createReadStream(file, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { ...headers, "Content-Length": info.size });
      createReadStream(file).pipe(res);
    }
  }
  const server = http.createServer(async (req, res) => {
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
          },
        });
      if (req.method === "GET" && /^\/api\/voices\/[^/]+\/usage$/.test(path))
        return send(res, 200, domain.voiceUsage(path.split("/")[3]));
      if (req.method === "GET" && path.startsWith("/api/chapters/")) {
        const id = path.split("/").pop();
        if (audioTools) for (const s of domain.list(id)) {
          const a = s.current && store.maybe("audios", s.current);
          if (a) await validateStoredAudio(store, a);
        }
        return send(res, 200, domain.chapter(id));
      }
      if (req.method === "GET" && path.startsWith("/api/attempts/"))
        return send(res, 200, store.all("attempts", path.split("/").pop()));
      if (req.method === "GET" && path.startsWith("/api/audio-record/"))
        return send(res, 200, store.get("audios", path.split("/").pop()));
      if (req.method === "POST" && path === "/api/templates/preview")
        return send(res,200,domain.previewTemplate(await body(req)));
      if (req.method === "POST" && path === "/api/analysis")
        return send(res, 200, await analysis.start(await body(req)));
      if (req.method === "POST" && path === "/api/analysis/apply")
        return send(res, 200, analysis.apply(await body(req)));
      if (req.method === "POST" && path === "/api/analysis/edit")
        return send(res, 200, analysis.edit(await body(req)));
      if (req.method === "POST" && path === "/api/analysis/resume")
        return send(res, 200, analysis.resume(await body(req)));
      if (req.method === "POST" && path === "/api/action") {
        const p = await body(req);
        if (p.action === "segment.review") {
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
        }[extname(target)] || "application/octet-stream",
      );
    } catch (e) {
      if (!res.headersSent)
        send(res, e.status || 500, {
          error: e.status
            ? e.message
            : e.code === "ENOENT"
              ? "音频文件缺失，请重新准备或恢复备份"
              : "本地服务处理失败，请保留当前编辑并重试",
        });
      else res.destroy();
    }
  });
  const interval = setInterval(() => {
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
    store,
    domain,
    worker,
    async close() {
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
