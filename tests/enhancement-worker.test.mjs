import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { openStore, uid } from "../server/store.mjs";
import { createDomain, basisOf, inputOf } from "../server/domain.mjs";
import { createWorker } from "../server/worker.mjs";
import { compile, listTemplates, listUnitTemplates } from "../server/templates.mjs";
import { saveCandidateVoice, drainReferenceDeletes, inspect, ffmpeg } from "../server/audio.mjs";
import { createAnalysis } from "../server/analysis.mjs";

function wav(frames = 4800) {
  const b = Buffer.alloc(44 + frames * 2);
  b.write("RIFF"); b.writeUInt32LE(b.length - 8, 4); b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(48000, 24); b.writeUInt32LE(96000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write("data", 36); b.writeUInt32LE(frames * 2, 40); return b;
}
function setup(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), "dubbing-enhancement-worker-")), store = openStore(dir), domain = createDomain(store);
  let closed = false;
  t.after(() => { if (!closed) store.close(); rmSync(dir, { recursive: true, force: true }); });
  const voices = [0, 1].map(i => {
    const v = { id: uid(), path: `reference-${i}.wav`, state: "active", revision: 1 };
    writeFileSync(join(dir, v.path), wav()); store.put("voices", v); return v;
  });
  const config = { key: "test", model: "seed-audio-1.0", audioUrl: "https://example.invalid", ...options };
  return { dir, store, domain, voices, config, worker: createWorker(store, domain, config), closeStore() { store.close(); closed = true; } };
}
const trial = v => ({ kind: "voice-test", voiceId: v.id, entityRevision: 1, text: "清晨的风很轻。", commandId: uid() });

test('F05真实Mock派发：兄弟候选取舍或入库不使B过期，自身放弃及unknown仍保护',async t=>{
  for(const scenario of ['queued-discard','inflight-discard','inflight-save','self-discard','unknown']) await t.test(scenario,async t=>{
    const {store,domain,worker}=setup(t),session=domain.mutate('voice-session.create',{description:'自然温和的声音'});
    const enqueue=(extra={})=>worker.enqueue({kind:'voice-create',sessionId:session.id,entityRevision:store.get('voiceSessions',session.id).revision,commandId:uid(),...extra});
    let calls=0,aId,bId;
    const discard=id=>domain.mutate('voice-candidate.discard',{id,sessionId:session.id,entityRevision:store.get('voiceSessions',session.id).revision});
    t.mock.method(globalThis,'fetch',async()=>{
      calls++;
      if(calls===2){
        if(scenario==='inflight-discard')discard(aId);
        if(scenario==='inflight-save')await saveCandidateVoice(store,{audioId:aId,name:'保留A'});
        if(scenario==='self-discard')discard(bId);
        if(scenario==='unknown')throw Error('mock connection dropped after sending');
      }
      return new Response(wav(),{headers:{'content-type':'audio/wav'}});
    });
    const a=enqueue();await worker.tick();aId=store.all('attempts',a.id)[0].id;
    const b=enqueue();bId=store.all('attempts',b.id)[0].id;
    if(scenario==='queued-discard'){discard(aId);domain.mutate('voice-session.update',{id:session.id,entityRevision:store.get('voiceSessions',session.id).revision,description:session.description});}
    await worker.tick();const attempt=store.get('attempts',bId);
    assert.equal(calls,2);assert.equal(attempt.input.description,session.description);
    if(scenario==='unknown'){assert.equal(attempt.status,'unknown');discard(aId);assert.throws(()=>enqueue(),/结果不明/);assert.equal(calls,2);}
    else {assert.equal(attempt.status,'success');assert.equal(attempt.adopted,scenario!=='self-discard');assert.equal(store.get('jobs',b.id).status,'success');assert.ok(store.get('audios',bId));}
    if(scenario==='inflight-save')assert.equal(store.get('voices',aId).sourceAudioId,aId);
  });
});

test("SC02 非连续真实引文可采用，保留明示与推断类别且拒绝伪造出处", async t => {
  const { store, domain } = setup(t);
  const project = domain.mutate("project.create", { name: "多出处" });
  const chapter = domain.mutate("chapter.create", { projectId: project.id, title: "独立引文", source: "门外响起两下敲门声。\n我把书放回桌上。\n门外又响起两下敲门声。", segment: true });
  const unit = domain.enhancement.getUnit(domain.list(chapter.id)[0].id);
  const analysis = createAnalysis(store, domain, { key: "fixture", baseUrl: "https://example.invalid", model: "seed-audio-1.0" });
  t.after(() => analysis.close());
  const items = ["原文明示", "上下文推断"].map(evidence => ({ unitId: unit.id, kind: "effect", description: "两下轻敲门声", memberId: unit.id, position: "during", evidence, evidenceRefs: [0, 2], reason: "两处原文均明确写出敲门" }));
  t.mock.method(globalThis, "fetch", async () => Response.json({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ items }) } }] }));
  const started = await analysis.start({ kind: "scene", sceneEnabled: true, chapterId: chapter.id, revision: chapter.revision, unitId: unit.id, unitRevision: unit.revision });
  await analysis.close();
  const draft = store.get("suggestions", started.id);
  assert.equal(draft.status, "ready");
  analysis.apply({ id: draft.id, revision: chapter.revision, draftVersion: draft.draftVersion, selected: draft.items.map(i => i.id) });
  const events = store.all("events", unit.id);
  assert.deepEqual(events.map(e => e.evidence.kind), ["原文明示", "上下文推断"]);
  assert.equal(events.length, 2);
  assert.throws(() => domain.enhancement.addEvents(unit.id, [{ kind: "effect", description: "假出处", memberId: unit.id, position: "during", state: "adopted", evidence: { kind: "原文明示", quote: "不存在的门铃原文" } }], store.get("units", unit.id).revision), /引文/);
});

test("TR07 路由阻断在工作进程间共享，失败的重新启用事务不泄漏派发资格", async t => {
  await t.test("另一工作进程的共享错误不能被未确认入队解除", async t => {
    const { store, domain, voices, config, worker } = setup(t);
    const other = createWorker(store, domain, config);
    const first = worker.enqueue(trial(voices[0]));
    let calls = 0;
    t.mock.method(globalThis, "fetch", async () => { calls++; return new Response("payment required", { status: 402 }); });
    await worker.tick();
    assert.equal(store.get("jobs", first.id).status, "failed");
    const session = domain.mutate("voice-session.create", { description: "温和清楚的成年声音" });
    const p = { kind: "voice-create", sessionId: session.id, entityRevision: session.revision, commandId: uid() };
    assert.throws(() => other.enqueue(p), /接口已暂停/);
    assert.equal(store.get("settings", "audio-route").blocked, true);
    assert.equal(calls, 1);
    assert.equal(store.all("jobs").length, 1);
  });
  await t.test("余额预留失败保留之前暂停状态", t => {
    const { store, domain, voices, config } = setup(t, { callLimit: 1, usageScope: "failed-route-resume" });
    store.put("settings", { id: "audio-route", blocked: true });
    const worker = createWorker(store, domain, config), { chapter } = chapterFixture(domain, store, voices);
    assert.throws(() => worker.enqueue({ kind: "generate", chapterId: chapter.id, revision: store.get("chapters", chapter.id).revision, ids: domain.list(chapter.id).map(s => s.id), commandId: uid(), resumeRoute: true }), /额度不足/);
    assert.equal(store.get("settings", "audio-route").blocked, true);
    assert.throws(() => worker.enqueue(trial(voices[0])), /接口已暂停/);
    assert.equal(store.all("jobs").length, 0);
  });
});

