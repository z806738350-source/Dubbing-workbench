import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

test('双击启动入口：新建服务、重复打开复用、安全停止，不创建模型任务', { timeout: 30000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'dubbing-launch-'));
  const bin = join(dir, 'bin'), data = join(dir, 'workspace'), opened = join(dir, 'opened');
  await mkdir(bin);
  await writeFile(join(bin, 'open'), '#!/bin/sh\nprintf "%s\\n" "$1" >> "$LAUNCH_OPEN_LOG"\n', { mode: 0o755 });
  const probe = createServer();
  probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const env = { ...process.env, DATA_DIR: data, PORT: String(port), KUNPO_API_KEY: '', PATH: `${bin}:${process.env.PATH}`, LAUNCH_OPEN_LOG: opened };
  const start = () => spawn(process.execPath, ['scripts/launch.mjs'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const child = start(), closed = once(child, 'close');
  let output = '';
  child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { output += b; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGINT'); await closed; }
    await rm(dir, { recursive: true, force: true });
  });
  for (let n = 0; n < 200 && !existsSync(opened) && child.exitCode === null; n++) await new Promise(r => setTimeout(r, 100));
  assert.ok(existsSync(opened), output);
  const url = `http://127.0.0.1:${port}/`;
  assert.equal((await readFile(opened, 'utf8')).trim(), url);
  const runtime = JSON.parse(await readFile(join(data, 'runtime.json'), 'utf8'));
  assert.equal(runtime.pid, child.pid);
  const before = await (await fetch(url + 'api/state')).json();
  assert.deepEqual(before.projects, []);
  const again = start(), againClosed = once(again, 'close');
  let repeated = ''; again.stdout.on('data', b => { repeated += b; }); again.stderr.resume();
  assert.equal((await againClosed)[0], 0);
  assert.match(repeated, /无需重复启动/);
  assert.equal(JSON.parse(await readFile(join(data, 'runtime.json'), 'utf8')).pid, child.pid);
  assert.equal((await readFile(opened, 'utf8')).trim().split('\n').length, 2);
  assert.deepEqual(await (await fetch(url + 'api/state')).json(), before);
  child.kill('SIGINT');
  assert.equal((await closed)[0], 0);
  assert.equal(existsSync(join(data, 'runtime.json')), false);
});
