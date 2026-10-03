import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, symlinkSync, renameSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openStore, uid } from '../server/store.mjs';
import { createDomain } from '../server/domain.mjs';
import { copyWorkspace, readRuntime, workspaceDiagnostics, workspaceDirectory, workspaceIdentity } from '../server/workspace.mjs';
import { buildMaster, ffmpeg } from '../server/audio.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'dubbing-storage-v3-')), store = openStore(join(root, 'source'));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, store, domain: createDomain(store) };
}

test('新语义库拒绝旧v2写入器，只读备份仍能读取且旧记录不被重写', t => {
  const { store } = fixture(t), record = { id: uid(), prompt: '历史提示保持原样', input: { template: 'scene-v3-native' } };
  store.put('audios', record);
  assert.equal(store.get('settings', 'data-schema').version, 3);
  const old = new DatabaseSync(join(store.directory, 'workbench.sqlite'));
  t.after(() => old.close()); old.function('workbench_schema_version', () => 2);
  assert.throws(() => old.prepare('UPDATE audios SET data=? WHERE id=?').run(JSON.stringify({ ...record, prompt: 'old writer' }), record.id), /Unsupported/);
  assert.throws(() => old.prepare('DELETE FROM audios WHERE id=?').run(record.id), /Unsupported/);
  assert.deepEqual(store.get('audios', record.id), record);
  const reader = new DatabaseSync(join(store.directory, 'workbench.sqlite'), { readOnly: true });
  assert.equal(JSON.parse(reader.prepare('SELECT data FROM audios WHERE id=?').get(record.id).data).prompt, record.prompt); reader.close();
});

test('缺失派生母版按保存配方本地重建再迁移，历史导出和源目录保留', async t => {
  const { root, store, domain } = fixture(t), project = domain.mutate('project.create', { name: '保留原件' });
  const chapter = domain.mutate('chapter.create', { projectId: project.id, title: '第一章', source: '风吹过山洞。', segment: true });
  const s = domain.list(chapter.id)[0], path = 'audio/original.wav'; mkdirSync(join(store.directory, 'audio'));
  execFileSync(ffmpeg, ['-v','error','-f','lavfi','-i','sine=frequency=440:duration=0.2','-c:a','pcm_s16le',join(store.directory,path)]);
  const a = { id: uid(), path }; store.put('audios', a, chapter.id);
  const id = uid(), master = { id, chapterId: chapter.id, ...(await buildMaster(store, [{ s, a }], 0.5, id)) };
  store.put('masters', master, chapter.id); rmSync(join(store.directory, master.path));
  mkdirSync(join(store.directory, 'exports')); writeFileSync(join(store.directory, 'exports/history.wav'), 'historical export bytes');
  store.put('exports', { id: uid(), path: 'exports/history.wav', masterId: id }, chapter.id);
  const diagnostics = workspaceDiagnostics(store); assert.equal(diagnostics.primaryAvailable,true); assert.deepEqual(diagnostics.missing,[{kind:'masters',id:master.id,path:master.path,repairable:true}]);
  const target = await copyWorkspace(store, join(root, 'moved')), copy = openStore(target);
  try {
    const rebuilt = copy.get('masters', id);
    assert.equal(rebuilt.frames, master.frames); assert.deepEqual(rebuilt.mapping, master.mapping);
    assert.ok(existsSync(join(target, rebuilt.path))); assert.equal(existsSync(join(store.directory, master.path)), false);
    assert.equal(readFileSync(join(target, project.name, 'exports/history.wav'), 'utf8'), 'historical export bytes');
    assert.ok(existsSync(join(store.directory, a.path)));
  } finally { copy.close(); }
  rmSync(join(store.directory, a.path)); assert.equal(workspaceDiagnostics(store).primaryAvailable,false);
  await assert.rejects(copyWorkspace(store, join(root, 'missing-source')), /原始素材.*original.wav/);
  assert.equal(existsSync(join(root, 'missing-source')), false);
});

test('运行标记损坏、零或负PID只给诊断，不删除标记或探测进程组', t => {
  const { root } = fixture(t), path = join(root, 'runtime.json');
  for (const content of ['{broken', JSON.stringify({pid:0,port:4318}), JSON.stringify({pid:-1,port:4318}), JSON.stringify({pid:1,port:70000})]) {
    writeFileSync(path, content); assert.throws(() => readRuntime(path), /运行记录/); assert.equal(readFileSync(path, 'utf8'), content);
  }
  writeFileSync(path, JSON.stringify({pid:process.pid,port:4318})); assert.deepEqual(readRuntime(path), {pid:process.pid,port:4318});
});