function chapterFixture(domain, store, voices) {
  const project = domain.mutate("project.create", { name: "单元测试" });
  const chapter = domain.mutate("chapter.create", { projectId: project.id, title: "连续对话", source: "小林，你来了。门外很安静。我们走吧。", segment: true });
  const firstRole = store.all("roles", project.id)[0], secondRole = domain.mutate("role.create", { projectId: project.id, name: "小林" });
  for (const [i, s] of domain.list(chapter.id).entries()) domain.mutate("segment.update", { id: s.id, chapterId: chapter.id, revision: store.get("chapters", chapter.id).revision, roleId: i === 1 ? secondRole.id : firstRole.id, voiceId: voices[i === 1 ? 1 : 0].id, roleConfirmed: true, identityConfirmed: true });
  const group = domain.mutate("unit.create", { chapterId: chapter.id, revision: store.get("chapters", chapter.id).revision, ids: domain.list(chapter.id).map(s => s.id), guidance: "轮流说话，衔接自然。" });
  const payload = mode => ({ kind: "unit-generate", chapterId: chapter.id, revision: store.get("chapters", chapter.id).revision, unitId: group.id, mode, commandId: uid() });
  return { chapter, group, payload };
}

test("存在感生成资格：旧场景模板拒绝选择，明确切换v4后按选择发送", async t => {
  for (const presence of ['clear', 'natural', 'subtle', 'unspecified']) await t.test(presence, async t => {
    const { store, domain, voices, worker } = setup(t), { chapter, group, payload } = chapterFixture(domain, store, voices);
    const update = (action, data) => domain.mutate(action, { chapterId: chapter.id, revision: store.get('chapters', chapter.id).revision, id: group.id, entityRevision: store.get('units', group.id).revision, mode: 'scene', ...data });
    update('unit.template', { template:'scene-v2', confirm:true });
    update('unit.update', { backgroundPresence: presence });
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response(wav(), { headers: { 'content-type': 'audio/wav' } }); });
    assert.equal(store.get('units', group.id).variants.scene.template, 'scene-v2');
    if (presence !== 'unspecified') {
      await assert.rejects(worker.submit(payload('scene')), /所选背景存在感尚未生效.*本次未发送/);
      assert.equal(store.all('jobs').length, 0); assert.equal(store.all('attempts').length, 0); assert.equal(calls, 0);
      update('unit.template', { template: 'scene-v4-presence-1', confirm: true });
    }
    const job = await worker.submit(payload('scene')); await worker.tick();
    assert.equal(store.get('jobs', job.id).status, 'success'); assert.equal(calls, 1);
    const a = store.all('attempts', job.id)[0];
    assert.equal(a.input.backgroundPresence, presence);
    if (presence === 'unspecified') { assert.equal(a.input.template, 'scene-v2'); assert.equal(a.prompt, compile({ ...a.input, backgroundPresence: undefined })); }
    else assert.match(a.prompt, presence === 'clear' ? /明确存在感/ : presence === 'natural' ? /自然共同呈现/ : /轻柔背景/);
  });
});

test("存在感生成资格：表面v4不能掩盖旧历史编译器，最终派发仍零调用", async t => {
  const { store, domain, voices, worker } = setup(t, { callLimit: 1, usageScope: 'presence-dispatch' }), { chapter, group, payload } = chapterFixture(domain, store, voices);
  const update = (action, data) => domain.mutate(action, { chapterId: chapter.id, revision: store.get('chapters', chapter.id).revision, id: group.id, entityRevision: store.get('units', group.id).revision, mode: 'scene', ...data });
  update('unit.update', { backgroundPresence: 'clear' });
  update('unit.template', { template: 'scene-v4-presence-1', confirm: true });
  const oldCompiler = store.get('units', group.id); oldCompiler.variants.scene.resolvedCompilerId = 'native3-paragraph-k'; store.put('units', oldCompiler, chapter.id);
  assert.throws(() => worker.enqueue(payload('scene')), /所选背景存在感尚未生效/);
  assert.equal(store.all('jobs').length, 0);
  update('unit.template', { template: 'scene-v4-presence-1', confirm: true });
  assert.equal(store.get('units', group.id).variants.scene.resolvedCompilerId, undefined);
  const job = worker.enqueue(payload('scene'));
  // An isolated legacy-data change retains revisions so the final shared input
  // validation must catch the effective compiler before sending or charging.
  const changed = store.get('units', group.id); changed.variants.scene.resolvedCompilerId = 'native3-paragraph-k'; store.put('units', changed, chapter.id);
  let calls = 0; t.mock.method(globalThis, 'fetch', () => { calls++; assert.fail('旧编译器不得忽略存在感后发送'); });
  await worker.tick();
  assert.equal(calls, 0); assert.equal(store.get('jobs', job.id).status, 'failed');
  assert.match(store.get('jobs', job.id).error, /所选背景存在感尚未生效/);
  assert.equal(store.all('attempts', job.id)[0].createdAt, undefined);
  assert.deepEqual([store.get('settings', 'audio-usage:presence-dispatch').reserved, store.get('settings', 'audio-usage:presence-dispatch').used], [0, 0]);
});

test("调用额度在两工作进程间原子预留；未发送释放，unknown及重启保留占用", async t => {
  const { dir, store, domain, voices, config, worker, closeStore } = setup(t, { callLimit: 1, usageScope: "limited-test" });
  const second = createWorker(store, domain, config), first = worker.enqueue(trial(voices[0]));
  assert.equal(store.get("settings", "audio-usage:limited-test").reserved, 1);
  assert.throws(() => second.enqueue(trial(voices[1])), /额度不足/);
  assert.equal(store.all("jobs").length, 1);
  worker.close();
  assert.equal(store.get("jobs", first.id).status, "stopped");
  assert.deepEqual([store.get("settings", "audio-usage:limited-test").reserved, store.get("settings", "audio-usage:limited-test").used], [0, 0]);
  const next = second.enqueue(trial(voices[1]));
  let calls = 0;
  t.mock.method(globalThis, "fetch", () => { calls++; throw new Error("connection lost"); });
  await second.tick();
  assert.equal(calls, 1); assert.equal(store.get("jobs", next.id).status, "unknown");
  assert.deepEqual([store.get("settings", "audio-usage:limited-test").reserved, store.get("settings", "audio-usage:limited-test").used], [0, 1]);
  assert.throws(() => second.enqueue({ ...trial(voices[1]), retryUnknown: true }), /额度不足/);
  closeStore();
  const reopened = openStore(dir); t.after(() => reopened.close());
  await createWorker(reopened, createDomain(reopened), config).recover();
  assert.equal(calls, 1); assert.equal(reopened.get("settings", "audio-usage:limited-test").used, 1);
});

