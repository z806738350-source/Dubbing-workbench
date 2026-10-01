import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export const uid = () => randomUUID();
export const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export function fail(message, status = 400) {
  throw Object.assign(new Error(message), { status });
}
export function text(value, label, max = 1000000) {
  if (typeof value !== "string" || value.length > max || !value.trim())
    fail(`${label}不能为空，且不能超过 ${max} 个字符`);
  return value;
}

export function openStore(directory) {
  mkdirSync(directory, { recursive: true });
  const db = new DatabaseSync(join(directory, "workbench.sqlite"));
  db.exec(
    "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;",
  );
  const tables = [
    "projects",
    "chapters",
    "roles",
    "voices",
    "segments",
    "audios",
    "jobs",
    "attempts",
    "masters",
    "exports",
    "suggestions",
    "settings",
  ];
  for (const table of tables)
    db.exec(
      `CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, parent TEXT NOT NULL DEFAULT '', data TEXT NOT NULL CHECK(json_valid(data))); CREATE INDEX IF NOT EXISTS ${table}_parent ON ${table}(parent);`,
    );
  db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS command_once ON jobs(json_extract(data,'$.commandId')); CREATE UNIQUE INDEX IF NOT EXISTS chapter_lock ON jobs(parent) WHERE json_extract(data,'$.status') IN ('queued','running') AND parent <> ''; ",
  );
  const check = (t) => {
    if (!tables.includes(t)) throw new Error("Unknown table");
  };
  return {
    db,
    directory,
    all(t, parent) {
      check(t);
      return (
        parent === undefined
          ? db.prepare(`SELECT data FROM ${t} ORDER BY rowid`).all()
          : db
              .prepare(`SELECT data FROM ${t} WHERE parent=? ORDER BY rowid`)
              .all(parent)
      ).map((r) => JSON.parse(r.data));
    },
    get(t, id) {
      check(t);
      const row = db.prepare(`SELECT data FROM ${t} WHERE id=?`).get(id);
      if (!row) fail("记录已不存在，请刷新后重试", 404);
      return JSON.parse(row.data);
    },
    maybe(t, id) {
      try {
        return this.get(t, id);
      } catch (e) {
        if (e.status === 404) return null;
        throw e;
      }
    },
    put(t, value, parent = value.parent || "") {
      check(t);
      db.prepare(
        `INSERT INTO ${t}(id,parent,data) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET parent=excluded.parent,data=excluded.data`,
      ).run(value.id, parent, JSON.stringify(value));
      return value;
    },
    remove(t, id) {
      check(t);
      db.prepare(`DELETE FROM ${t} WHERE id=?`).run(id);
    },
    transaction(fn) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = fn();
        db.exec("COMMIT");
        return result;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
    close() {
      db.close();
    },
  };
}
