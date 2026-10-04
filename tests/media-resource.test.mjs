import test from 'node:test';
import assert from 'node:assert/strict';
import { runMediaProcess, mediaProcessActivity } from '../server/audio.mjs';

test('shared native process budget serializes independent media callers and releases rejected work', async () => {
  const work = () => runMediaProcess(process.execPath, ['-e', 'const start=Date.now();setTimeout(()=>process.stdout.write(JSON.stringify({start,end:Date.now()})),60)']);
  const [a,b] = (await Promise.all([work(),work()])).map(r => JSON.parse(r.stdout));
  assert.ok(a.end <= b.start, 'second process must not start while the first one is running');
  assert.equal(mediaProcessActivity().peak, 1);
  await assert.rejects(runMediaProcess(process.execPath, ['-e', 'process.exit(2)']));
  assert.ok((await work()).stdout);
  assert.equal(mediaProcessActivity().active, 0);
});

test('hung native child has a bounded lifetime and releases the shared slot before queued work starts',async()=>{
  const hung=runMediaProcess(process.execPath,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],{timeout:50});
  const next=runMediaProcess(process.execPath,['-e','process.stdout.write("next")'],{timeout:1000});
  await assert.rejects(hung,error=>error.killed===true&&error.signal==='SIGKILL');
  assert.equal((await next).stdout,'next');assert.equal(mediaProcessActivity().active,0);
  await assert.rejects(runMediaProcess(process.execPath,[],{timeout:0}),/时限/);
});