test("相同命令只接受相同载荷；成功及已发送明确失败仍消耗一次本地额度", async t => {
  for (const status of [200, 400]) await t.test(String(status), async t => {
    const { store, voices, worker } = setup(t, { callLimit: 1, usageScope: "sent-test" }), payload = trial(voices[0]);
    const job = worker.enqueue(payload);
    assert.equal(worker.enqueue({ ...payload }).id, job.id);
    assert.throws(() => worker.enqueue({ ...payload, text: "另一句。" }), { status: 409 });
    await assert.rejects(worker.submit({ ...payload, text: "另一句。" }), { status: 409 });
    t.mock.method(globalThis, "fetch", async () => status === 200 ? new Response(wav(), { headers: { "content-type": "audio/wav" } }) : new Response("bad request", { status }));
    await worker.tick();
    assert.equal(store.get("jobs", job.id).status, status === 200 ? "success" : "failed");
    assert.equal(worker.enqueue(payload).id, job.id);
    assert.equal(store.get("settings", "audio-usage:sent-test").used, 1);
    assert.equal(store.get("settings", "audio-usage:sent-test").reserved, 0);
  });
});

test("升级前没有request的试音命令核对原目标与正文，重复不占新额度", t => {
  const { store, voices, worker } = setup(t, { callLimit: 1, usageScope: "legacy-command" }), payload = trial(voices[0]), job = worker.enqueue(payload);
  delete job.request; store.put("jobs", job);
  assert.equal(worker.enqueue(payload).id, job.id);
  assert.throws(() => worker.enqueue({ ...payload, text: "不同正文。" }), { status: 409 });
  assert.throws(() => worker.enqueue({ ...payload, voiceId: voices[1].id }), { status: 409 });
  assert.throws(() => worker.enqueue({ ...payload, commandId: "" }), /命令标识/);
  assert.equal(store.get("settings", "audio-usage:legacy-command").reserved, 1);
});

test("参考读取失败发生在sending前，零调用且释放预留额度", async t => {
  const { store, voices, worker } = setup(t, { callLimit: 1, usageScope: "reference-read" });
  const j = worker.enqueue(trial(voices[0])), fs = (await import("node:fs/promises")).default, { syncBuiltinESMExports } = await import("node:module");
  const old = fs.readFile, mock = t.mock.method(fs, "readFile", async (path, ...args) => {
    if (String(path).endsWith(voices[0].path)) throw new Error("reference read failed");
    return old(path, ...args);
  });
  syncBuiltinESMExports(); t.after(() => { mock.mock.restore(); syncBuiltinESMExports(); });
  t.mock.method(globalThis, "fetch", () => assert.fail("未取得参考字节不得发送"));
  await worker.tick();
  assert.equal(store.get("jobs", j.id).status, "failed"); assert.equal(store.all("attempts", j.id)[0].createdAt, undefined);
  assert.deepEqual([store.get("settings", "audio-usage:reference-read").reserved, store.get("settings", "audio-usage:reference-read").used], [0, 0]);
});

test("sending事务回滚不会泄漏额度或提交时间，批次共享错误释放后续未发预留", async t => {
  await t.test("rollback", async t => {
    const { store, voices, worker } = setup(t, { callLimit: 1, usageScope: "dispatch-rollback" }), j = worker.enqueue(trial(voices[0])), put = store.put;
    let injected = false;
    store.put = (...args) => {
      if (!injected && args[0] === "attempts" && args[1].status === "sending") { injected = true; throw new Error("dispatch registration failed"); }
      return put(...args);
    };
    t.mock.method(globalThis, "fetch", () => assert.fail("回滚的发送资格不得调用")); await worker.tick();
    assert.equal(injected, true); assert.equal(store.get("jobs", j.id).status, "failed");
    assert.equal(store.all("attempts", j.id)[0].createdAt, undefined);
    assert.deepEqual([store.get("settings", "audio-usage:dispatch-rollback").reserved, store.get("settings", "audio-usage:dispatch-rollback").used], [0, 0]);
  });
  await t.test("batch", async t => {
    const { store, domain, voices, worker } = setup(t, { callLimit: 3, usageScope: "batch-release" }), { chapter } = chapterFixture(domain, store, voices);
    const j = worker.enqueue({ kind: "generate", chapterId: chapter.id, revision: store.get("chapters", chapter.id).revision, ids: domain.list(chapter.id).map(s => s.id), commandId: uid() });
    let calls = 0; t.mock.method(globalThis, "fetch", () => { calls++; return new Response("payment required", { status: 402 }); }); await worker.tick();
    assert.equal(calls, 1); assert.deepEqual(store.all("attempts", j.id).map(a => a.status), ["failed", "stopped", "stopped"]);
    assert.deepEqual([store.get("settings", "audio-usage:batch-release").reserved, store.get("settings", "audio-usage:batch-release").used], [0, 1]);
  });
});

test("新模板隔离；角色与共享参考分别映射，姓名正文不替换，事件只入scene", () => {
  assert.deepEqual(listTemplates().map(t => t.id), ["dry-v1"]);
  const candidate = compile({ template: "voice-design-v1", description: "温和低声线", text: "固定的短样文。" });
  assert.doesNotMatch(candidate, /@音频/); assert.equal(candidate.split("固定的短样文。").length, 2);
  const input = { template: "dialogue-dry-v1", slots: [{ speaker: "A", roleId: "r1", voiceId: "v", reference: 1 }, { speaker: "B", roleId: "r2", voiceId: "v", reference: 1 }], members: [{ id: "s1", roleId: "r1", text: "小林，你来了。", performance: "轻声" }, { id: "s2", roleId: "r2", text: "我来了。" }], events: [{ kind: "effect", description: "两下轻敲门声", memberId: "s2", position: "after" }] };
  const dry = compile(input), scene = compile({ ...input, template: "scene-v1" });
  assert.match(dry, /说话者 A 使用 @音频1/); assert.match(dry, /说话者 B 使用 @音频1/);
  assert.match(dry, /小林，你来了。/); assert.doesNotMatch(dry, /两下轻敲门声/);
  assert.match(scene, /第2条正文之后，两下轻敲门声/);
  assert.doesNotMatch(scene, /r1|r2|s1|s2|voiceId|unitId/);
  assert.equal(scene, `[任务]
按下列顺序生成一段中文有声场景。每条正文只朗读一次；编号、说话者标签、标题和表演说明都不读出。不增加、遗漏或改写台词。

[角色参考]
说话者 A 使用 @音频1 的声音身份。
说话者 B 使用 @音频1 的声音身份。

[互动]
轮流说话，不重叠；衔接自然，不增加回应。

[逐条正文与表演]
1. 说话者 A；表演：轻声；正文：小林，你来了。
2. 说话者 B；表演：自然清楚地朗读；正文：我来了。

[已采用声音事件]
一次性音效：第2条正文之后，两下轻敲门声

[声音主次]
对白清楚，声音事件次要，不以事件替代台词，不添加未列出的事件。`);
  assert.equal(listUnitTemplates().find(template=>template.id==='scene-v2')?.name,'场景 v2 · 背景清楚可辨');
  const ranged={...input,events:[...input.events,{kind:'environment',description:'持续细雨',startMemberId:'s1',startPosition:'before',endMemberId:'s2',endPosition:'after'},{kind:'music',description:'舒缓音乐',startMemberId:'s1',startPosition:'during',endMemberId:'s2',endPosition:'during'}]};
  const previous=compile({...ranged,template:'scene-v1'}),audible=compile({...ranged,template:'scene-v2'});
  assert.equal(audible.split('[声音主次]')[0],previous.split('[声音主次]')[0]);
  assert.match(audible,/环境声：第1条正文之前至第2条正文之后，持续细雨/);assert.match(audible,/音乐：第1条正文期间至第2条正文期间，舒缓音乐/);assert.match(audible,/一次性音效：第2条正文之后，两下轻敲门声/);
  for(const clause of ['对白始终清晰可懂','指定范围内持续清楚可辨','不只是几乎听不到的底噪','自然停顿中也保持可闻','一次性音效应在指定位置清楚可辨','适度降低背景声音，但不能消失','不遮盖字词','不代替或添加台词','不增加未列出的事件','不延长停顿'])assert.ok(audible.includes(clause),clause);
  assert.doesNotMatch(audible,/r1|r2|s1|s2|voiceId|unitId/);
});