test('A94 已保存位置断开或原数据库缺失不初始化空库，首次默认与显式DATA_DIR仍可初始化', t => {
  const root=mkdtempSync(join(tmpdir(),'dubbing-saved-location-')),config=join(root,'config.json'),saved=process.env.DATA_DIR;
  delete process.env.DATA_DIR;t.after(()=>{if(saved===undefined)delete process.env.DATA_DIR;else process.env.DATA_DIR=saved;rmSync(root,{recursive:true,force:true});});
  assert.equal(workspaceDirectory(config),fileURLToPath(new URL('../data',import.meta.url)));
  const missing=join(root,'disconnected');writeFileSync(config,JSON.stringify({directory:missing}));const original=readFileSync(config,'utf8');
  assert.throws(()=>workspaceDirectory(config),/保存位置.*不可用|原数据库.*缺失/);assert.equal(existsSync(missing),false);assert.equal(readFileSync(config,'utf8'),original);
  const empty=join(root,'empty');mkdirSync(empty);writeFileSync(config,JSON.stringify({directory:empty}));assert.throws(()=>workspaceDirectory(config),/原数据库.*缺失/);assert.equal(existsSync(join(empty,'workbench.sqlite')),false);
  writeFileSync(join(empty,'workbench.sqlite'),'');assert.throws(()=>workspaceDirectory(config),/原数据库.*缺失/);assert.equal(readFileSync(join(empty,'workbench.sqlite'),'utf8'),'');
  const valid=join(root,'valid'),store=openStore(valid);store.put('settings',{id:'preserved',value:'原库资料'});store.close();writeFileSync(config,JSON.stringify({directory:valid}));assert.equal(workspaceDirectory(config),valid);
  const alias=join(root,'valid-alias');symlinkSync(valid,alias,'dir');writeFileSync(config,JSON.stringify({directory:alias}));assert.equal(workspaceDirectory(config),alias);
  process.env.DATA_DIR=join(root,'explicit-new');assert.equal(workspaceDirectory(config),process.env.DATA_DIR);assert.equal(existsSync(process.env.DATA_DIR),false);
});

test('A86 原生库身份在别名/重启后稳定，同路径恢复同ID同revision备份仍区分库文件且state复用', async t => {
  const root=mkdtempSync(join(tmpdir(),'dubbing-db-identity-')),active=join(root,'active'),fork=join(root,'fork'),alias=join(root,'alias');
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  let store=openStore(active),domain=createDomain(store);const project=domain.mutate('project.create',{name:'工作区身份'}),chapter=domain.mutate('chapter.create',{projectId:project.id,title:'自拟章',source:'自拟原正文。',segment:true}),segment=domain.list(chapter.id)[0];
  mkdirSync(fork);store.db.exec(`VACUUM INTO '${join(fork,'workbench.sqlite')}'`);symlinkSync(active,alias,'dir');
  const identity=workspaceIdentity(active);assert.equal(workspaceIdentity(alias),identity);assert.ok(JSON.parse(identity).slice(1).every(value=>typeof value==='string'&&/^\d+$/.test(value)));
  domain.mutate('segment.update',{chapterId:chapter.id,revision:domain.chapter(chapter.id).revision,id:segment.id,text:'A分支'});assert.equal(workspaceIdentity(active),identity);store.close();
  store=openStore(active);assert.equal(workspaceIdentity(active),identity);store.close();
  const other=openStore(fork),otherDomain=createDomain(other);otherDomain.mutate('segment.update',{chapterId:chapter.id,revision:otherDomain.chapter(chapter.id).revision,id:segment.id,text:'B分支'});other.close();
  renameSync(active,join(root,'retained'));mkdirSync(active);copyFileSync(join(fork,'workbench.sqlite'),join(active,'workbench.sqlite'));store=openStore(active);domain=createDomain(store);
  try {assert.equal(domain.list(chapter.id)[0].id,segment.id);assert.equal(domain.chapter(chapter.id).revision,2);assert.equal(domain.list(chapter.id)[0].text,'B分支');assert.notEqual(workspaceIdentity(active),identity);assert.equal(workspaceIdentity(alias),workspaceIdentity(active));}finally{store.close();}
  const {startServer}=await import('../server/index.mjs'),app=await startServer({port:0,directory:alias,workspaceConfig:join(root,'unused-config.json'),config:{key:''}});
  try {const state=await (await fetch(`http://127.0.0.1:${app.server.address().port}/api/state`)).json();assert.equal(state.settings.workspaceIdentity,workspaceIdentity(active));assert.equal(state.settings.configured,false);}finally{await app.close();}
});

test('升级中断回滚DDL及连接写入资格，不把旧库留在半升级状态', t => {
  const root = mkdtempSync(join(tmpdir(), 'dubbing-upgrade-rollback-'));
  t.after(() => rmSync(root, {recursive:true,force:true}));
  const seed = openStore(root); seed.put('settings', {id:'data-schema',version:2}); seed.close();
  const legacy = new DatabaseSync(join(root,'workbench.sqlite'));
  legacy.exec("CREATE TRIGGER schema_v2_settings_UPDATE BEFORE UPDATE ON settings BEGIN SELECT CASE WHEN workbench_schema_version() <> 2 THEN RAISE(ABORT,'old capability') END; END"); legacy.close();
  const store = openStore(root); t.after(() => store.close());
  assert.throws(() => store.transaction(() => { store.protectSchema(); store.put('settings',{id:'data-schema',version:3}); throw Error('injected upgrade interruption'); }), /interruption/);
  assert.equal(store.get('settings','data-schema').version,2);
  store.put('settings',{id:'data-schema',version:2,rollbackVerified:true});
  assert.ok(store.db.prepare("SELECT name FROM sqlite_master WHERE name='schema_v2_settings_UPDATE'").get());
  assert.equal(store.db.prepare("SELECT name FROM sqlite_master WHERE name='schema_v3_settings_UPDATE'").get(),undefined);
  createDomain(store); assert.equal(store.get('settings','data-schema').version,3);
});
