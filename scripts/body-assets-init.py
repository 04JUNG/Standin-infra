"""Install a pinned S3 body release into an ECS shared volume before app startup."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import tempfile

ALLOWED_PATH = re.compile(r'(?:skin/[a-z0-9-]+\.(?:png|json|json\.gz)|shape-bakes\.json|sources/[a-z0-9-]+\.(?:blend|py)|runtime/[a-z0-9-]+\.ssr|body-catalog\.json|body-models\.json|characters\.json|(?:fbx/[a-z0-9-]+\.fbx)|(?:png/[a-z0-9-]+\.png)|(?:qa/[a-z0-9-]+\.json)|(?:preview/posed-mesh-v1/[a-f0-9]{64}\.(?:json|glb)))\Z')
ROLES = {'inference', 'converter', 'bff'}
LIMIT = 300 * 1024 * 1024
RELEASE_CAP = 768 * 1024 * 1024
PREPARED_CAP = 192 * 1024 * 1024
PREPARED_PROFILE = 'prepared-neutral-20.v1'
LOD_PROFILE = 'lod-defaults-20.v1'
LOD_RELEASE_CAP = 1280 * 1024 * 1024
PREPARED_PATH = re.compile(r'(fbx|qa)/prepared-([a-f0-9]{64})\.(fbx|json)\Z')


def check_budget(files, profile=None, role='converter'):
    """A finite Converter-only allowance; ordinary assets keep their old cap."""
    if profile is None:
        if sum(f['size'] for f in files) > RELEASE_CAP:
            raise ValueError('body release size exceeded')
        return RELEASE_CAP
    if profile not in (PREPARED_PROFILE, LOD_PROFILE) or role != 'converter':
        raise ValueError('invalid prepared budget profile')
    # The LOD release preserves all historical models and adds two independently
    # pinned sources, twenty FBXs and their topology-specific UV data. This does
    # not change ordinary releases, individual file limits or prepared limits.
    base_cap = LOD_RELEASE_CAP if profile == LOD_PROFILE else RELEASE_CAP
    base, prepared, pairs = 0, 0, {}
    for f in files:
        match = PREPARED_PATH.fullmatch(f['path'])
        if not match:
            base += f['size']
            continue
        folder, key, extension = match.groups()
        if (f['roles'] != ['converter'] or (folder, extension) not in (('fbx', 'fbx'), ('qa', 'json'))
                or f['size'] > (64 * 1024 * 1024 if folder == 'fbx' else 256 * 1024)):
            raise ValueError('invalid prepared budget file')
        pairs.setdefault(key, set()).add(folder)
        prepared += f['size']
    # 20 current bodies plus up to two preserved previous default prototypes.
    if not pairs or len(pairs) > 22 or any(v != {'fbx', 'qa'} for v in pairs.values()):
        raise ValueError('invalid prepared budget pairs')
    if base > base_cap or prepared > PREPARED_CAP:
        raise ValueError('body release size exceeded')
    return base_cap + PREPARED_CAP


def validate_files(files):
    if not isinstance(files, list) or not files or len(files) > 10000:
        raise ValueError('invalid body file list')
    seen = set()
    for f in files:
        path, size, digest, roles = f.get('path'), f.get('size'), f.get('sha256'), f.get('roles')
        if not isinstance(path, str) or not ALLOWED_PATH.fullmatch(path) or path in seen:
            raise ValueError('invalid or duplicate body asset path')
        if type(size) is not int or not 0 < size <= LIMIT or not isinstance(digest, str) or not re.fullmatch(r'[a-f0-9]{64}', digest):
            raise ValueError('invalid body asset identity')
        if not isinstance(roles, list) or not roles or any(r not in ROLES for r in roles) or len(set(roles)) != len(roles):
            raise ValueError('invalid body asset roles')
        seen.add(path)


def verify_prepared(stage, files):
    """Verify prototypes with the real Converter reader before publishing any file.

    Registry paths name the deployment mount. Only manifest-selected, staged
    files may be read here; filenames and hashes remain part of the identity.
    """
    paths = {f['path']: f for f in files}
    prepared = {p for p in paths if PREPARED_PATH.fullmatch(p)}
    if not prepared:
        return 0
    if 'shape-bakes.json' not in paths or 'characters.json' not in paths:
        raise ValueError('prepared registry missing')
    registry = json.loads((stage / 'shape-bakes.json').read_bytes())
    characters = json.loads((stage / 'characters.json').read_bytes())['characters']
    index = registry.get('prepared_neutrals', {})
    entries = index.get('entries')
    if index.get('schema') != 'prepared-neutral-index.v1' or not isinstance(entries, dict) or not entries:
        raise ValueError('invalid prepared index')
    try:
        from converter.prepared_body import read_prepared, preset_values
    except ImportError as error:
        raise ValueError('prepared identity verifier unavailable') from error
    used = set()
    for cid, entry in entries.items():
        if not isinstance(entry, dict) or set(entry) != {'path', 'sha256'}:
            raise ValueError('invalid prepared entry')
        recorded = Path(entry['path'])
        receipt_path = 'qa/' + recorded.name
        if (not recorded.is_absolute() or recorded.parent.name != 'qa'
                or receipt_path not in prepared or paths[receipt_path]['sha256'] != entry['sha256']):
            raise ValueError('prepared receipt escaped manifest')
        match = PREPARED_PATH.fullmatch(receipt_path)
        fbx_path = 'fbx/prepared-' + match.group(2) + '.fbx'
        if fbx_path not in prepared:
            raise ValueError('prepared FBX missing')
        raw = registry['characters'][cid]
        if characters[cid]['sha256'] != raw['asset_sha256']:
            raise ValueError('prepared character identity mismatch')
        source = dict(registry['sources'][raw['rules']])
        for name in ('blend', 'controller'):
            original = Path(source[name])
            local = 'sources/' + original.name
            if (not original.is_absolute() or original.parent.name != 'sources'
                    or local not in paths or paths[local]['sha256'] != source[name + '_sha256']):
                raise ValueError('prepared source escaped manifest')
            source[name] = str(stage / local)
        recipe = {**raw, **source, 'values': preset_values(raw)}
        read_prepared(recipe, {**entry, 'path': str(stage / receipt_path)})
        used.update((receipt_path, fbx_path))
    if used != prepared:
        raise ValueError('unindexed prepared file')
    return len(entries)


def install(fetch, env=os.environ):
    role = env['BODY_ASSETS_ROLE']
    if role not in ROLES:
        raise ValueError('invalid body asset role')
    key = env['BODY_ASSETS_MANIFEST_KEY']
    expected = env['BODY_ASSETS_MANIFEST_SHA256']
    if not re.fullmatch(r'body-models/releases/[a-z0-9-]+(?:/presets-[a-f0-9]{12})?/manifest\.json', key) or not re.fullmatch(r'[a-f0-9]{64}', expected):
        raise ValueError('invalid pinned body manifest')
    raw = fetch(key, 65536)
    if len(raw) > 65536 or hashlib.sha256(raw).hexdigest() != expected:
        raise ValueError('body manifest checksum mismatch')
    manifest = json.loads(raw)
    if manifest.get('schema') != 'body-assets.v1' or not isinstance(manifest.get('version'), str) or not manifest['version']:
        raise ValueError('invalid body manifest schema')
    files = manifest.get('files')
    validate_files(files)
    check_budget(files, manifest.get('budgetProfile'), role)
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
        prepared_count = verify_prepared(stage, selected) if role == 'converter' else 0
        for f in selected:
            target = root / f['path']
            target.parent.mkdir(parents=True, exist_ok=True)
            os.replace(stage / f['path'], target)
        receipt = dict(event='body_assets_ready', role=role, version=manifest['version'], manifestSha256=expected, files=len(selected))
        if prepared_count:
            receipt['preparedIdentitiesVerified'] = prepared_count
        (root / '.body-assets-ready.json').write_text(json.dumps(receipt) + '\n')
        print(json.dumps(receipt), flush=True)
        return receipt
    finally:
        if stage.resolve().parent != root.resolve():
            raise ValueError('temporary asset path escaped the install root')
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