test("候选零参考且不锁章节；描述修改或放弃后的产物归原尝试", async t => {
  const { store, domain, voices, worker } = setup(t), { chapter, payload } = chapterFixture(domain, store, voices);
  const groupJob = worker.enqueue(payload("dry"));
  const session = domain.mutate("voice-session.create", { description: "温和清楚的中低声线" });
  const candidate = worker.enqueue({ kind: "voice-create", sessionId: session.id, entityRevision: session.revision, commandId: uid() });
  assert.equal(candidate.chapterId, ""); assert.equal(candidate.targetKind, "candidate");
  assert.equal(store.db.prepare("SELECT parent FROM jobs WHERE id=?").get(candidate.id).parent, "");
  let bodies = [];
  t.mock.method(globalThis, "fetch", async (_, options) => {
    const body = JSON.parse(options.body); bodies.push(body);
    if (bodies.length === 2) domain.mutate("voice-session.update", { id: session.id, entityRevision: 1, description: "修改后的明亮声线" });
    return new Response(wav(), { headers: { "content-type": "audio/wav" } });
  });
  await worker.tick(); await worker.tick();
  assert.equal(store.get("jobs", groupJob.id).status, "success");
  assert.equal(store.get("jobs", candidate.id).status, "success");
  assert.equal(bodies[0].references.length, 2); assert.ok(!Object.hasOwn(bodies[1], "references"));
  assert.doesNotMatch(bodies[1].text_prompt, /@音频/);
  const a = store.all("attempts", candidate.id)[0];
  assert.equal(a.adopted, false); assert.equal(a.input.description, "温和清楚的中低声线"); assert.ok(store.get("audios", a.id));
  assert.equal(store.all("voices").length, 2); assert.equal(store.all("segments").length, 3);
  assert.ok(domain.snapshot().voiceSessions.find(s => s.id === session.id).candidates.some(c => c.id === a.id && c.late));
  assert.equal(domain.chapter(chapter.id).playbackItems.length, 1);
});

test("候选发送前修订改变不调用；放弃queued释放本地额度", async t => {
  for (const action of ["update", "abandon"]) await t.test(action, async t => {
    const { store, domain, worker } = setup(t, { callLimit: 1, usageScope: "candidate-stopped" });
    const s = domain.mutate("voice-session.create", { description: "温和声线" });
    const j = worker.enqueue({ kind: "voice-create", sessionId: s.id, entityRevision: 1, commandId: uid() });
    domain.mutate(`voice-session.${action}`, { id: s.id, entityRevision: 1, description: "新声线" });
    t.mock.method(globalThis, "fetch", () => assert.fail("未获得资格的候选不得调用"));
    await worker.tick();
    assert.equal(store.all("audios").length, 0);
    assert.deepEqual([store.get("settings", "audio-usage:candidate-stopped").reserved, store.get("settings", "audio-usage:candidate-stopped").used], [0, 0]);
    assert.ok(["failed", "stopped"].includes(store.get("jobs", j.id).status));
  });
});

test("E1候选生成、并发幂等保存、明确绑定后跨三句复用同一真实文件", async t => {
  const { dir, store, domain, worker } = setup(t, { callLimit: 4, usageScope: "candidate-reuse" });
  const project = domain.mutate("project.create", { name: "创建声音复用" });
  const chapter = domain.mutate("chapter.create", { projectId: project.id, title: "三句", source: "窗边传来风声。书页轻轻翻动。今天又是新的开始。", segment: true });
  const role = store.all("roles", project.id)[0], session = domain.mutate("voice-session.create", { description: "自然清楚的温和中声线" });
  const bodies = [];
  t.mock.method(globalThis, "fetch", async (_, options) => { bodies.push(JSON.parse(options.body)); return new Response(wav(), { headers: { "content-type": "audio/wav" } }); });
  const j = worker.enqueue({ kind: "voice-create", sessionId: session.id, entityRevision: 1, commandId: uid() }); await worker.tick();
  const candidateId = store.all("attempts", j.id)[0].id, original = store.get("audios", candidateId);
  assert.ok(!Object.hasOwn(bodies[0], "references"));
  const saved = await Promise.all([saveCandidateVoice(store, { audioId: candidateId, name: "温和新声" }), saveCandidateVoice(store, { audioId: candidateId, name: "重复点击的新名" })]);
  assert.equal(saved[0].id, saved[1].id); assert.equal(saved[0].id, candidateId);
  assert.equal(store.all("voices").filter(v => v.sourceAudioId === candidateId).length, 1);
  assert.notEqual(saved[0].path, original.path); assert.deepEqual(readFileSync(join(dir, saved[0].path)), readFileSync(join(dir, original.path)));
  assert.equal(store.get("roles", role.id).voiceId, null); assert.equal(saved[0].inspection, undefined);
  domain.mutate("role.update", { id: role.id, entityRevision: 1, voiceId: saved[0].id, chapterId: chapter.id, revision: store.get("chapters", chapter.id).revision });
  for (const s of domain.list(chapter.id)) domain.mutate("segment.update", { id: s.id, chapterId: chapter.id, revision: store.get("chapters", chapter.id).revision, roleConfirmed: true });
  const generated = worker.enqueue({ kind: "generate", chapterId: chapter.id, revision: store.get("chapters", chapter.id).revision, ids: domain.list(chapter.id).map(s => s.id), commandId: uid() }); await worker.tick();
  assert.equal(store.get("jobs", generated.id).status, "success"); assert.equal(bodies.length, 4);
  const expected = readFileSync(join(dir, saved[0].path)).toString("base64");
  assert.ok(bodies.slice(1).every(b => b.references.length === 1 && b.references[0].audio_data === expected));
  assert.ok(domain.list(chapter.id).every(s => s.current && !s.review));
  assert.equal(store.get("settings", "audio-usage:candidate-reuse").used, 4);
  domain.mutate("voice.delete", { id: saved[0].id, entityRevision: 1, confirm: true }); drainReferenceDeletes(store);
  assert.equal(existsSync(join(dir, saved[0].path)), false); assert.equal(existsSync(join(dir, original.path)), true);
});

