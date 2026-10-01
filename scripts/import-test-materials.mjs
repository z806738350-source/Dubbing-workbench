import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
const base = "http://127.0.0.1:4318/api";
async function request(path, body) {
  const r = await fetch(
    base + path,
    body
      ? {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      : undefined,
  );
  const data = await r.json();
  if (!r.ok) throw new Error(data.error);
  return data;
}
const materials = "/Users/uiteam/Downloads/不要乱碰瓷";
let state = await request("/state");
let project = state.projects.find((p) => p.name === "不要乱碰瓷 · 测试制作");
if (!project) {
  const empty = state.projects.find((p) => p.name === "·");
  project = await request(
    "/action",
    empty
      ? {
          action: "project.rename",
          entityRevision: empty.revision ?? 1,
          id: empty.id,
          name: "不要乱碰瓷 · 测试制作",
        }
      : { action: "project.create", name: "不要乱碰瓷 · 测试制作" },
  );
}
for (const title of ["第1章", "第2章"])
  if (
    !state.chapters.some((c) => c.projectId === project.id && c.title === title)
  ) {
    const source = await readFile(
      join(materials, "文本", "章节拆分", title + ".txt"),
      "utf8",
    );
    await request("/action", {
      action: "chapter.create",
      projectId: project.id,
      title,
      source,
      segment: true,
    });
    console.log("已导入", title);
  }
for (const name of ["砸锅-里皮.wav", "合成-女青年.wav", "砸锅-应星决.wav"])
  if (!state.voices.some((v) => v.name === name.slice(0, -4))) {
    try {
      const data = (await readFile(join(materials, "声音", name))).toString(
        "base64",
      );
      const voice = await request("/voices", {
        name: name.slice(0, -4),
        filename: name,
        data,
      });
      console.log("已导入参考", voice.name, voice.duration.toFixed(2) + "秒");
    } catch (e) {
      console.log("参考未导入", name, e.message);
    }
  }
console.log("测试素材已复制，原文件未改动。");
