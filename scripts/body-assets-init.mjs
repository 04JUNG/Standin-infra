import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, writeFile, rename, chmod, rm } from 'node:fs/promises';
import path from 'node:path';

const allowedPath = /^(?:body-catalog\.json|body-models\.json|characters\.json|fbx\/[a-z0-9-]+\.fbx|png\/[a-z0-9-]+\.png|qa\/[a-z0-9-]+\.json|preview\/posed-mesh-v1\/[a-f0-9]{64}\.(?:json|glb))$/;
const roles = new Set(['inference', 'converter', 'bff']);
const limit = 300 * 1024 * 1024;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

export async function install(fetch, env = process.env) {
  const role = env.BODY_ASSETS_ROLE;
  const key = env.BODY_ASSETS_MANIFEST_KEY;
  const expected = env.BODY_ASSETS_MANIFEST_SHA256;
  if (!roles.has(role) || !/^body-models\/releases\/[a-z0-9-]+\/manifest\.json$/.test(key ?? '') || !/^[a-f0-9]{64}$/.test(expected ?? '')) throw new Error('invalid pinned body manifest');
  const raw = await fetch(key, 65536);
  if (raw.length > 65536 || sha(raw) !== expected) throw new Error('body manifest checksum mismatch');
  const manifest = JSON.parse(raw.toString('utf8'));
  if (manifest.schema !== 'body-assets.v1' || typeof manifest.version !== 'string' || !manifest.version || !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > 10000) throw new Error('invalid body manifest');
  const seen = new Set();
  let total = 0;
  for (const f of manifest.files) {
    if (typeof f.path !== 'string' || !allowedPath.test(f.path) || seen.has(f.path) || !Number.isSafeInteger(f.size) || f.size <= 0 || f.size > limit || typeof f.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(f.sha256) || !Array.isArray(f.roles) || !f.roles.length || f.roles.some(r => !roles.has(r)) || new Set(f.roles).size !== f.roles.length) throw new Error('invalid body asset entry');
    seen.add(f.path);
    total += f.size;
  }
  if (total > limit) throw new Error('body release size exceeded');
  const selected = manifest.files.filter(f => f.roles.includes(role));
  const required = { inference: 'body-catalog.json', converter: 'characters.json', bff: 'body-models.json' }[role];
  if (!selected.some(f => f.path === required)) throw new Error('body role catalog missing');
  const root = env.BODY_ASSETS_ROOT ?? '/app/body-staging';
  await mkdir(root, { recursive: true });
  const stage = await mkdtemp(path.join(root, '.body-assets-'));
  try {
    for (const f of selected) {
      const data = await fetch(key.slice(0, key.lastIndexOf('/')) + '/' + f.path, f.size);
      if (data.length !== f.size || sha(data) !== f.sha256) throw new Error('body asset checksum mismatch: ' + f.path);
      const target = path.join(stage, f.path);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, data);
      await chmod(target, 0o644);
    }
    for (const f of selected) {
      const target = path.join(root, f.path);
      await mkdir(path.dirname(target), { recursive: true });
      await rename(path.join(stage, f.path), target);
    }
    const receipt = { event: 'body_assets_ready', role, version: manifest.version, manifestSha256: expected, files: selected.length };
    await writeFile(path.join(root, '.body-assets-ready.json'), JSON.stringify(receipt) + '\n');
    console.log(JSON.stringify(receipt));
    return receipt;
  } finally { await rm(stage, { recursive: true, force: true }); }
}

if (process.env.BODY_ASSETS_INIT_TEST !== '1') {
  const { S3Client, GetObjectCommand } = await import('@aws-sdk/client-s3');
  const s3 = new S3Client({ maxAttempts: 3 });
  await install(async (key, limit) => {
    const response = await s3.send(new GetObjectCommand({ Bucket: process.env.BODY_ASSETS_BUCKET, Key: key }));
    const chunks = [];
    let size = 0;
    for await (const chunk of response.Body) {
      size += chunk.length;
      if (size > limit) { response.Body.destroy(); throw new Error('body object size exceeded'); }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  });
}