test("多人全部参考预检；异步校验期间停止或关闭不发送", async t => {
  for (const action of ["broken", "stop", "close", "reference"]) await t.test(action, async t => {
    const { dir, store, domain, voices, worker } = setup(t), { payload } = chapterFixture(domain, store, voices);
    t.mock.method(globalThis, "fetch", () => assert.fail("未经全部参考最终资格不得调用"));
    if (action === "broken") {
      writeFileSync(join(dir, voices[1].path), "broken");
      await assert.rejects(worker.submit(payload("dry")), /损坏或缺失/);
      assert.equal(store.all("jobs").length, 0); return;
    }
    const j = worker.enqueue(payload("dry")), pending = worker.tick();
    assert.equal(store.all("attempts", j.id)[0].status, "queued");
    if (action === "stop") domain.mutate("job.stop", { id: j.id });
    else if (action === "close") worker.close();
    else store.put("voices", { ...voices[1], state: "stopped" });
    await pending;
    assert.equal(store.all("audios").length, 0);
    assert.ok(["failed", "stopped"].includes(store.get("jobs", j.id).status));
  });
});

test("第二份真实参考超出时长或大小时阻断全部请求并释放预留", async t => {
  for (const limit of ["duration", "bytes"]) await t.test(limit, async t => {
    const { dir, store, domain, voices, worker } = setup(t, { callLimit: 1, usageScope: "reference-limits" }), { payload } = chapterFixture(domain, store, voices);
    writeFileSync(join(dir, voices[1].path), limit === "duration" ? wav(48000 * 30 + 480) : Buffer.alloc(10 * 1024 * 1024 + 1));
    t.mock.method(globalThis, "fetch", () => assert.fail("超规格参考不得外发"));
    await assert.rejects(worker.submit(payload("dry")), /30 秒\/10 MB/); assert.equal(store.all("jobs").length, 0);
    const j = worker.enqueue(payload("dry")); await worker.tick();
    assert.equal(store.get("jobs", j.id).status, "failed");
    assert.deepEqual([store.get("settings", "audio-usage:reference-limits").reserved, store.get("settings", "audio-usage:reference-limits").used], [0, 0]);
  });
});

test("TR02 恰三份去重参考，第三份停止或损坏整组零发送", async t => {
  for (const action of ["stopped", "broken"]) await t.test(action, async t => {
    const { dir, store, domain, voices, worker } = setup(t, { callLimit: 1, usageScope: "third-reference" }), { chapter, payload } = chapterFixture(domain, store, voices);
    const third = { id: uid(), path: "reference-third.wav", state: "active", revision: 1 };
    writeFileSync(join(dir, third.path), wav()); store.put("voices", third);
    const role = domain.mutate("role.create", { projectId: chapter.projectId, name: "第三个身份" }), last = domain.list(chapter.id).at(-1);
    domain.mutate("segment.update", { chapterId: chapter.id, revision: store.get("chapters", chapter.id).revision, id: last.id, roleId: role.id, voiceId: third.id, roleConfirmed: true, identityConfirmed: true });
    let calls = 0;
    t.mock.method(globalThis, "fetch", () => { calls++; assert.fail("第三份参考没有资格，整组不得外发"); });
    const job = worker.enqueue(payload("dry")), attempt = store.all("attempts", job.id)[0];
    assert.deepEqual(attempt.input.referenceVoiceIds, [voices[0].id, voices[1].id, third.id]);
    assert.equal(attempt.input.slots.length, 3);
    const pending = worker.tick();
    assert.equal(store.get("attempts", attempt.id).status, "queued");
    if (action === "stopped") domain.mutate("voice.update", { id: third.id, entityRevision: third.revision, state: "stopped" });
    else writeFileSync(join(dir, third.path), "broken third reference");
    await pending;
    assert.equal(calls, 0); assert.equal(store.all("audios").length, 0);
    assert.ok(["stopped", "failed"].includes(store.get("jobs", job.id).status));
    assert.deepEqual([store.get("settings", "audio-usage:third-reference").reserved, store.get("settings", "audio-usage:third-reference").used], [0, 0]);
    if (action === "broken") await assert.rejects(worker.submit(payload("dry")), /损坏或缺失/);
    assert.equal(store.all("jobs").length, 1);
  });
});

test("TR05 新候选与组损坏正式文件不补登记，可解码part保持未知", async t => {
  for (const target of ["candidate", "unit"]) await t.test(target, async t => {
    const { dir, store, domain, worker, config, voices, closeStore } = setup(t);
    const session = target === "candidate" ? domain.mutate("voice-session.create", { description: "清楚温和的声音" }) : null;
    const fixture = target === "unit" ? chapterFixture(domain, store, voices) : null;
    const job = worker.enqueue(session ? { kind: "voice-create", sessionId: session.id, entityRevision: session.revision, commandId: uid() } : fixture.payload("dry"));
    const attempt = store.all("attempts", job.id)[0];
    store.put("jobs", { ...job, status: "running" }, job.chapterId);
    store.put("attempts", { ...attempt, status: "sending", createdAt: new Date().toISOString() }, job.id);
    mkdirSync(join(dir, "audio"), { recursive: true });
    const final = `audio/${attempt.id}.wav`, part = final + ".part", broken = Buffer.from("corrupt formal file"), validPart = wav();
    writeFileSync(join(dir, final), broken); writeFileSync(join(dir, part), validPart);
    let calls = 0; t.mock.method(globalThis, "fetch", () => { calls++; assert.fail("未知损坏文件恢复不得自动重新请求"); });
    closeStore(); const reopened = openStore(dir); t.after(() => reopened.close());
    const restoredDomain = createDomain(reopened), restored = createWorker(reopened, restoredDomain, config);
    await restored.recover(); const ended = reopened.get("jobs", job.id); await restored.recover();
    assert.equal(calls, 0); assert.equal(reopened.all("audios").length, 0);
    assert.equal(ended.status, "unknown"); assert.deepEqual(reopened.get("jobs", job.id), ended);
    assert.equal(reopened.get("attempts", attempt.id).status, "unknown");
    assert.deepEqual(readFileSync(join(dir, final)), broken); assert.deepEqual(readFileSync(join(dir, part)), validPart);
    if (fixture) { const unit = reopened.get("units", fixture.group.id); assert.equal(unit.state, "pending"); assert.equal(unit.variants.dry.current, null); }
    else assert.equal(restoredDomain.snapshot().voiceSessions.find(s => s.id === session.id).candidates[0].audioId, undefined);
  });
});

