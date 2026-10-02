import { existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile, spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));
process.chdir(root);
const exec = promisify(execFile);
const browse = async port => {
  const url = `http://127.0.0.1:${port}/`;
  console.log(`配音工作台：${url}`);
  try { await exec('open', [url]); }
  catch { console.log('未能自动打开浏览器，请手动打开上方地址。'); }
};

try {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 13))
    throw new Error('请安装 Node.js 22.13 或更新版本。');
  // Import the existing entry point so environment and workspace rules stay identical.
  const { startServer } = await import('../server/index.mjs');
  const { workspaceDirectory } = await import('../server/workspace.mjs');
  const directory = workspaceDirectory();
  const runtime = join(directory, 'runtime.json');
  let running;
  if (existsSync(runtime)) {
    running = JSON.parse(readFileSync(runtime, 'utf8'));
    try { process.kill(running.pid, 0); }
    catch (e) { if (e.code === 'ESRCH') running = null; else throw e; }
  }
  if (running) {
    if (!Number.isInteger(running.port) || running.port < 1 || running.port > 65535)
      throw new Error('现有服务的端口记录无效，请检查运行窗口。');
    try {
      const response = await fetch(`http://127.0.0.1:${running.port}/api/state`, { signal: AbortSignal.timeout(5000) });
      const state = await response.json();
      if (!response.ok || !Array.isArray(state.projects) || !Array.isArray(state.chapters)) throw new Error();
    } catch { throw new Error('此工作区已有进程，但服务尚未就绪；请稍后重试或检查原运行窗口。'); }
    console.log('已打开正在运行的工作区，无需重复启动。');
    await browse(running.port);
  } else {
    const { toolsAvailable } = await import('../server/audio.mjs');
    if (!await toolsAvailable()) throw new Error('未找到可用的 FFmpeg / FFprobe，请先按 README 安装音频处理工具。');
    for (const args of [...(!existsSync(join(root, 'node_modules/vite')) ? [['ci']] : []), ['run', 'build']]) {
      const result = spawnSync('npm', args, { stdio: 'inherit', cwd: root });
      if (result.error || result.status !== 0) throw new Error('准备运行环境失败，请查看上方错误信息。');
    }
    const app = await startServer({ directory });
    let stopping = false;
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, async () => {
      if (stopping) return;
      stopping = true;
      console.log('正在安全停止，等待在途任务结束…');
      await app.close();
      process.exit(0);
    });
    console.log(`工作区：${directory}\n使用期间请保留此窗口；停止请按 Control+C。`);
    await browse(app.server.address().port);
  }
} catch (error) {
  console.error(`启动失败：${error.message}`);
  process.exitCode = 1;
}
