// All content below is invented for this test. No user-supplied novel or voice is transmitted.
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { settings } from "../server/index.mjs";
import { inspect } from "../server/audio.mjs";
const config = settings(),
  base = "http://127.0.0.1:4318/api",
  dir = "data/live-smoke";
await mkdir(dir, { recursive: true });
async function request(path, body) {
  const response = await fetch(
    base + path,
    body
      ? {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      : undefined,
  );
  const data = await response.json();
  if (!response.ok) throw new Error(data.error);
  return data;
}
const receiptFile = join(dir, "receipt.json");
const receipt = existsSync(receiptFile)
  ? JSON.parse(await readFile(receiptFile, "utf8"))
  : {
      source: "自拟文本与模型合成参考，无用户素材",
      startedAt: new Date().toISOString(),
      references: [],
      jobs: [],
    };
const persist = () => writeFile(receiptFile, JSON.stringify(receipt, null, 2));
let state = await request("/state");
for (const [index, description] of [
  "成年男声，沉稳温和，清楚自然",
  "成年女声，清亮自然，平静而亲切",
  "成年男声，略低沉，语气简短坚定",
].entries()) {
  const name = ["测试合成 · 旁白", "测试合成 · 林青", "测试合成 · 周远"][index];
  if (state.voices.some((v) => v.name === name)) continue;
  const path = join(dir, `reference-${index}.wav`);
  if (!existsSync(path)) {
    console.log("生成自拟测试参考", index + 1);
    const started = Date.now();
    const response = await fetch(config.audioUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: config.model,
        text_prompt: `生成一条中文干声。声音：${description}。仅朗读：今天我们从这里出发，一起把故事讲清楚。不读说明，不加音乐或音效。`,
        audio_config: { format: "wav", sample_rate: 48000 },
      }),
      signal: AbortSignal.timeout(180000),
    });
    if (!response.ok) throw new Error(`参考生成 HTTP ${response.status}`);
    await writeFile(path, Buffer.from(await response.arrayBuffer()));
    const meta = await inspect(path);
    receipt.references.push({
      name,
      path,
      duration: meta.duration,
      elapsedMs: Date.now() - started,
    });
    await persist();
  }
  const voice = await request("/voices", {
    name,
    filename: name + ".wav",
    data: (await readFile(path)).toString("base64"),
  });
  console.log("参考已保存", voice.name, voice.duration);
}
state = await request("/state");
let project = state.projects.find((p) => p.name === "自拟样章 · 接口验收");
if (!project)
  project = await request("/action", {
    action: "project.create",
    name: "自拟样章 · 接口验收",
  });
let roles = state.roles.filter((r) => r.projectId === project.id);
for (const name of ["林青", "周远"])
  if (!roles.some((r) => r.name === name))
    await request("/action", {
      action: "role.create",
      projectId: project.id,
      name,
    });
state = await request("/state");
roles = state.roles.filter((r) => r.projectId === project.id);
for (const r of roles) {
  const name = r.narrator ? "测试合成 · 旁白" : "测试合成 · " + r.name;
  await request("/action", {
    action: "role.update",
    entityRevision: r.revision ?? 1,
    id: r.id,
    voiceId: state.voices.find((v) => v.name === name).id,
  });
}
const chapters = [
  {
    title: "样章一 · 雨后的车站",
    lines: [
      ["旁白", "雨停了，站台上只剩下两个人。"],
      ["林青", "你听，远处的钟声。"],
      ["周远", "走吧，我们还来得及。"],
    ],
  },
  {
    title: "样章二 · 清晨的信",
    lines: [
      ["旁白", "第二天清晨，林青打开了那封信。"],
      ["林青", "原来，你早就知道了。"],
      ["周远", "是的，我一直在等你。"],
    ],
  },
];
for (const sample of chapters) {
  state = await request("/state");
  let chapter = state.chapters.find(
    (c) => c.projectId === project.id && c.title === sample.title,
  );
  if (!chapter) {
    chapter = await request("/action", {
      action: "chapter.create",
      projectId: project.id,
      title: sample.title,
    });
    for (const [name, text] of sample.lines) {
      const c = await request("/chapters/" + chapter.id);
      const s = await request("/action", {
        action: "segment.create",
        chapterId: chapter.id,
        revision: c.revision,
        text,
      });
      const latest = await request("/chapters/" + chapter.id);
      await request("/action", {
        action: "segment.update",
        chapterId: chapter.id,
        revision: latest.revision,
        id: s.id,
        roleId: roles.find((r) => r.name === name).id,
        type: name === "旁白" ? "narration" : "dialogue",
        roleConfirmed: true,
        identityConfirmed: true,
      });
    }
  }
  const c = await request("/chapters/" + chapter.id);
  const ids = c.segments
    .filter((s) => s.validity !== "matched" && s.latest !== "unknown")
    .map((s) => s.id);
  if (!ids.length) continue;
  const job = await request("/jobs", {
    kind: "generate",
    chapterId: c.id,
    revision: c.revision,
    ids,
    whole: true,
    commandId: crypto.randomUUID(),
  });
  console.log("配音已入队", sample.title, job.id);
  receipt.jobs.push({ id: job.id, chapter: sample.title });
  await persist();
  // The app worker remains responsible for durable progress, no paid retry here.
  for (;;) {
    await new Promise((r) => setTimeout(r, 3000));
    const current = (await request("/state")).jobs.find((j) => j.id === job.id);
    if (!["queued", "running"].includes(current.status)) {
      console.log(
        "批次结束",
        current.status,
        current.done + "/" + current.total,
      );
      receipt.jobs.at(-1).status = current.status;
      await persist();
      if (current.status !== "success")
        throw new Error(current.error || current.status);
      break;
    }
  }
}
console.log("两章真实生成完成；声音效果仍需人工听辨。");