test("MR04 旧通过、返工、历史和结束unknown混合库迁移不改变选择或复活批次", async t => {
  const { dir, store, domain, worker, config, voices } = setup(t), { chapter, group } = chapterFixture(domain, store, voices);
  domain.mutate("unit.dissolve", { chapterId: chapter.id, revision: store.get("chapters", chapter.id).revision, id: group.id, entityRevision: group.revision });
  const ids = domain.list(chapter.id).map(s => s.id);
  let calls = 0; t.mock.method(globalThis, "fetch", async () => { calls++; return new Response(wav(), { headers: { "content-type": "audio/wav" } }); });
  const generated = worker.enqueue({ kind: "generate", chapterId: chapter.id, revision: store.get("chapters", chapter.id).revision, ids, commandId: uid() }); await worker.tick();
  assert.equal(store.get("jobs", generated.id).status, "success"); assert.equal(calls, 3);
  for (const [index, state] of ["passed", "rework"].entries()) {
    const s = store.get("segments", ids[index]);
    domain.mutate("segment.review", { chapterId: chapter.id, revision: store.get("chapters", chapter.id).revision, id: s.id, audioId: s.current, basis: basisOf(s), state });
  }
  const first = store.get("segments", ids[0]), currentAudio = store.get("audios", first.current), oldAudio = { ...currentAudio, id: uid() };
  oldAudio.path = `audio/${oldAudio.id}.wav`; writeFileSync(join(dir, oldAudio.path), wav()); store.put("audios", oldAudio, chapter.id);
  first.previous = oldAudio.id; store.put("segments", first, chapter.id);
  const unknownSegment = store.get("segments", ids[2]), unknown = { id: uid(), commandId: uid(), kind: "generate", chapterId: chapter.id, revision: store.get("chapters", chapter.id).revision, status: "unknown", stop: true, ids: [unknownSegment.id], done: 0, total: 1, finishedAt: "2026-01-01T00:00:00.000Z" };
  store.put("jobs", unknown, chapter.id);
  store.put("attempts", { id: uid(), jobId: unknown.id, segmentId: unknownSegment.id, input: inputOf(unknownSegment), basis: basisOf(unknownSegment), prompt: compile(unknownSegment), model: unknownSegment.model, status: "unknown" }, unknown.id);
  unknownSegment.latest = "unknown"; store.put("segments", unknownSegment, chapter.id);
  // Serialize the old target-less records; only new units/schema are removed for migration.
  for (const table of ["jobs", "attempts", "audios"]) for (const row of store.all(table)) {
    for (const key of ["targetKind", "targetId", "request"]) delete row[key];
    store.put(table, row, table === "attempts" ? row.jobId : chapter.id);
  }
  store.db.exec("DELETE FROM units; DELETE FROM settings WHERE id='data-schema'");
  const tables = ["projects", "chapters", "roles", "voices", "segments", "audios", "jobs", "attempts"], before = tables.map(table => store.all(table));
  const migrated = createDomain(store), restored = createWorker(store, migrated, config);
  await restored.recover(); await restored.recover();
  assert.equal(calls, 3); assert.deepEqual(tables.map(table => store.all(table)), before);
  assert.deepEqual(store.all("units", chapter.id).map(u => u.id), ids);
  for (const id of ids) { const s = store.get("segments", id), u = store.get("units", id); for (const key of ["current", "previous", "approved", "review"]) assert.deepEqual(u.variants.dry[key], s[key] || null); }
  const units = ids.map(id => migrated.enhancement.getUnit(id));
  assert.deepEqual(units.map(u => migrated.enhancement.status(u, "dry").review), ["passed", "rework", "pending"]);
  assert.equal(units[2].variants.dry.latest, "unknown"); assert.equal(store.get("jobs", unknown.id).status, "unknown");
  assert.ok(migrated.enhancement.view(units[0]).variants.dry.history.some(a => a.id === oldAudio.id));
});

test("组与场景独立版本；失败保留当前，切dry零调用，母版整组只编排一次", async t => {
  const { store, domain, voices, worker } = setup(t), { chapter, group, payload } = chapterFixture(domain, store, voices);
  let calls = 0;
  const mock = t.mock.method(globalThis, "fetch", async () => { calls++; return new Response(wav(), { headers: { "content-type": "audio/wav" } }); });
  worker.enqueue(payload("dry")); await worker.tick();
  const dry = store.get("units", group.id).variants.dry.current;
  const u = store.get("units", group.id);
  domain.mutate("event.create", { unitId: u.id, chapterId: chapter.id, revision: store.get("chapters", chapter.id).revision, entityRevision: u.revision, kind: "effect", description: "两下轻而短的敲门声", memberId: u.members[1], position: "after", state: "adopted" });
  const sceneJob = worker.enqueue(payload("scene")); await worker.tick();
  assert.equal(store.get("jobs", sceneJob.id).status, "success", store.get("jobs", sceneJob.id).error);
  const scene = store.get("units", group.id).variants.scene.current;
  assert.ok(scene && scene !== dry); assert.equal(store.get("units", group.id).variants.dry.current, dry);
  assert.equal(store.get("audios", scene).mode, "scene");
  assert.match(store.all("attempts", sceneJob.id)[0].prompt, /两下轻而短的敲门声/);
  mock.mock.mockImplementation(async () => { calls++; throw new Error("lost response"); });
  const failed = worker.enqueue(payload("scene")); await worker.tick();
  assert.equal(store.get("jobs", failed.id).status, "unknown");
  assert.equal(store.get("units", group.id).variants.scene.current, scene);
  assert.throws(() => worker.enqueue(payload("scene")), /结果不明/);
  const current = store.get("units", group.id);
  domain.mutate("unit.switch", { unitId: current.id, chapterId: chapter.id, revision: store.get("chapters", chapter.id).revision, entityRevision: current.revision, mode: "dry" });
  assert.equal(calls, 3); assert.equal(domain.chapter(chapter.id).playbackItems[0].audioId, dry);
  const master = worker.enqueue({ kind: "master", chapterId: chapter.id, revision: store.get("chapters", chapter.id).revision, commandId: uid() });
  await worker.tick();
  assert.equal(calls, 3); assert.equal(store.get("jobs", master.id).total, 1);
  assert.equal(store.all("masters", chapter.id)[0].mapping.length, 1);
  assert.equal(store.all("masters", chapter.id)[0].frames, 4800);
});

