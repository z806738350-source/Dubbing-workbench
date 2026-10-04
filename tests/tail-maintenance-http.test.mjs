import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../server/index.mjs';

test('tail maintenance HTTP requires the actual server preview, scope and current versions; never accepts caller crop frames', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'tail-maintenance-http-')), app = await startServer({ port: 0, directory, config: { key: '' } });
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  const p = app.domain.mutate('project.create', { name: '本地清理范围' });
  const c = app.domain.mutate('chapter.create', { projectId: p.id, title: '第一章', source: '保持正常内容。', segment: true });
  const base = `http://127.0.0.1:${app.server.address().port}/api/audio-tail`;
  const post = async (path, body) => { const r = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, data: await r.json() }; };
  const scope = { projectId: p.id, chapterId: c.id }, unitIds = app.domain.chapter(c.id).units.map(u => u.id);
  const preview = await post('/preview', { ...scope, unitIds }); assert.equal(preview.status, 200);
  assert.equal((await post('/apply', { ...scope, scopeId: 'forged' })).status, 404);
  assert.equal((await post('/apply', { ...scope, scopeId: preview.data.scope.id, cutFrame: 1 })).status, 400);
  const result = await post('/apply', { ...scope, scopeId: preview.data.scope.id }); assert.equal(result.status, 200); assert.equal(result.data.cleaned, 0);
  app.domain.mutate('chapter.update', { chapterId: c.id, revision: app.store.get('chapters', c.id).revision, gap: 0.7 });
  assert.equal((await post('/apply', { ...scope, scopeId: preview.data.scope.id })).status, 409);
  assert.equal(app.store.all('attempts').length, 0);
});
