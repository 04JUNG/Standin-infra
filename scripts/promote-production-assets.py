"""Copy a frozen approved release to an isolated production bucket; never replace objects.

Default is a read-only plan. --apply creates only missing keys. Every existing
object must have the same source identity. No ECS, database or secret is changed.
"""
import argparse
import base64
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

def missing(client, bucket, key):
    try:
        return client.head_object(Bucket=bucket, Key=key, ChecksumMode="ENABLED")
    except Exception as exc:
        if getattr(exc, "response", {}).get("Error", {}).get("Code") in ('404', 'NoSuchKey', 'NotFound'):
            return None
        raise

def inventory(client, bucket, profile, body):
    result = {}
    def add(key, size=None, digest=None):
        if '..' in key.split('/') or key.startswith('/'):
            raise ValueError('unsafe asset key')
        head = client.head_object(Bucket=bucket, Key=key, ChecksumMode="ENABLED")
        if size is not None and head['ContentLength'] != size:
            raise ValueError('source asset size mismatch')
        result[key] = {'key': key, 'size': head['ContentLength'], 'etag': head['ETag'], **({'sha256':digest} if digest else {})}
    pins = body.get('manifests', {}).values() or [body]
    for pin in pins:
        key=pin['manifestKey']
        raw=client.get_object(Bucket=bucket,Key=key)['Body'].read(128*1024)
        if hashlib.sha256(raw).hexdigest()!=pin['manifestSha256']:
            raise ValueError('source body manifest mismatch')
        data=json.loads(raw)
        if data['schema']!='body-assets.v1':raise ValueError('invalid body schema')
        add(key,len(raw),pin['manifestSha256'])
        for f in data['files']:
            add(key.rsplit('/',1)[0]+'/'+f['path'],f['size'],f['sha256'])
    preview=[]
    for page in client.get_paginator('list_objects_v2').paginate(Bucket=bucket,Prefix=profile['previewPrefix']+'/'):
        for obj in page.get('Contents',[]):
            if not obj['Key'].endswith(('.json','.glb')):raise ValueError('unexpected preview object')
            row={'key':obj['Key'],'size':obj['Size'],'etag':obj['ETag']}
            preview.append(row);result[obj['Key']]=row
    preview.sort(key=lambda x:x['key'])
    fingerprint=hashlib.sha256(json.dumps(preview,sort_keys=True,separators=(',',':')).encode()).hexdigest()
    if profile.get('previewInventorySha256')!=fingerprint:
        raise ValueError('preview inventory differs from the reviewed pin: '+fingerprint)
    for name in ['poseLibraryKey','thumbnailKey','reviewedKey','recallKey']:
        digest = profile.get({'poseLibraryKey':'poseLibrarySha256','thumbnailKey':'thumbnailSha256','reviewedKey':'reviewedArchiveSha256','recallKey':'recallSha256'}[name])
        add(profile[name],digest=digest)
    return sorted(result.values(),key=lambda x:x['key'])

def copy_one(client, source, target, row, apply=False):
    found=missing(client,target,row['key'])
    if found:
        if found['ContentLength']!=row['size'] or found['ETag']!=row['etag']:
            # Multipart source ETags can change during server-side copying. A copied
            # object records the exact pinned source ETag as additional provenance.
            checksum = found.get('ChecksumSHA256', '')
            whole_sha = base64.b64decode(checksum).hex() if checksum and '-' not in checksum else None
            copied_source = found.get('Metadata',{}).get('promotion-source-etag') == row['etag'].strip('"')
            if found['ContentLength']!=row['size'] or not (copied_source or (row.get('sha256') and whole_sha == row['sha256'])):
                raise ValueError('refusing to replace different destination: '+row['key'])
        return 'existing'
    if not apply:return 'missing'
    # CopySourceIfMatch prevents a source prefix changing after inventory sealing.
    client.copy_object(Bucket=target,Key=row['key'],CopySource={'Bucket':source,'Key':row['key']},
        CopySourceIfMatch=row['etag'],IfNoneMatch='*',MetadataDirective='REPLACE',
        Metadata={'promotion-source-etag':row['etag'].strip('"'),**({'sha256':row['sha256']} if row.get('sha256') else {})})
    check=client.head_object(Bucket=target,Key=row['key'])
    if check['ContentLength']!=row['size']:raise ValueError('copied asset size mismatch')
    return 'copied'

def main():
    import boto3
    from botocore.config import Config
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-bucket',required=True)
    parser.add_argument('--target-bucket',required=True)
    parser.add_argument('--apply',action='store_true')
    parser.add_argument('--report',type=Path,required=True)
    args=parser.parse_args()
    if args.source_bucket==args.target_bucket or args.target_bucket.startswith('standinstagingapp-'):
        raise ValueError('distinct production bucket required')
    client=boto3.client('s3',region_name='ap-northeast-2',config=Config(max_pool_connections=24,retries={'max_attempts':4}))
    profile=json.loads((ROOT/'config/production-runtime-parity.json').read_text())
    body=json.loads((ROOT/'config/production-body-assets.json').read_text())
    rows=inventory(client,args.source_bucket,profile,body)
    counts={}
    with ThreadPoolExecutor(max_workers=16) as pool:
        for i,status in enumerate(pool.map(lambda row:copy_one(client,args.source_bucket,args.target_bucket,row,args.apply),rows),1):
            counts[status]=counts.get(status,0)+1
            if i%1000==0:print(json.dumps({'checked':i,**counts}),flush=True)
    report={'version':profile['version'],'source':args.source_bucket,'target':args.target_bucket,
        'apply':args.apply,'objects':len(rows),'bytes':sum(r['size'] for r in rows),'counts':counts,
        'inventorySha256':hashlib.sha256(json.dumps(rows,sort_keys=True).encode()).hexdigest()}
    args.report.write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report),flush=True)
if __name__=='__main__':main()
