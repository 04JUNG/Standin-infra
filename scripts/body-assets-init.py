"""Install a pinned S3 body release into an ECS shared volume before app startup."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import tempfile

ALLOWED_PATH = re.compile(r'(?:shape-bakes\.json|sources/[a-z0-9-]+\.(?:blend|py)|runtime/[a-z0-9-]+\.ssr|body-catalog\.json|body-models\.json|characters\.json|(?:fbx/[a-z0-9-]+\.fbx)|(?:png/[a-z0-9-]+\.png)|(?:qa/[a-z0-9-]+\.json)|(?:preview/posed-mesh-v1/[a-f0-9]{64}\.(?:json|glb)))\Z')
ROLES = {'inference', 'converter', 'bff'}
LIMIT = 300 * 1024 * 1024

def install(fetch, env=os.environ):
    role = env['BODY_ASSETS_ROLE']
    if role not in ROLES:
        raise ValueError('invalid body asset role')
    key = env['BODY_ASSETS_MANIFEST_KEY']
    expected = env['BODY_ASSETS_MANIFEST_SHA256']
    if not re.fullmatch(r'body-models/releases/[a-z0-9-]+/manifest\.json', key) or not re.fullmatch(r'[a-f0-9]{64}', expected):
        raise ValueError('invalid pinned body manifest')
    raw = fetch(key, 65536)
    if len(raw) > 65536 or hashlib.sha256(raw).hexdigest() != expected:
        raise ValueError('body manifest checksum mismatch')
    manifest = json.loads(raw)
    if manifest.get('schema') != 'body-assets.v1' or not isinstance(manifest.get('version'), str) or not manifest['version']:
        raise ValueError('invalid body manifest schema')
    files = manifest.get('files')
    if not isinstance(files, list) or not files or len(files) > 10000:
        raise ValueError('invalid body file list')
    seen, total = set(), 0
    for f in files:
        path, size, digest, roles = f.get('path'), f.get('size'), f.get('sha256'), f.get('roles')
        if not isinstance(path, str) or not ALLOWED_PATH.fullmatch(path) or path in seen:
            raise ValueError('invalid or duplicate body asset path')
        if type(size) is not int or not 0 < size <= LIMIT or not isinstance(digest, str) or not re.fullmatch(r'[a-f0-9]{64}', digest):
            raise ValueError('invalid body asset identity')
        if not isinstance(roles, list) or not roles or any(r not in ROLES for r in roles) or len(set(roles)) != len(roles):
            raise ValueError('invalid body asset roles')
        seen.add(path)
        total += size
    if total > LIMIT:
        raise ValueError('body release size exceeded')
    selected = [f for f in files if role in f['roles']]
    required = {'inference': 'body-catalog.json', 'converter': 'characters.json', 'bff': 'body-models.json'}[role]
    if required not in {f['path'] for f in selected}:
        raise ValueError('body role catalog missing')
    root = Path(env.get('BODY_ASSETS_ROOT', '/app/body-staging'))
    root.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix='.body-assets-', dir=root))
    try:
        for f in selected:
            data = fetch(key.rsplit('/', 1)[0] + '/' + f['path'], f['size'])
            if len(data) != f['size'] or hashlib.sha256(data).hexdigest() != f['sha256']:
                raise ValueError('body asset checksum mismatch: ' + f['path'])
            target = stage / f['path']
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
            target.chmod(0o644)
        for f in selected:
            target = root / f['path']
            target.parent.mkdir(parents=True, exist_ok=True)
            os.replace(stage / f['path'], target)
        receipt = dict(event='body_assets_ready', role=role, version=manifest['version'], manifestSha256=expected, files=len(selected))
        (root / '.body-assets-ready.json').write_text(json.dumps(receipt) + '\n')
        print(json.dumps(receipt), flush=True)
        return receipt
    finally:
        shutil.rmtree(stage)

if __name__ == '__main__':
    import boto3
    from botocore.config import Config
    client = boto3.client('s3', config=Config(connect_timeout=5, read_timeout=30, retries={'max_attempts': 2}))
    def fetch(key, limit):
        response = client.get_object(Bucket=os.environ['BODY_ASSETS_BUCKET'], Key=key)
        with response['Body'] as body:
            return body.read(limit + 1)
    install(fetch)