test("EX07/EX08 组与单条混排双格式同母版，删除参考和母版只本地重建", async t => {
  const { dir, store, domain, voices, worker } = setup(t, { callLimit: 2, usageScope: "mixed-local-render" });
  const { chapter, group: original } = chapterFixture(domain, store, voices), ids = domain.list(chapter.id).map(s => s.id);
  domain.mutate("unit.dissolve", { chapterId: chapter.id, revision: store.get("chapters", chapter.id).revision, id: original.id, entityRevision: original.revision });
  const group = domain.mutate("unit.create", { chapterId: chapter.id, revision: store.get("chapters", chapter.id).revision, ids: ids.slice(0, 2) });
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return new Response(wav(calls === 1 ? 4800 : 9600), { headers: { "content-type": "audio/wav" } }); });
  for (const unitId of [group.id, ids[2]]) {
    const job = await worker.submit({ kind: "unit-generate", chapterId: chapter.id, revision: store.get("chapters", chapter.id).revision, unitId, mode: "dry", commandId: uid() });
    await worker.tick(); assert.equal(store.get("jobs", job.id).status, "success");
  }
  const current = () => domain.chapter(chapter.id);
  const render = async (format, confirm = false) => {
    const c = current(), job = await worker.submit({ kind: "export", chapterId: c.id, revision: c.revision, arrangement: c.arrangement, reviewItems: c.reviewItems, format, confirm, commandId: uid() });
    await worker.tick(); assert.equal(store.get("jobs", job.id).status, "success");
    return store.all("exports", c.id).find(e => e.jobId === job.id);
  };
  const first = await render("wav", true), second = await render("mp3");
  assert.equal(first.masterId, second.masterId);
  const master = store.get("masters", first.masterId), gapFrames = Math.round(current().gap * 48000);
  assert.deepEqual(master.mapping.flatMap(m => m.memberIds), ids);
  assert.equal(master.mapping.length, 2); assert.equal(master.mapping[0].unitId, group.id);
  assert.equal(master.mapping[0].segmentId, undefined); assert.equal(master.mapping[1].segmentId, ids[2]);
  assert.deepEqual(master.mapping.map(m => [m.startFrame, m.endFrame]), [[0, 4800], [4800 + gapFrames, 14400 + gapFrames]]);
  assert.equal(master.frames, 14400 + gapFrames); assert.equal(master.mapping.at(-1).endFrame, master.frames);
  const decodedFrames = path => execFileSync(ffmpeg, ["-v", "error", "-xerror", "-i", join(dir, path), "-ar", "48000", "-ac", "1", "-f", "s16le", "pipe:1"]).length / 2;
  for (const result of [first, second]) { assert.equal((await inspect(join(dir, result.path))).format, result.format); assert.equal(decodedFrames(result.path), master.frames); }
  const beforeWav = readFileSync(join(dir, first.path));
  assert.deepEqual(beforeWav, readFileSync(join(dir, master.path)));
  const reviews = current().reviewItems, sources = domain.enhancement.resolve(chapter.id).map(r => [r.a.path, readFileSync(join(dir, r.a.path))]);
  domain.mutate("voice.update", { id: voices[0].id, entityRevision: store.get("voices", voices[0].id).revision, state: "stopped" });
  domain.mutate("voice.delete", { id: voices[1].id, entityRevision: store.get("voices", voices[1].id).revision, confirm: true });
  drainReferenceDeletes(store); assert.equal(store.get("voices", voices[1].id).state, "deleted"); assert.equal(existsSync(join(dir, voices[1].path)), false);
  rmSync(join(dir, master.path));
  const restored = await render("wav"), replacement = store.get("masters", restored.masterId);
  assert.notEqual(replacement.id, master.id); assert.deepEqual(replacement.mapping, master.mapping); assert.equal(replacement.frames, master.frames);
  assert.deepEqual(readFileSync(join(dir, restored.path)), beforeWav); assert.deepEqual(current().reviewItems, reviews);
  for (const [path, bytes] of sources) assert.deepEqual(readFileSync(join(dir, path)), bytes);
  assert.equal(calls, 2); assert.deepEqual([store.get("settings", "audio-usage:mixed-local-render").reserved, store.get("settings", "audio-usage:mixed-local-render").used], [0, 2]);
});

test("F2 scene单条成组后解除严格恢复预览干声，缺干声阻断母版和导出且零补生成", async t => {
  for(const hasDry of [true,false])await t.test(hasDry ? "已有干声实际进入母版及双格式导出" : "无干声不以旧scene补位",async t=>{
    const {dir,store,domain,voices,worker}=setup(t),{chapter,group:original}=chapterFixture(domain,store,voices),ids=domain.list(chapter.id).map(s=>s.id);
    const mutate=(action,data)=>domain.mutate(action,{chapterId:chapter.id,revision:store.get('chapters',chapter.id).revision,...data});
    mutate('unit.dissolve',{id:original.id,entityRevision:original.revision});
    let calls=0,frames=4800;
    t.mock.method(globalThis,'fetch',async()=>{calls++;return new Response(wav(frames),{headers:{'content-type':'audio/wav'}})});
    const generate=async(unitId,mode)=>{const job=await worker.submit({kind:'unit-generate',chapterId:chapter.id,revision:store.get('chapters',chapter.id).revision,unitId,mode,commandId:uid()});await worker.tick();assert.equal(store.get('jobs',job.id).status,'success');return store.all('attempts',job.id)[0].id;};
    const dryIds=[];for(const id of ids)dryIds.push(id===ids[0]&&!hasDry ? null : await generate(id,'dry'));
    frames=9600;const sceneId=await generate(ids[0],'scene');assert.equal(store.get('units',ids[0]).mode,'scene');
    const group=mutate('unit.create',{ids:ids.slice(0,2)});frames=14400;await generate(group.id,'dry');
    const current=store.get('units',group.id),preview=domain.enhancement.preview({kind:'dissolve',chapterId:chapter.id,revision:store.get('chapters',chapter.id).revision,id:group.id,entityRevision:current.revision});
    assert.deepEqual(preview.items.map(i=>i.audioId),dryIds.slice(0,2));assert.deepEqual(preview.items.map(i=>i.mode),['dry','dry']);const beforeCalls=calls;
    mutate('unit.dissolve',{id:group.id,entityRevision:current.revision});
    const resolved=domain.enhancement.resolve(chapter.id);assert.deepEqual(resolved.map(r=>r.s.mode),['dry','dry','dry']);assert.deepEqual(resolved.map(r=>r.a?.id||null),dryIds);
    assert.equal(store.get('units',ids[0]).variants.scene.current,sceneId);assert.ok(domain.enhancement.view(store.get('units',ids[0])).variants.scene.history.some(a=>a.id===sceneId));
    if(hasDry){
      const masterJob=await worker.submit({kind:'master',chapterId:chapter.id,revision:store.get('chapters',chapter.id).revision,commandId:uid()});await worker.tick();assert.equal(store.get('jobs',masterJob.id).status,'success');
      const master=store.all('masters',chapter.id)[0];assert.deepEqual(master.mapping.map(m=>m.audioId),dryIds);assert.ok(!master.mapping.some(m=>m.audioId===sceneId));
      const gapFrames=Math.round(domain.chapter(chapter.id).gap*48000);assert.equal(master.frames,14400+2*gapFrames);
      for(const format of ['wav','mp3']){const c=domain.chapter(chapter.id),job=await worker.submit({kind:'export',chapterId:c.id,revision:c.revision,arrangement:c.arrangement,reviewItems:c.reviewItems,format,confirm:format==='wav',commandId:uid()});await worker.tick();assert.equal(store.get('jobs',job.id).status,'success');const result=store.all('exports',c.id).find(e=>e.jobId===job.id);assert.equal(result.masterId,master.id);assert.equal((await inspect(join(dir,result.path))).format,format);const decoded=execFileSync(ffmpeg,['-v','error','-xerror','-i',join(dir,result.path),'-ar','48000','-ac','1','-f','s16le','pipe:1']).length/2;assert.equal(decoded,master.frames);}
    }else{
      assert.equal(resolved[0].validity,'missing');const c=domain.chapter(chapter.id);
      for(const kind of ['master','export'])await assert.rejects(worker.submit({kind,chapterId:c.id,revision:c.revision,arrangement:c.arrangement,reviewItems:c.reviewItems,format:'wav',confirm:true,commandId:uid()}),/缺少匹配|没有音频/);
      assert.equal(store.all('masters',c.id).length,0);assert.equal(store.all('exports',c.id).length,0);
    }
    assert.equal(calls,beforeCalls);
  });
});

