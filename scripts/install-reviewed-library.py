"""Install only a pinned operator-owned reviewed FBX release into a fresh volume."""
import hashlib,json,os,re,tarfile,tempfile
from pathlib import Path
import boto3

def install():
    root=Path(os.environ['REVIEWED_LIBRARY_ROOT']);root.mkdir(parents=True,exist_ok=True)
    uri=os.environ['REVIEWED_LIBRARY_ARCHIVE_URI'];expected=os.environ['REVIEWED_LIBRARY_ARCHIVE_SHA256']
    manifest_sha=os.environ['REVIEWED_LIBRARY_SHA256']
    if not uri.startswith('s3://') or not re.fullmatch('[a-f0-9]{64}',expected) or not re.fullmatch('[a-f0-9]{64}',manifest_sha):raise ValueError('invalid reviewed release pin')
    bucket,key=uri[5:].split('/',1)
    with tempfile.TemporaryDirectory(prefix='reviewed-library-') as temp:
        archive=Path(temp)/'release.tar.gz';boto3.client('s3').download_file(bucket,key,str(archive))
        sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
        if sha(archive)!=expected:raise ValueError('reviewed archive hash mismatch')
        seen=set();total=0
        with tarfile.open(archive,'r:gz') as tar:
            for m in tar:
                if not m.isfile() or m.name in seen or not re.fullmatch(r'(?:manifest\.json|ATTRIBUTION\.json|[a-f0-9]{64}\.fbx)',m.name):raise ValueError('invalid reviewed archive entry')
                total+=m.size
                if not 0<m.size<32*1024**2 or total>512*1024**2 or len(seen)>10000:raise ValueError('reviewed release bounds exceeded')
                seen.add(m.name)
                with tar.extractfile(m) as src,(root/m.name).open('xb') as dst:dst.write(src.read())
                (root/m.name).chmod(0o644)
        if sha(root/'manifest.json')!=manifest_sha:raise ValueError('reviewed manifest hash mismatch')
        manifest=json.loads((root/'manifest.json').read_bytes())
        if manifest['version']!='reviewed-library-fbx-v1':raise ValueError('unsupported reviewed release')
        files={'manifest.json','ATTRIBUTION.json'}
        for source,row in manifest['poses'].items():
            if row['path']!=source+'.fbx' or sha(root/row['path'])!=row['fbx_sha256']:raise ValueError('reviewed FBX mismatch')
            files.add(row['path'])
        if seen!=files:raise ValueError('reviewed inventory mismatch')
        print(json.dumps(dict(event='reviewed_library_ready',poses=len(manifest['poses']),manifest_sha256=manifest_sha)),flush=True)

if __name__=='__main__':install()
