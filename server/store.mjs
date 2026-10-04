import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

export const uid = () => randomUUID();
export const same = isDeepStrictEqual;
export function fail(message, status = 400, metadata = {}) {
  const recovery = {
    400: ["invalid-request", "edit-request"],
    401: ["permission-denied", "review-permission"],
    403: ["permission-denied", "review-permission"],
    404: ["object-unavailable", "review-target"],
    409: ["state-conflict", "refresh-and-review"],
    413: ["request-too-large", "edit-request"],
    416: ["invalid-range", "review-target"],
    503: ["service-unavailable", "wait-for-service"],
  }[status] || ["operation-result-unconfirmed", "check-existing-operation"];
  throw Object.assign(new Error(message), { status, code: recovery[0], scope: { kind: "request" }, retryClass: recovery[1] }, metadata);
}
export function text(value, label, max = 1000000) {
  if (typeof value !== "string" || value.length > max || !value.trim())
    fail(`${label}不能为空，且不能超过 ${max} 个字符`);
  return value;
}

export function openStore(directory) {
  mkdirSync(directory, { recursive: true });
  const db = new DatabaseSync(join(directory, "workbench.sqlite"));
  let transactionDepth = 0;
  const settingsTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='settings'").get();
  const schema = settingsTable && db.prepare("SELECT data FROM settings WHERE id='data-schema'").get();
  if (schema && (![1,2,3,4].includes(JSON.parse(schema.data).version))) {
    db.close();
    fail("数据模式高于此版本，请使用匹配版本或恢复对应备份");
  }
  // Old writers do not read the schema metadata. Native DML triggers on upgraded
  // databases require this connection capability; plain read-only backups work.
  let writerVersion = schema ? JSON.parse(schema.data).version : 4;
  db.function("workbench_schema_version", () => writerVersion);
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
    "voiceSessions",
    "units",
    "events",
    "assistantSessions",
    "assistantMessages",
    "assistantRuns",
    "assistantSteps",
    "assistantDecisions",
    "assistantAttachments",
  ];
  for (const table of tables)
    db.exec(
      `CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, parent TEXT NOT NULL DEFAULT '', data TEXT NOT NULL CHECK(json_valid(data))); CREATE INDEX IF NOT EXISTS ${table}_parent ON ${table}(parent);`,
    );
  db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS command_once ON jobs(json_extract(data,'$.commandId')); CREATE UNIQUE INDEX IF NOT EXISTS chapter_lock ON jobs(parent) WHERE json_extract(data,'$.status') IN ('queued','running') AND parent <> ''; ",
  );
  db.exec("CREATE INDEX IF NOT EXISTS audio_unit_history ON audios(parent,json_extract(data,'$.input.unitId'),COALESCE(NULLIF(NULLIF(json_extract(data,'$.input.mode'),''),0),NULLIF(NULLIF(json_extract(data,'$.mode'),''),0),'dry')); CREATE INDEX IF NOT EXISTS audio_single_history ON audios(parent,json_extract(data,'$.targetKind'),json_extract(data,'$.targetId')); CREATE INDEX IF NOT EXISTS attempt_segment_history ON attempts(json_extract(data,'$.segmentId'));");
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
    unitHistory(u, mode, refs) {
      const queries = ["SELECT rowid,data FROM audios WHERE parent=? AND json_extract(data,'$.input.unitId')=? AND COALESCE(NULLIF(NULLIF(json_extract(data,'$.input.mode'),''),0),NULLIF(NULLIF(json_extract(data,'$.mode'),''),0),'dry')=?"], params = [u.chapterId,u.id,mode];
      if (u.kind === 'single' && mode === 'dry') {
        queries.push("SELECT rowid,data FROM audios WHERE parent=? AND json_extract(data,'$.targetKind')='single' AND json_extract(data,'$.targetId')=?", "SELECT a.rowid,a.data FROM attempts t INDEXED BY attempt_segment_history CROSS JOIN audios a ON a.id=t.id WHERE json_extract(t.data,'$.segmentId')=? AND a.parent=?");
        params.push(u.chapterId,u.id,u.id,u.chapterId);
        const ids = refs.filter(Boolean);
        if (ids.length) { queries.push(`SELECT rowid,data FROM audios WHERE parent=? AND id IN (${ids.map(()=>'?').join(',')})`); params.push(u.chapterId,...ids); }
      }
      return db.prepare(queries.join(' UNION ') + ' ORDER BY rowid').all(...params).map(r=>JSON.parse(r.data));
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
      const level = transactionDepth, savepoint = `workbench_${level}`, previousWriterVersion = writerVersion;
      db.exec(level ? `SAVEPOINT ${savepoint}` : "BEGIN IMMEDIATE");
      transactionDepth++;
      try {
        const result = fn();
        db.exec(level ? `RELEASE ${savepoint}` : "COMMIT");
        return result;
      } catch (e) {
        db.exec(level ? `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}` : "ROLLBACK");
        writerVersion = previousWriterVersion;
        throw e;
      } finally { transactionDepth--; }
    },
    protectSchema() {
      writerVersion = 4;
      for (const table of tables) for (const action of ["INSERT", "UPDATE", "DELETE"])
        db.exec(`DROP TRIGGER IF EXISTS schema_v2_${table}_${action}; DROP TRIGGER IF EXISTS schema_v3_${table}_${action}; CREATE TRIGGER IF NOT EXISTS schema_v4_${table}_${action} BEFORE ${action} ON ${table} BEGIN SELECT CASE WHEN workbench_schema_version() <> 4 THEN RAISE(ABORT, 'Unsupported workbench data schema') END; END`);
    },
    close() {
      db.close();
    },
  };
}