test("F3 已存逆序事件阻断新入队及最终发送事务，零外发并保留待修正事件",async t=>{
  const {store,domain,voices,worker}=setup(t,{callLimit:1,usageScope:'inverse-event'}),{chapter,group,payload}=chapterFixture(domain,store,voices),memberId=group.members[0];
  const event=domain.mutate('event.create',{chapterId:chapter.id,revision:store.get('chapters',chapter.id).revision,unitId:group.id,entityRevision:group.revision,kind:'environment',description:'轻风持续',startMemberId:memberId,endMemberId:memberId,startPosition:'before',endPosition:'after',state:'adopted'});
  const job=worker.enqueue(payload('scene')),old=store.get('events',event.id);old.startPosition='after';old.endPosition='before';store.put('events',old,group.id);
  let calls=0;t.mock.method(globalThis,'fetch',()=>{calls++;assert.fail('逆序旧事件不得发送')});
  await worker.tick();assert.equal(calls,0);assert.equal(store.get('jobs',job.id).status,'failed');assert.equal(store.all('attempts',job.id)[0].createdAt,undefined);
  assert.deepEqual([store.get('settings','audio-usage:inverse-event').reserved,store.get('settings','audio-usage:inverse-event').used],[0,0]);
  assert.throws(()=>worker.enqueue(payload('scene')),/失效/);assert.equal(store.all('jobs').length,1);assert.equal(store.all('events',group.id).length,1);
  const diagnosed=domain.enhancement.events(store.get('units',group.id))[0];assert.equal(diagnosed.validity,'needsReview');assert.ok(diagnosed.diagnostics.length);
});

test("完整候选登记异常后关闭重开，补回原产物不复活unknown或自动重发", async t => {
  const { dir, store, domain, worker, config, closeStore } = setup(t, { callLimit: 1, usageScope: "candidate-recovery" });
  const s = domain.mutate("voice-session.create", { description: "柔和声线" });
  const j = worker.enqueue({ kind: "voice-create", sessionId: s.id, entityRevision: 1, commandId: uid() });
  const attempt = store.all("attempts", j.id)[0], put = store.put;
  let failed = false, calls = 0;
  store.put = (...args) => { if (!failed && args[0] === "audios") { failed = true; throw new Error("registration failed"); } return put(...args); };
  t.mock.method(globalThis, "fetch", async () => { calls++; return new Response(wav(), { headers: { "content-type": "audio/wav" } }); });
  await worker.tick();
  assert.equal(failed, true); assert.equal(store.get("jobs", j.id).status, "unknown");
  assert.ok(existsSync(join(dir, `audio/${attempt.id}.wav`))); closeStore();
  const reopened = openStore(dir); t.after(() => reopened.close());
  const recovered = createWorker(reopened, createDomain(reopened), config);
  await recovered.recover(); await recovered.recover();
  assert.equal(calls, 1); assert.equal(reopened.get("jobs", j.id).status, "unknown");
  assert.equal(reopened.get("attempts", attempt.id).status, "success"); assert.equal(reopened.get("attempts", attempt.id).adopted, false);
  assert.equal(reopened.get("audios", attempt.id).input.description, "柔和声线");
  assert.equal(reopened.get("settings", "audio-usage:candidate-recovery").used, 1);
});

test("恢复结束后的组请求迟到，只记历史且不覆盖新版或复活解组", async t => {
  for (const outcome of ["success", "failure", "dissolved"]) await t.test(outcome, async t => {
    const { store, domain, voices, worker, config } = setup(t, { callLimit: 2, usageScope: "group-late" }), { chapter, group, payload } = chapterFixture(domain, store, voices);
    let finish, reject, started, calls = 0;
    const ready = new Promise(resolve => { started = resolve; });
    t.mock.method(globalThis, "fetch", () => {
      calls++;
      if (calls > 1) return new Response(wav(), { headers: { "content-type": "audio/wav" } });
      return new Promise((resolve, fail) => { finish = resolve; reject = fail; started(); });
    });
    const old = worker.enqueue(payload("dry")), pending = worker.tick();
    await ready;
    await worker.recover();
    assert.equal(store.get("jobs", old.id).status, "unknown");
    let newer;
    if (outcome === "dissolved") {
      const u = store.get("units", group.id);
      domain.mutate("unit.dissolve", { unitId: u.id, chapterId: chapter.id, revision: store.get("chapters", chapter.id).revision, entityRevision: u.revision });
    } else {
      const nextWorker = createWorker(store, domain, config);
      newer = nextWorker.enqueue({ ...payload("dry"), retryUnknown: true }); await nextWorker.tick();
      assert.equal(store.get("jobs", newer.id).status, "success");
    }
    const before = store.get("units", group.id);
    if (outcome === "failure") reject(new Error("late connection failure"));
    else finish(new Response(wav(), { headers: { "content-type": "audio/wav" } }));
    await pending;
    assert.equal(store.get("jobs", old.id).status, "unknown");
    assert.deepEqual(store.get("units", group.id), before);
    const a = store.all("attempts", old.id)[0];
    if (outcome !== "failure") { assert.equal(a.status, "success"); assert.equal(a.adopted, false); assert.ok(store.get("audios", a.id)); }
    else assert.equal(a.status, "unknown");
    assert.equal(calls, outcome === "dissolved" ? 1 : 2);
    assert.equal(store.get("settings", "audio-usage:group-late").used, calls);
  });
});

test('候选在原件封存后或网络异常前放弃，异步进度不会抹去用户决定',async t=>{
  for(const stage of ['rawSealed','networkError'])await t.test(stage,async t=>{
    const {store,domain,worker}=setup(t),session=domain.mutate('voice-session.create',{description:'只验证本地候选状态'});
    const job=worker.enqueue({kind:'voice-create',sessionId:session.id,entityRevision:session.revision,commandId:uid()}),id=store.all('attempts',job.id)[0].id;
    const discard=()=>domain.mutate('voice-candidate.discard',{id,sessionId:session.id,entityRevision:store.get('voiceSessions',session.id).revision});
    if(stage==='rawSealed'){
      const put=store.put.bind(store);let discarded=false;
      t.mock.method(store,'put',(table,value,...rest)=>{const result=put(table,value,...rest);if(!discarded&&table==='attempts'&&value.id===id&&value.phase==='rawSealed'){discarded=true;discard();}return result;});
    }
    t.mock.method(globalThis,'fetch',async()=>{if(stage==='networkError'){discard();throw Error('connection closed after send');}return new Response(wav(),{headers:{'content-type':'audio/wav'}});});
    await worker.tick();const attempt=store.get('attempts',id);assert.equal(attempt.discarded,true);
    if(stage==='rawSealed'){assert.equal(attempt.adopted,false);assert.equal(attempt.status,'success');assert.ok(store.get('audios',id));}
    else assert.equal(attempt.status,'unknown');
  });
});
