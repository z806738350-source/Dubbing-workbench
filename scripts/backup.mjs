import { cp, readFile, writeFile, readdir, lstat, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, join, relative, isAbsolute } from "node:path";
import { DatabaseSync } from "node:sqlite";
const [mode, sourceArg, targetArg] = process.argv.slice(2);
if (
  !["create", "restore", "verify", "cleanup"].includes(mode) ||
  !sourceArg ||
  (["create", "restore"].includes(mode) && !targetArg) ||
  (mode === "cleanup" && targetArg && targetArg !== "--apply")
)
  throw new Error(
    "用法：node scripts/backup.mjs create|restore 来源目录 新目录；或 verify 数据目录；或 cleanup 数据目录 [--apply]",
  );
const source = resolve(sourceArg),
  target = targetArg ? resolve(targetArg) : null;
async function verify(dir) {
  if (!existsSync(join(dir, "workbench.sqlite"))) throw new Error("数据目录缺少数据库");
  const db = new DatabaseSync(join(dir, "workbench.sqlite"), {
    readOnly: mode !== "cleanup",
  });
  try {
    // 文件删除期间阻止服务启动后的数据库写入，避免扫描后出现新引用。
    if (mode === "cleanup") db.exec("BEGIN IMMEDIATE");
    if (existsSync(join(dir, "runtime.json"))) {
      const { pid } = JSON.parse(
        await readFile(join(dir, "runtime.json"), "utf8"),
      );
      try {
        process.kill(pid, 0);
        throw new Error("请先停止正在使用此目录的工作台");
      } catch (e) {
        if (e.code !== "ESRCH") throw e;
      }
    }
    if (Object.values(db.prepare("PRAGMA integrity_check").get())[0] !== "ok")
      throw new Error("数据库完整性检查失败");
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name));
    const records = table => tables.has(table) ? db.prepare(`SELECT data FROM ${table}`).all().map(r => JSON.parse(r.data)) : [];
    const schema = records('settings').find(v => v.id === 'data-schema');
    if (schema?.version > 2) throw new Error('数据模式高于此维护版本，请使用匹配版本');
    if (schema?.version === 2) {
      for (const table of ['voiceSessions','units','events']) if (!tables.has(table)) throw new Error(`增强数据表缺失：${table}`);
      const segments = new Set(records('segments').map(v => v.id)), audios = new Set(records('audios').map(v => v.id)), sessions = new Set(records('voiceSessions').map(v => v.id)), units = new Set(records('units').map(v => v.id));
      for (const u of records('units')) {
        if (!Array.isArray(u.members) || !u.members.length || u.members.some(id => !segments.has(id))) throw new Error('生成单元成员引用缺失');
        for (const v of Object.values(u.variants || {})) for (const id of [v.current,v.previous,v.approved]) if (id && !audios.has(id)) throw new Error('生成单元版本音频引用缺失');
      }
      for (const e of records('events')) if (!units.has(e.unitId)) throw new Error('声音事件单元引用缺失');
      for (const a of records('audios')) {
        if (a.input?.targetKind === 'candidate' && !sessions.has(a.input.sessionId)) throw new Error('候选声音会话引用缺失');
        if (a.input?.targetKind === 'unit' && !units.has(a.input.unitId)) throw new Error('音频生成单元引用缺失');
      }
      for (const v of records('voices')) if (v.sourceAudioId && !audios.has(v.sourceAudioId)) throw new Error('音色来源候选引用缺失');
    }
    const retained = new Set();
    for (const table of ["voices", "audios", "masters", "exports"])
      for (const row of db.prepare(`SELECT data FROM ${table}`).all()) {
        const item = JSON.parse(row.data);
        if (item.path) retained.add(resolve(dir, item.path));
        if (!item.path || item.state === "deleted") continue;
        const file = resolve(dir, item.path),
          rel = relative(dir, file);
        if (rel.startsWith("..") || isAbsolute(rel))
          throw new Error("备份包含越界文件路径");
        if (!existsSync(file))
          throw new Error(`备份缺少被引用文件：${item.path}`);
      }
    for (const row of db.prepare("SELECT data FROM jobs").all())
      if (["queued", "running"].includes(JSON.parse(row.data).status))
        throw new Error("存在未结束任务，请正常关闭服务后再维护");
    if (mode === "cleanup") {
      // ponytail: 保留所有尝试及 .part；以后需人工判定未知结果，不能靠年龄自动回收。
      for (const row of db.prepare("SELECT data FROM attempts").all())
        { const a = JSON.parse(row.data); retained.add(resolve(dir, a.path || `audio/${a.id}.wav`)); }
      const candidates = [];
      const folders = ['voices', 'audio', 'masters', 'exports'];
      for (const p of records('projects')) if (p.folder) for (const kind of ['audio','masters','exports']) folders.push(join(p.folder,kind));
      for (const folder of folders) {
        const rel = relative(dir, resolve(dir, folder));
        if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('项目目录越界，拒绝清理');
        const base = join(dir, folder);
        if (!existsSync(base) || !(await lstat(base)).isDirectory()) continue;
        for (const entry of await readdir(base, { withFileTypes: true })) {
          const file = join(base, entry.name);
          if (entry.isFile() && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\.(wav|mp3)$/i.test(entry.name) && !retained.has(file))
            candidates.push(relative(dir, file));
        }
      }
      for (const path of candidates) {
        if (targetArg === "--apply") await unlink(join(dir, path));
        console.log(`${targetArg === "--apply" ? "已删除" : "待删除"}：${path}`);
      }
      console.log(`${candidates.length} 个无引用文件；${targetArg === "--apply" ? "清理完成，数据库及历史记录保持。" : "仅预览，未删除。确认后追加 --apply 执行。"}`);
    }
  } finally {
    db.close();
  }
}
await verify(source);
if (mode === "verify") console.log("数据库与被引用文件完整。");
else if (mode !== "cleanup") {
  if (existsSync(target))
    throw new Error("目标目录已存在，请使用新目录，避免覆盖");
  if (target.startsWith(source + "/"))
    throw new Error("备份不能放在来源目录内部");
  await cp(source, target, {
    recursive: true,
    errorOnExist: true,
    force: false,
    filter: (path) => !path.endsWith("/runtime.json"),
  });
  await verify(target);
  await writeFile(
    join(target, "backup-info.json"),
    JSON.stringify(
      { createdAt: new Date().toISOString(), operation: mode },
      null,
      2,
    ),
  );
  console.log(
    mode === "restore" ? "已恢复到新目录，原数据保留。" : "已创建完整备份。",
  );
}
