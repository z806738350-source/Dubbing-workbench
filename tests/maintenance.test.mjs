import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { openStore, uid } from "../server/store.mjs";

test("显式清理只删无引用文件，保留历史备份和未知产物并拒绝在用数据", (t) => {
  const root = mkdtempSync(join(tmpdir(), "dubbing-maintenance-")), dir = join(root, "data");
  const store = openStore(dir);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const run = (...args) => spawnSync(process.execPath, [resolve("scripts/backup.mjs"), ...args], { encoding: "utf8" });
  const ok = (...args) => { const r = run(...args); assert.equal(r.status, 0, r.stderr); return r.stdout; };
  const file = (folder, name = `${uid()}.wav`) => {
    mkdirSync(join(dir, folder), { recursive: true });
    const path = `${folder}/${name}`;
    writeFileSync(join(dir, path), path);
    return path;
  };
  const retained = [];
  for (const [table, folder, count] of [["voices", "voices", 1], ["audios", "audio", 5], ["masters", "masters", 2], ["exports", "exports", 2]])
    for (let i = 0; i < count; i++) {
      const path = file(folder), id = uid();
      retained.push(path);
      store.put(table, { id, path, superseded: i > 0 });
    }
  const audio = store.all("audios");
  store.put("segments", { id: uid(), current: audio[0].id, previous: audio[1].id, approved: audio[2].id });
  store.put("segments", { id: uid(), retired: true, current: audio[3].id });
  const attempt = { id: uid(), status: "unknown" };
  store.put("attempts", attempt);
  retained.push(file("audio", `${attempt.id}.wav`), file("audio", `${uid()}.wav.part`), file("audio", "user-recording.wav"));
  retained.push(file("backups/audio"));
  const orphans = [file("voices"), file("audio"), file("masters"), file("exports", `${uid()}.mp3`)];
  const tables = ["voices", "audios", "masters", "exports", "segments", "attempts", "jobs"];
  const snapshot = () => tables.map(table => store.all(table));
  const before = snapshot();
  const backup = join(root, "backup");
  ok("create", dir, backup);
  const preview = ok("cleanup", dir);
  assert.match(preview, /4 个无引用文件.*仅预览/);
  for (const p of [...retained, ...orphans]) assert.equal(readFileSync(join(dir, p), "utf8"), p);
  writeFileSync(join(dir, "runtime.json"), JSON.stringify({ pid: process.pid }));
  assert.notEqual(run("cleanup", dir, "--apply").status, 0);
  rmSync(join(dir, "runtime.json"));
  const job = { id: uid(), status: "queued" };
  store.put("jobs", job);
  assert.match(run("cleanup", dir, "--apply").stderr, /未结束任务/);
  store.remove("jobs", job.id);
  store.db.exec("BEGIN IMMEDIATE");
  assert.notEqual(run("cleanup", dir, "--apply").status, 0);
  store.db.exec("ROLLBACK");
  for (const p of orphans) assert.ok(existsSync(join(dir, p)));
  const missing = retained[0];
  rmSync(join(dir, missing));
  assert.match(run("cleanup", dir, "--apply").stderr, /缺少被引用文件/);
  for (const p of orphans) assert.ok(existsSync(join(dir, p)));
  writeFileSync(join(dir, missing), missing);
  const external = join(root, `${uid()}.wav`);
  writeFileSync(external, "outside");
  symlinkSync(external, join(dir, "audio", `${uid()}.wav`));
  assert.match(ok("cleanup", dir, "--apply"), /4 个无引用文件/);
  for (const p of retained) assert.equal(readFileSync(join(dir, p), "utf8"), p);
  for (const p of orphans) {
    assert.equal(existsSync(join(dir, p)), false);
    assert.equal(readFileSync(join(backup, p), "utf8"), p);
  }
  assert.deepEqual(snapshot(), before);
  assert.equal(readFileSync(external, "utf8"), "outside");
  assert.match(ok("cleanup", dir, "--apply"), /0 个无引用文件/);
  ok("verify", dir);
  ok("verify", backup);
  const restored = join(root, "restored");
  ok("restore", backup, restored);
  for (const p of [...retained, ...orphans]) assert.equal(readFileSync(join(restored, p), "utf8"), p);
  rmSync(join(dir, "exports"), { recursive: true });
  mkdirSync(join(root, "external"));
  symlinkSync(join(root, "external"), join(dir, "exports"));
  for (const row of store.all("exports")) store.remove("exports", row.id);
  const linked = join(dir, "exports", `${uid()}.wav`);
  writeFileSync(linked, "linked-directory");
  ok("cleanup", dir, "--apply");
  assert.equal(readFileSync(linked, "utf8"), "linked-directory");
  const empty = join(root, "empty");
  mkdirSync(empty);
  assert.notEqual(run("cleanup", empty, "--apply").status, 0);
  assert.equal(existsSync(join(empty, "workbench.sqlite")), false);
});
