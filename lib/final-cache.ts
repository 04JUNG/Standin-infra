import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Staging-only persistence. Operator control objects are never writable by the worker. */
export function configureStagingFinalCache(task: ecs.FargateTaskDefinition,
    main: ecs.ContainerDefinition, bucket: s3.IBucket) {
  const c = JSON.parse(readFileSync(join(__dirname, '../config/staging-final-cache.json'), 'utf8'));
  if (c.version !== 'staging-verified-final-cache-v1' ||
      !/^[a-f0-9]{64}$/.test(c.librarySha256) ||
      c.libraryKey !== `verified-final-control/library-${c.librarySha256}.json` ||
      c.revocationsKey !== 'verified-final-control/revoked.json' || c.dataPrefix !== 'verified-final-data/v1/') {
    throw new Error('Invalid pinned final cache configuration');
  }
  const env = {
    CONVERTER_FINAL_CACHE_ROOT: '/tmp/standin-verified-final',
    CONVERTER_FINAL_CACHE_S3_URI: `s3://${bucket.bucketName}/${c.dataPrefix}`,
    CONVERTER_FINAL_LIBRARY_URI: `s3://${bucket.bucketName}/${c.libraryKey}`,
    CONVERTER_FINAL_LIBRARY_SHA256: c.librarySha256,
    CONVERTER_FINAL_REVOCATIONS_URI: `s3://${bucket.bucketName}/${c.revocationsKey}`,
    // Cache fills only verified requested combinations; no 3500-pose startup batch.
    CONVERTER_FINAL_PREWARM_ENABLED: '0',
    CONVERTER_REUSE_REST_METRICS: '1',
  };
  for (const [name, value] of Object.entries(env)) main.addEnvironment(name, value);
  task.taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
    actions: ['s3:PutObject'], resources: [bucket.arnForObjects(c.dataPrefix + '*')],
  }));
  // The stack already grants read-only asset access. No DeleteObject or control write grant.
}
