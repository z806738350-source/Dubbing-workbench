import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync, mkdirSync, renameSync, writeFileSync, readdirSync, rmSync, lstatSync, mkdtempSync, realpathSync } from 'node:fs';
import { cp, lstat, mkdir, realpath, rename, rm, writeFile, readdir, mkdtemp } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { fail, openStore } from './store.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
export const workspaceConfig = join(root, '.workspace-local.json');
export function workspaceDirectory(config = workspaceConfig) {
  if (process.env.DATA_DIR) return resolve(process.env.DATA_DIR);
  if (existsSync(config)) {
    const { directory } = JSON.parse(readFileSync(config, 'utf8'));
    if (typeof directory !== 'string' || !isAbsolute(directory)) fail('保存位置配置无效，请检查 .workspace-local.json');
    return directory;
  }
  return join(root, 'data');
}
export async function chooseWorkspaceDirectory(run = promisify(execFile)) {
  if (process.platform !== 'darwin') fail('当前文件夹选择功能仅支持 macOS', 501);
  try {
    const { stdout } = await run('/usr/bin/osascript', ['-e', 'tell application "Finder"\nactivate\nreturn POSIX path of (choose folder with prompt "选择项目保存总目录（请选择空文件夹，可点击新建文件夹）")\nend tell'], { timeout: 600000 });
    return stdout.trim().replace(/\/$/, '') || '/';
  } catch (error) {
    if (/\(-128\)/.test(error.stderr || '')) return null;
    fail('无法打开文件夹选择窗口，请重试');
  }
}
export async function saveWorkspaceLocation(directory, config = workspaceConfig) {
  const temp = `${config}.${process.pid}.tmp`;
  try {
    await writeFile(temp, JSON.stringify({ directory }), { mode: 0o600, flag: 'wx' });
    await rename(temp, config);
  } finally { await rm(temp, { force: true }); }
}

