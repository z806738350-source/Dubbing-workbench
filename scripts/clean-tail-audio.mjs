import { existsSync } from 'node:fs';
import { writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { openStore } from '../server/store.mjs';
import { createDomain } from '../server/domain.mjs';
import { readRuntime } from '../server/workspace.mjs';
import { repairProjectTails } from '../server/tail-repair.mjs';

const [directoryArg, projectId, ...extra] = process.argv.slice(2);
if (!directoryArg || !projectId || extra.length) throw new Error('用法：node scripts/clean-tail-audio.mjs 数据目录 项目ID');
const directory = resolve(directoryArg), runtime = join(directory, 'runtime.json');
if (!existsSync(join(directory, 'workbench.sqlite'))) throw new Error('数据目录缺少数据库');
const previous = readRuntime(runtime);
if (previous) {
  try {
    process.kill(previous.pid, 0);
    throw new Error('请先停止正在使用此目录的工作台，再清理尾部爆音和长空白');
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
  await rm(runtime);
}
// Reuse the server's exclusive runtime marker so it cannot start during maintenance.
await writeFile(runtime, JSON.stringify({ pid: process.pid, port: 0 }), { flag: 'wx' });
let store;
try {
  store = openStore(directory);
  store.get('projects', projectId);
  console.log(JSON.stringify(await repairProjectTails(store, createDomain(store), projectId), null, 2));
} finally {
  store?.close();
  await rm(runtime, { force: true });
}
