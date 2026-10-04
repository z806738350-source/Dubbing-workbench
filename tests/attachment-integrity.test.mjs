import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { openStore } from '../server/store.mjs';
import { copyWorkspace, verifyWorkspaceAttachments } from '../server/workspace.mjs';

function fixture(t) {
  const root=mkdtempSync(join(tmpdir(),'attachment-integrity-')), directory=join(root,'workspace'), store=openStore(directory);
  const bytes=Buffer.from('received image contents'), derived=Buffer.from('derived image contents'), hash=b=>createHash('sha256').update(b).digest('hex');
  const attachment={id:'picture',path:'assistant/attachments/derived.png',sourcePath:'assistant/attachments/source.png',bytes:derived.length,sourceBytes:bytes.length,hash:hash(derived),sourceHash:hash(bytes)};
  mkdirSync(join(directory,'assistant/attachments'),{recursive:true});writeFileSync(join(directory,attachment.sourcePath),bytes);writeFileSync(join(directory,attachment.path),derived);store.put('assistantAttachments',attachment);
  t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});return {root,directory,store,attachment};
}
for(const field of ['path','sourcePath'])test(`backup and migration reject same-byte-length corruption of ${field}`,async t=>{
  const f=fixture(t),path=join(f.directory,f.attachment[field]),before=readFileSync(path),changed=Buffer.from(before);changed[0]^=1;writeFileSync(path,changed);
  await assert.rejects(verifyWorkspaceAttachments(f.directory,[f.attachment]),/完整性校验失败/);
  const backup=join(f.root,'backup'),result=spawnSync(process.execPath,[resolve('scripts/backup.mjs'),'create',f.directory,backup],{encoding:'utf8'});
  assert.notEqual(result.status,0);assert.match(result.stderr,/完整性校验失败/);assert.equal(existsSync(backup),false);
  const target=join(f.root,'moved');await assert.rejects(copyWorkspace(f.store,target),/完整性校验失败/);assert.equal(existsSync(target),false);
  assert.deepEqual(readFileSync(path),changed);
});
test('intact attachment originals and derivatives survive copy and backup; old source hash absence is explicit',async t=>{
  const f=fixture(t);assert.deepEqual(await verifyWorkspaceAttachments(f.directory,[f.attachment]),{unverifiedSources:[]});
  const backup=join(f.root,'backup'),result=spawnSync(process.execPath,[resolve('scripts/backup.mjs'),'create',f.directory,backup],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);
  const target=await copyWorkspace(f.store,join(f.root,'moved'));assert.deepEqual(await verifyWorkspaceAttachments(target,[f.attachment]),{unverifiedSources:[]});
  delete f.attachment.sourceHash;f.store.put('assistantAttachments',f.attachment);
  assert.deepEqual(await verifyWorkspaceAttachments(f.directory,[f.attachment]),{unverifiedSources:['picture']});
  const verify=spawnSync(process.execPath,[resolve('scripts/backup.mjs'),'verify',f.directory],{encoding:'utf8'});assert.equal(verify.status,0);assert.match(verify.stderr,/历史截图原件未记录/);
});
