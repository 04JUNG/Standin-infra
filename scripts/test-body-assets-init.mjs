import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, access, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
process.env.BODY_ASSETS_INIT_TEST='1';
const { install } = await import('./body-assets-init.mjs');
const sha=d=>createHash('sha256').update(d).digest('hex');
const root=await mkdtemp(path.join(os.tmpdir(),'body-init-test-'));
const key='body-models/releases/test-v1/manifest.json';
const data=new Map([['body-catalog.json',Buffer.from('{}')],['body-models.json',Buffer.from('{}')],['characters.json',Buffer.from('{}')],['fbx/test.fbx',Buffer.from('fbx-bytes')]]);
const base={schema:'body-assets.v1',version:'test-v1',files:[...data].map(([p,d])=>({path:p,size:d.length,sha256:sha(d),roles:p.startsWith('fbx/')?['inference','converter']:p==='body-catalog.json'?['inference']:p==='characters.json'?['converter']:['bff']}))};
async function run(role,manifest=base,objects=data) {
  const raw=Buffer.from(JSON.stringify(manifest));
  return install(async k=>k===key?raw:objects.get(k.slice(key.lastIndexOf('/')+1)),{BODY_ASSETS_ROLE:role,BODY_ASSETS_MANIFEST_KEY:key,BODY_ASSETS_MANIFEST_SHA256:sha(raw),BODY_ASSETS_ROOT:path.join(root,role)});
}
try {
  for(const role of ['inference','converter','bff']) {
    const receipt=await run(role);
    assert.equal(receipt.files,role==='bff'?1:2);
    assert.ok(JSON.parse(await readFile(path.join(root,role,'.body-assets-ready.json'),'utf8')));
    if(role==='bff') await assert.rejects(access(path.join(root,role,'fbx/test.fbx')));
  }
  await rm(path.join(root,'inference'),{recursive:true});
  const bad=new Map(data);bad.set('fbx/test.fbx',Buffer.from('bad-bytes'));
  await assert.rejects(run('inference',base,bad),/checksum mismatch/);
  await assert.rejects(access(path.join(root,'inference','body-catalog.json')));
  await assert.rejects(access(path.join(root,'inference','.body-assets-ready.json')));
  for(const p of ['../outside.fbx','body-catalog.json']) {
    const m=structuredClone(base);m.files.at(-1).path=p;
    await assert.rejects(run('inference',m),/invalid body asset entry/);
  }
  const missing=structuredClone(base);missing.files[0].roles=['converter'];
  await assert.rejects(run('inference',missing),/catalog missing/);
  await assert.rejects(install(async()=>Buffer.from('{}'),{BODY_ASSETS_ROLE:'bff',BODY_ASSETS_MANIFEST_KEY:key,BODY_ASSETS_MANIFEST_SHA256:'0'.repeat(64)}),/checksum mismatch/);
  console.log('Node installer: role filtering, corrupt bytes, unsafe paths, duplicate paths, missing catalog, manifest pin passed');
} finally {await rm(root,{recursive:true,force:true});}