// Called only while the server has excluded concurrent requests and background jobs.
export async function copyWorkspace(store, requested) {
  if (typeof requested !== 'string' || !requested.trim() || requested.includes('\0')) fail('请填写新文件夹的完整路径');
  requested = requested.trim().replace(/^~\//, `${process.env.HOME}/`);
  if (!isAbsolute(requested)) fail('请使用完整路径，例如 /Users/你的用户名/Documents/配音资料');
  let parent;
  try { parent = await realpath(dirname(requested)); }
  catch { fail('上级文件夹不存在或无法访问，请先创建上级文件夹'); }
  const target = resolve(parent, basename(requested));
  const source = await realpath(store.directory);
  const inside = (base, path) => { const r = relative(base, path); return !r || (!r.startsWith('..') && !isAbsolute(r)); };
  if (inside(source, target) || inside(target, source)) fail('新位置不能是当前工作区、其内部目录或上级目录');
  if (existsSync(target) && (!(await lstat(target)).isDirectory() || (await readdir(target)).length))
    fail('目标文件夹不为空，请选择空文件夹或新位置，避免覆盖资料');
  const staging = await mkdtemp(join(parent, '.dubbing-move-'));
  try {
    // SQLite creates a consistent database copy including committed WAL contents.
    store.db.exec(`VACUUM INTO '${join(staging, 'workbench.sqlite').replaceAll("'", "''")}'`);
    for (const folder of new Set(['voices', 'audio', 'masters', 'exports', ...store.all('projects').map(p => p.folder).filter(Boolean)])) {
      if (!existsSync(join(source, folder))) continue;
      await cp(join(source, folder), join(staging, folder), {
        recursive: true, force: false, errorOnExist: true,
        filter: async path => {
          if ((await lstat(path)).isSymbolicLink()) fail('素材目录含符号链接，请先整理为实际文件再迁移');
          return true;
        },
      });
    }
    const db = new DatabaseSync(join(staging, 'workbench.sqlite'), { readOnly: true });
    try {
      if (Object.values(db.prepare('PRAGMA integrity_check').get())[0] !== 'ok') fail('新位置的数据库校验失败');
      for (const table of ['voices', 'audios', 'masters', 'exports']) {
        for (const { data } of db.prepare(`SELECT data FROM ${table}`).all()) {
          const item = JSON.parse(data);
          if (!item.path || item.state === 'deleted') continue;
          const path = resolve(staging, item.path);
          if (!inside(staging, path) || !existsSync(path)) fail('素材缺失或路径无效，请恢复缺失文件后再迁移');
          const a = await lstat(resolve(source, item.path)), b = await lstat(path);
          if (!a.isFile() || !b.isFile() || a.size !== b.size) fail('新位置的素材校验失败');
        }
      }
    } finally { db.close(); }
    const copy = openStore(staging);
    try { organizeProjects(copy); } finally { copy.close(); }
    await rename(staging, target);
    return target;
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

export function projectFile(store, chapterId, kind, filename) {
  const c = chapterId && store.maybe('chapters', chapterId);
  const folder = c && store.get('projects', c.projectId).folder;
  return join(folder || '', kind, filename);
}

function validateFolderName(name) {
  if (!name || name === '.' || name === '..' || /[/\\\x00-\x1f]/.test(name) ||
      ['voices', 'audio', 'masters', 'exports', 'workbench.sqlite', 'runtime.json'].includes(name.toLowerCase()))
    fail('项目名称不能包含斜杠、控制字符或与工作区系统目录重名');
}
export function createProjectFolder(store, project) {
  const name = project.name;
  validateFolderName(name);
  const path = join(store.directory, name);
  if (existsSync(path)) fail('已有同名项目文件夹，请使用不同的项目名称');
  mkdirSync(path);
  try { writeFileSync(join(path, '.project-id'), project.id, { flag: 'wx' }); }
  catch (error) { rmSync(path, { recursive: true, force: true }); throw error; }
  project.folder = name;
}

function projectRecords(store, project) {
  return store.all('chapters', project.id).flatMap(c => [
    ...['audios', 'masters', 'exports'].flatMap(table => store.all(table, c.id).map(row => [table, row, c.id])),
    ...store.all('jobs', c.id).flatMap(j => store.all('attempts', j.id).map(row => ['attempts', row, j.id])),
  ]);
}

function organizeProjects(store) {
  store.transaction(() => {
    for (const project of store.all('projects')) {
      if (!project.folder) createProjectFolder(store, project);
      store.put('projects', project);
      for (const [table, row, parent] of projectRecords(store, project)) {
        const old = row.path || (table === 'attempts' ? `audio/${row.id}.wav` : null);
        if (!old) continue;
        const kind = table === 'attempts' || table === 'audios' ? 'audio' : table;
        const next = join(project.folder, kind, basename(old));
        mkdirSync(join(store.directory, project.folder, kind), { recursive: true });
        for (const suffix of ['', '.part']) {
          if (old !== next && existsSync(join(store.directory, old + suffix)))
            renameSync(join(store.directory, old + suffix), join(store.directory, next + suffix));
        }
        row.path = next;
        store.put(table, row, parent);
      }
    }
    store.put('settings', { id: 'project-folders', enabled: true });
  });
}

export function renameProjectFolder(store, project, name) {
  if (!project.folder || name === project.name) return () => {};
  if (store.all('jobs').some(j => ['queued', 'running'].includes(j.status)) || store.all('suggestions').some(s => s.status === 'running'))
    fail('任务进行中，请结束后再改项目名称，以免正在写入的文件路径改变', 409);
  validateFolderName(name);
  const old = project.folder;
  const dest = join(store.directory, name);
  if (existsSync(dest)) fail('已有同名项目文件夹，请使用不同的项目名称');
  try {
    renameSync(join(store.directory, old), dest);
    for (const [table, row, parent] of projectRecords(store, project)) {
      if (row.path?.startsWith(old + '/')) { row.path = name + row.path.slice(old.length); store.put(table, row, parent); }
    }
    project.folder = name;
    return () => renameSync(dest, join(store.directory, old));
  } catch (error) {
    if (existsSync(dest) && !existsSync(join(store.directory, old))) renameSync(dest, join(store.directory, old));
    throw error;
  }
}

// Filesystem renames cannot join a SQLite transaction. Keep their original paths
// until the outer commit so an interrupted delete can restore or finish on restart.
const deleteManifest = '.project-delete.json';
function deletionPath(store, path) {
  if (typeof path !== 'string' || !path || isAbsolute(path) || /[\\\x00-\x1f]/.test(path)) fail('项目素材路径无效，未删除任何资料', 409);
  const target = resolve(store.directory, path), inside = relative(resolve(store.directory), target);
  if (!inside || inside === '..' || inside.startsWith('../') || isAbsolute(inside) || inside !== path) fail('项目素材路径越出工作区或未规范化，未删除任何资料', 409);
  let current = store.directory;
  for (const part of inside.split('/')) {
    current = join(current, part);
    try { if (lstatSync(current).isSymbolicLink()) fail('项目素材路径包含符号链接，未删除任何资料', 409); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return target;
}
function restoreDeletion(store, staging, manifest) {
  for (let i = manifest.paths.length - 1; i >= 0; i--) {
    const saved = join(staging, String(i));
    if (!existsSync(saved)) continue;
    const original = deletionPath(store, manifest.paths[i]);
    if (existsSync(original)) fail('删除回滚的原位置已有资料，请保留暂存目录并恢复备份', 409);
    mkdirSync(dirname(original), { recursive: true });
    renameSync(saved, original);
  }
  rmSync(staging, { recursive: true, force: true });
}
function finishDeletion(staging, manifest) {
  try {
    manifest.paths.forEach((_, i) => rmSync(join(staging, String(i)), { recursive: true, force: true }));
    rmSync(staging, { recursive: true, force: true });
    return false;
  } catch { return true; }
}
export function stageProjectDeletion(store, project, paths, sharedPaths = []) {
  const folder = project.folder;
  const root = realpathSync(store.directory);
  sharedPaths = sharedPaths.map(path => {
    const file = resolve(root, path); return relative(root, existsSync(file) ? realpathSync(file) : file);
  });
  if (folder) {
    validateFolderName(folder);
    const directory = deletionPath(store, folder);
    if (existsSync(directory)) {
      const marker = join(directory, '.project-id');
      if (!lstatSync(directory).isDirectory() || !existsSync(marker) || !lstatSync(marker).isFile() || lstatSync(marker).isSymbolicLink() || readFileSync(marker, 'utf8') !== project.id)
        fail('项目文件夹归属不一致，未删除任何资料', 409);
      if (sharedPaths.some(path => path === folder || path.startsWith(folder + '/')))
        fail('项目文件夹仍含共用素材，未删除任何资料', 409);
    }
  }
  const shared = new Set(sharedPaths.map(path => resolve(store.directory, path)));
  const files = [...new Set(paths)].filter(Boolean).filter(path => !shared.has(resolve(store.directory, path)));
  for (const path of files) {
    if (!['audio', 'masters', 'exports'].some(kind => path.startsWith(kind + '/')) && !(folder && path.startsWith(folder + '/')))
      fail('项目素材不在本项目或系统素材目录，未删除任何资料', 409);
    deletionPath(store, path);
  }
  const sources = [...(folder ? [folder] : []), ...files.filter(path => !folder || !path.startsWith(folder + '/'))]
    .filter(path => existsSync(deletionPath(store, path)));
  if (!sources.length) return { undo() {}, finish: () => false };
  const staging = mkdtempSync(join(store.directory, '.project-delete-'));
  const manifest = { projectId: project.id, paths: sources };
  try {
    writeFileSync(join(staging, deleteManifest), JSON.stringify(manifest), { flag: 'wx', mode: 0o600 });
    sources.forEach((path, i) => renameSync(deletionPath(store, path), join(staging, String(i))));
  } catch (error) { restoreDeletion(store, staging, manifest); throw error; }
  return {
    undo: () => restoreDeletion(store, staging, manifest),
    finish: () => finishDeletion(staging, manifest),
  };
}
export function recoverProjectDeletions(store, projectId) {
  let pending = false;
  for (const entry of readdirSync(store.directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('.project-delete-') || store.all('projects').some(p => p.folder === entry.name)) continue;
    const staging = join(store.directory, entry.name), marker = join(staging, deleteManifest);
    if (!existsSync(marker)) continue;
    if (!lstatSync(marker).isFile() || lstatSync(marker).isSymbolicLink()) fail('删除暂存记录无效，请保留目录并恢复备份');
    const manifest = JSON.parse(readFileSync(marker, 'utf8'));
    if (typeof manifest.projectId !== 'string' || !Array.isArray(manifest.paths)) fail('删除暂存记录无效，请保留目录并恢复备份');
    if (projectId !== undefined && manifest.projectId !== projectId) continue;
    manifest.paths.forEach(path => deletionPath(store, path));
    if (store.maybe('projects', manifest.projectId)) restoreDeletion(store, staging, manifest);
    else pending = finishDeletion(staging, manifest) || pending;
  }
  return pending;
}
export function recoverProjectFolders(store) {
  recoverProjectDeletions(store);
  for (const project of store.all('projects').filter(p => p.folder)) {
    if (existsSync(join(store.directory, project.folder))) continue;
    const found = readdirSync(store.directory, { withFileTypes: true }).filter(e => e.isDirectory()).find(e => {
      try { return readFileSync(join(store.directory, e.name, '.project-id'), 'utf8') === project.id; } catch { return false; }
    });
    if (found) renameSync(join(store.directory, found.name), join(store.directory, project.folder));
    else fail(`项目文件夹缺失：${project.name}，请恢复备份`);
  }
}
