import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync, mkdirSync, renameSync, writeFileSync, readdirSync, rmSync, lstatSync, statSync, mkdtempSync, realpathSync } from 'node:fs';
import { cp, lstat, mkdir, realpath, rename, rm, writeFile, readdir, mkdtemp } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { fail, openStore, same } from './store.mjs';
import { renderProfileOf, LEGACY_RENDER_PROFILE, DEFAULT_RENDER_PROFILE, prepareAudioSource } from './audio-range.mjs';
import { fileTreeBytes, reserveDiskSpace } from './disk-space.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
export const workspaceConfig = join(root, '.workspace-local.json');
export function readRuntime(path) {
  if (!existsSync(path)) return null;
  let value;
  try { value = JSON.parse(readFileSync(path, 'utf8')); }
  catch { fail('工作区运行记录损坏，请检查原启动窗口；资料仍保留，未删除任何文件'); }
  if (!value || !Number.isSafeInteger(value.pid) || value.pid < 1 || !Number.isInteger(value.port) || value.port < 0 || value.port > 65535)
    fail('工作区运行记录无效，请检查原启动窗口；资料仍保留，未删除任何文件');
  return value;
}
export function workspaceDirectory(config = workspaceConfig) {
  if (process.env.DATA_DIR) return resolve(process.env.DATA_DIR);
  if (existsSync(config)) {
    const { directory } = JSON.parse(readFileSync(config, 'utf8'));
    if (typeof directory !== 'string' || !isAbsolute(directory)) fail('保存位置配置无效，请检查 .workspace-local.json');
    try {
      const database=statSync(join(directory,'workbench.sqlite'));
      if (!statSync(directory).isDirectory() || !database.isFile() || !database.size) throw Error('missing workspace');
    } catch { fail('已保存位置不可用或原数据库缺失，请连接原位置或恢复整份备份；未初始化空工作区、未修改原配置'); }
    return directory;
  }
  return join(root, 'data');
}
export function workspaceIdentity(directory) {
  const {dev,ino}=statSync(join(directory,'workbench.sqlite'),{bigint:true});
  return JSON.stringify([realpathSync(directory),dev.toString(),ino.toString()]);
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

// All local files held by a record, including a received result not yet registered.
// Planned files may not exist; retaining them never proves provider completion.
export function recordFiles(item, attempt = false) {
  const path = item.path || (attempt ? `audio/${item.id}.wav` : null);
  return [...new Set([path, item.sourcePath, item.delivery?.rawPath, item.delivery?.manifestPath, item.processing?.resultPath,
    ...(attempt && item.deliveryVersion ? [`${path}.delivery.json`, `${path.slice(0, -4)}.processed.wav`] : [])].filter(Boolean))];
}

// Recovery needs object ownership, never every chapter's text or audio history.
export function locateDraftChapters(store, ids) {
  if (!Array.isArray(ids) || ids.length > 1000 || ids.some(id => typeof id !== 'string' || !id || id.length > 260)) fail('暂存定位范围无效');
  const chapters = new Map();
  const add = (chapterId, table, record) => {
    if (!chapterId) return;
    const chapter = store.maybe('chapters', chapterId);
    if (!chapter) return;
    if (!chapters.has(chapter.id)) chapters.set(chapter.id, { id: chapter.id, projectId: chapter.projectId, title: chapter.title, segments: [], units: [], events: [] });
    if (record && !chapters.get(chapter.id)[table].some(item => item.id === record.id)) chapters.get(chapter.id)[table].push(record);
  };
  for (const id of ids) {
    const [type, raw, context] = id.split('/'), key = raw || id;
    const segment = store.maybe('segments', type === 'voice-session-v1' && key === 'new-voice-context' ? context || '' : key);
    if (segment) add(segment.chapterId, 'segments', { id: segment.id, order: segment.order, text: segment.text.slice(0, 24), roleId: segment.roleId });
    if (type === 'unit-v1' && key.startsWith('new-')) add(key.slice(4));
    if (type === 'unit-v1' || type === 'sound-event-v1') {
      const event = type === 'sound-event-v1' && store.maybe('events', key);
      const unit = store.maybe('units', event?.unitId || key.replace(/^new-/, ''));
      if (unit) {
        add(unit.chapterId, 'units', { id: unit.id, kind: unit.kind, state: unit.state });
        if (event) add(unit.chapterId, 'events', { id: event.id, unitId: event.unitId, description: (event.description || '').slice(0, 24) });
      }
    }
    if (type === 'voice-session-v1' && key === 'new-voice-context') add(context);
  }
  return [...chapters.values()];
}
export function assertMasterRecipe(master) {
  let cursor=0;
  // Identity metadata can describe today's plan; only boundaryGapFrames freezes a historical local-gap recipe.
  const gaps=master.boundaryGapFrames;
  if(gaps!==undefined&&(!Array.isArray(gaps)||gaps.length!==Math.max(0,(master.mapping?.length || 0)-1)||gaps.some(frames=>!Number.isSafeInteger(frames)||frames<0)))fail(`母版 ${master.path} 的边界配方不完整，历史文件仍保留`,409);
  if(gaps!==undefined&&master.auditoryBoundaryPlan&&!same(master.auditoryBoundaryPlan.gapFrames,gaps))fail(`母版 ${master.path} 的冻结边界与配方不一致，历史文件仍保留`,409);
  const valid=Array.isArray(master.mapping)&&master.mapping.length>0&&master.mapping.every((m,index)=>{
    if(!m || typeof m.audioId!=='string' || !m.audioId || !Number.isSafeInteger(m.startFrame) || !Number.isSafeInteger(m.endFrame) || m.startFrame!==cursor || m.endFrame<=m.startFrame)return false;
    const gap=index<master.mapping.length-1?(gaps?.[index]??master.gapFrames):0;
    if(m.gapAfterFrames!==undefined&&m.gapAfterFrames!==gap)return false;
    cursor=m.endFrame+gap;return true;
  });
  if (!valid || !Number.isSafeInteger(master.frames) || master.frames < 1 || cursor!==master.frames || !Number.isSafeInteger(master.gapFrames) || master.gapFrames < 0 || ![LEGACY_RENDER_PROFILE,DEFAULT_RENDER_PROFILE].includes(renderProfileOf(master)) || master.processing !== `pcm_s16le-48000-${renderProfileOf(master)===LEGACY_RENDER_PROFILE?'mono':'stereo'}`)
    fail(`母版 ${master.path} 的本地重建配方不完整，历史文件仍保留`,409);
}
export async function historicalMasterRows(store, master, { signal } = {}) {
  assertMasterRecipe(master);
  const job=master.jobId && store.maybe('jobs',master.jobId), rows=[];
  for (const [index,m] of master.mapping.entries()) {
    signal?.throwIfAborted();
    const current=store.maybe('audios',m.audioId), frozen=job?.renderRows?.[index];
    if (!current?.path || !existsSync(deletionPath(store,current.path))) fail(`母版 ${master.path} 的原始音频缺失：${m.audioId}，不能重新录制替代`,409);
    const a=frozen?.a?.id===m.audioId ? {...current,...frozen.a,path:current.path} : current;
    let range;
    if (m.sourceHash || m.decodeProfile || m.rangeRevision) {
      const source=await prepareAudioSource(store,a.id,{signal});
      signal?.throwIfAborted();
      if (source.sourceHash!==m.sourceHash || source.decodeProfile!==m.decodeProfile) fail(`母版 ${master.path} 的裁剪源身份已变化，历史仍保留`,409);
      range={...source,unitId:m.unitId || m.segmentId,mode:m.mode || 'dry',startFrame:m.clipStartFrame,endFrame:m.clipEndFrame,revision:m.rangeRevision,edgePolicy:m.edgePolicy};
      if (frozen?.a?.id===m.audioId && frozen.range) range={...frozen.range,...range};
    }
    rows.push({a,...(range?{range}:{}),...(master.boundaryGapFrames?{gapAfterFrames:master.boundaryGapFrames[index] || 0}:{}),s:{id:m.unitId || m.segmentId,chapterId:master.chapterId,unitId:m.unitId,members:m.memberIds,kind:m.memberIds?.length>1?'group':'single',mode:m.mode}});
  }
  return rows;
}
export function verifyRebuiltMaster(master, rebuilt) {
  if (rebuilt.frames!==master.frames || rebuilt.gapFrames!==master.gapFrames || master.boundaryGapFrames&&!same(master.boundaryGapFrames,rebuilt.boundaryGapFrames) || rebuilt.channels!==(master.channels || (renderProfileOf(master)===LEGACY_RENDER_PROFILE?1:2)) || rebuilt.sampleRate!==(master.sampleRate || 48000) || renderProfileOf(rebuilt)!==renderProfileOf(master) || rebuilt.mapping.length!==master.mapping.length || master.mapping.some((m,i)=>Object.keys(m).some(key=>!same(m[key],rebuilt.mapping[i][key]))))
    fail(`母版 ${master.path} 的重建配方与原始音频不一致，历史仍保留`,409);
}
function mapRecordFiles(item, map) {
  if (item.path) item.path = map(item.path);
  if (item.sourcePath) item.sourcePath = map(item.sourcePath);
  if (item.delivery) item.delivery = { ...item.delivery, rawPath: map(item.delivery.rawPath), manifestPath: map(item.delivery.manifestPath) };
  if (item.processing?.resultPath) item.processing = { ...item.processing, resultPath: map(item.processing.resultPath) };
}
export async function verifyWorkspaceDeliveries(directory, attempts) {
  const { verifyAudioDelivery } = await import('./audio-delivery.mjs');
  for (const attempt of attempts) {
    if (!attempt.delivery && !attempt.deliveryVersion) continue;
    const path = attempt.path || `audio/${attempt.id}.wav`, manifest = `${path}.delivery.json`;
    if (!attempt.delivery && !existsSync(join(directory, manifest))) continue;
    for (const file of recordFiles(attempt, true).flatMap(path => [path, `${path}.part`])) deletionPath({ directory }, file);
    await verifyAudioDelivery({ directory }, attempt);
  }
}

// Attachment IDs and byte counts cannot detect same-length file corruption. The
// hashes already stored at upload bind both the received image and its derivative.
export async function verifyWorkspaceAttachments(directory, attachments) {
  const { audioDigest } = await import('./audio-delivery.mjs');
  const unverifiedSources = [];
  for (const item of attachments.filter(item => item.state !== 'deleted')) {
    for (const [path, bytes, hash, original] of [[item.path, item.bytes, item.hash, false], [item.sourcePath, item.sourceBytes, item.sourceHash, true]]) {
      if (!path) { if (original) unverifiedSources.push(item.id); continue; }
      const file = deletionPath({ directory }, path), actual = await audioDigest(file);
      if (!Number.isSafeInteger(bytes) || actual.bytes !== bytes || (hash && actual.sha256 !== hash) || (!original && !hash))
        fail(`助手截图${original ? '原件' : '处理版'}完整性校验失败：${item.id}`);
      if (original && !hash) unverifiedSources.push(item.id);
    }
  }
  return { unverifiedSources };
}

// Read-only inventory: original recordings and historical exports are not caches.
export function workspaceDiagnostics(store) {
  const counts = {}, bytes = {}, missing = [], reclaimedMasters=[], root = realpathSync(store.directory), counted = new Set();
  const available = path => {
    if (!path) return false;
    try { const file = deletionPath(store, path); return lstatSync(file).isFile(); } catch { return false; }
  };
  const account = (kind, path) => {
    if (!counted.has(path)) { counted.add(path); bytes[kind] += lstatSync(resolve(root, path)).size; }
  };
  for (const kind of ['voices','audios','masters','exports','assistantAttachments']) {
    const rows = store.all(kind).filter(item => item.path && item.state !== 'deleted');
    counts[kind] = rows.length; bytes[kind] = 0;
    for (const item of rows) for (const path of recordFiles(item)) {
      if (available(path)) { account(kind, path); continue; }
      let repairable=false;
      if(kind==='masters'&&path===item.path)try{assertMasterRecipe(item);repairable=item.mapping.every(m=>available(store.maybe('audios',m.audioId)?.path));}catch{}
      if(repairable&&item.fileReclaimedAt){reclaimedMasters.push({id:item.id,chapterId:item.chapterId,path:item.path});continue;}
      missing.push({kind,id:item.id,path,repairable:!!repairable});
    }
  }
  const deliveries = store.all('attempts').filter(a => a.delivery || a.deliveryVersion && existsSync(join(root, `${a.path || `audio/${a.id}.wav`}.delivery.json`)));
  counts.deliveries = deliveries.length; bytes.deliveries = 0;
  for (const attempt of deliveries) {
    const raw = attempt.delivery?.rawPath || attempt.path || `audio/${attempt.id}.wav`;
    const required = new Set([raw, attempt.delivery?.manifestPath || `${raw}.delivery.json`, attempt.processing?.resultPath].filter(Boolean));
    for (const path of recordFiles(attempt, true)) {
      if (available(path)) { account('deliveries', path); continue; }
      if (path === raw && available(`${raw}.part`)) { account('deliveries', `${raw}.part`); continue; }
      if (required.has(path)) missing.push({kind:'deliveries',id:attempt.id,path,repairable:false});
    }
  }
  counts.reclaimedMasters=reclaimedMasters.length;
  return {scope:'current-workspace',counts,bytes,missing,reclaimedMasters,primaryAvailable:missing.every(item=>item.kind === 'masters' && item.repairable),totalReferencedBytes:Object.values(bytes).reduce((a,b)=>a+b,0)};
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
  const folders = [...new Set(['voices', 'audio', 'masters', 'exports', 'output', 'assistant', ...store.all('projects').map(p => p.folder).filter(Boolean)])].filter(folder=>existsSync(join(source,folder)));
  let bytes = (await lstat(join(source,'workbench.sqlite'))).size;
  if (existsSync(join(source,'workbench.sqlite-wal'))) bytes += (await lstat(join(source,'workbench.sqlite-wal'))).size;
  for (const folder of folders) bytes += await fileTreeBytes(join(source,folder));
  const reservation = reserveDiskSpace(parent, bytes, '迁移项目资料');
  let staging;
  try {
    staging = await mkdtemp(join(parent, '.dubbing-move-'));
    await verifyWorkspaceDeliveries(source, store.all('attempts'));
    await verifyWorkspaceAttachments(source, store.all('assistantAttachments'));
    // SQLite creates a consistent database copy including committed WAL contents.
    store.db.exec(`VACUUM INTO '${join(staging, 'workbench.sqlite').replaceAll("'", "''")}'`);
    for (const folder of folders) {
      await cp(join(source, folder), join(staging, folder), {
        recursive: true, force: false, errorOnExist: true,
        filter: async path => {
          if ((await lstat(path)).isSymbolicLink()) fail('素材目录含符号链接，请先整理为实际文件再迁移');
          return true;
        },
      });
    }
    reservation.release();
    const missingMasters = [], reclaimedMasters=[];
    const db = new DatabaseSync(join(staging, 'workbench.sqlite'), { readOnly: true });
    try {
      if (Object.values(db.prepare('PRAGMA integrity_check').get())[0] !== 'ok') fail('新位置的数据库校验失败');
      for (const table of ['voices', 'audios', 'masters', 'exports', 'attempts', 'assistantAttachments']) {
        for (const { data } of db.prepare(`SELECT data FROM ${table}`).all()) {
          const item = JSON.parse(data);
          if (item.state === 'deleted') continue;
          const required = new Set(recordFiles(item));
          if (table === 'attempts') required.delete(item.path);
          for (const file of recordFiles(item, table === 'attempts')) {
            const path = resolve(staging, file);
            if (!inside(staging, path)) fail(`素材路径无效：${file}，未切换保存位置`);
            if (!existsSync(path)) {
              if (table === 'masters' && file === item.path) {if(item.fileReclaimedAt){assertMasterRecipe(item);reclaimedMasters.push(item);}else missingMasters.push(item);continue;}
              if (table === 'attempts' && (!required.has(file) || file === item.delivery?.rawPath && existsSync(path + '.part'))) continue;
              fail(`原始素材或历史导出缺失：${file}，请恢复文件后再迁移`);
            }
            const a = await lstat(resolve(source, file)), b = await lstat(path);
            if (!a.isFile() || !b.isFile() || a.size !== b.size) fail('新位置的素材校验失败');
          }
        }
      }
    } finally { db.close(); }
    const copy = openStore(staging);
    try {
      for(const master of reclaimedMasters)for(const mapping of master.mapping) {
        const audio=copy.maybe('audios',mapping.audioId);
        if(!audio?.path || !existsSync(deletionPath(copy,audio.path)) || mapping.sourceHash&&!copy.maybe('units',mapping.unitId||mapping.segmentId))fail(`历史母版 ${master.path} 的本地恢复原件或裁剪归属缺失，未切换保存位置`,409);
      }
      if (missingMasters.length) {
        const { buildMaster } = await import('./audio.mjs');
        for (const master of missingMasters) {
          const rows=await historicalMasterRows(copy,master);
          const rebuilt = await buildMaster(copy, rows, master.gapFrames / 48000, master.id, renderProfileOf(master),{boundaryPlan:master.boundaryGapFrames?master.auditoryBoundaryPlan:undefined});
          verifyRebuiltMaster(master,rebuilt);
          copy.put('masters', { ...master, ...rebuilt, mapping:master.mapping, invalid: false, rebuiltAt: new Date().toISOString() }, master.chapterId);
        }
      }
      organizeProjects(copy);
      await verifyWorkspaceDeliveries(staging, copy.all('attempts'));
      await verifyWorkspaceAttachments(staging, copy.all('assistantAttachments'));
    } finally { copy.close(); }
    await rename(staging, target);
    return target;
  } catch (error) {
    if (staging) await rm(staging, { recursive: true, force: true });
    throw error;
  } finally { reservation.release(); }
}

export function projectFile(store, chapterId, kind, filename) {
  const c = chapterId && store.maybe('chapters', chapterId);
  const folder = c && store.get('projects', c.projectId).folder;
  return join(folder || '', kind, filename);
}

export function projectExportFile(store, { chapterId, arrangement, id, format }) {
  if (typeof id !== 'string' || !/^[\w-]+$/.test(id) || !['wav', 'mp3'].includes(format)) fail('导出文件标识或格式无效');
  const chapter = store.get('chapters', chapterId);
  const title = Array.from(chapter.title.replace(/[/\\:\x00-\x1f]/g, '-').trim().replace(/^\.+/, '')).slice(0, 40).join('') || '章节';
  return projectFile(store, chapterId, 'output', `${title}-编排${arrangement ?? chapter.arrangement}-${id}.${format}`);
}

export async function revealExport(store, id, run = promisify(execFile)) {
  return revealOutput(store,'export',id,run);
}
export async function revealOutput(store, kind, id, run = promisify(execFile)) {
  if (!['master','export'].includes(kind)) fail('成品类型无效');
  const record = store.get(kind==='master'?'masters':'exports', id);
  if (!record.path) fail('成品文件已不存在，请重新导出', 404);
  const root = realpathSync(store.directory), file = resolve(root, record.path);
  let actual, info;
  try { actual = realpathSync(file); info = lstatSync(file); }
  catch (error) { if (error.code === 'ENOENT') fail('成品文件已不存在，请重新导出', 404); throw error; }
  const inside = relative(root, actual);
  if (!inside || inside === '..' || inside.startsWith('../') || isAbsolute(inside) || !info.isFile())
    fail('成品文件不在工作区内或不是普通文件', 403);
  if (process.platform !== 'darwin') fail('当前打开成品位置功能仅支持 macOS', 501);
  try { await run('/usr/bin/open', ['-R', file], { timeout: 10000 }); }
  catch { fail('无法打开成品位置，请在项目的 output 文件夹查看'); }
  return { path: file };
}

function validateFolderSegment(name) {
  if (typeof name !== 'string' || !name || name === '.' || name === '..' || /[/\\\x00-\x1f]/.test(name))
    fail('项目名称不能包含斜杠、控制字符或与工作区系统目录重名');
}
function validateFolderName(name) {
  validateFolderSegment(name);
  if (['voices', 'audio', 'masters', 'exports', 'output', 'assistant', 'workbench.sqlite', 'runtime.json'].includes(name.toLowerCase()))
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
  return [...store.all('chapters', project.id).flatMap(c => [
    ...['audios', 'masters', 'exports'].flatMap(table => store.all(table, c.id).map(row => [table, row, c.id])),
    ...store.all('jobs', c.id).flatMap(j => store.all('attempts', j.id).map(row => ['attempts', row, j.id])),
  ]), ...store.all('assistantAttachments').filter(a => a.projectId === project.id).map(a => ['assistantAttachments', a, a.sessionId])];
}

function organizeProjects(store) {
  store.transaction(() => {
    for (const project of store.all('projects')) {
      if (!project.folder) createProjectFolder(store, project);
      store.put('projects', project);
      for (const [table, row, parent] of projectRecords(store, project)) {
        if (table === 'attempts' && !row.path) row.path = `audio/${row.id}.wav`;
        const kind = table === 'assistantAttachments' ? 'assistant/attachments' : table === 'attempts' || table === 'audios' ? 'audio' : table === 'exports' && dirname(row.path || '').split('/').at(-1) === 'output' ? 'output' : table;
        const destination = path => join(project.folder, kind, basename(path));
        for (const old of recordFiles(row, table === 'attempts')) {
          const next = destination(old);
          mkdirSync(join(store.directory, project.folder, kind), { recursive: true });
          for (const suffix of ['', '.part']) {
            if (old !== next && existsSync(join(store.directory, old + suffix)))
              renameSync(join(store.directory, old + suffix), join(store.directory, next + suffix));
          }
        }
        mapRecordFiles(row, destination);
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
      mapRecordFiles(row, path => path?.startsWith(old + '/') ? name + path.slice(old.length) : path);
      store.put(table, row, parent);
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
export function deletionPath(store, path) {
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
    // Existing folders are identified by ownership below, not today's naming rules.
    validateFolderSegment(folder);
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
    if (!['audio', 'masters', 'exports', 'output', 'assistant/attachments'].some(kind => path.startsWith(kind + '/')) && !(folder && path.startsWith(folder + '/')))
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
