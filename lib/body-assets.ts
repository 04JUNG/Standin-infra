import { Stack } from "aws-cdk-lib";
import * as ecs from 'aws-cdk-lib/aws-ecs';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import { readFileSync } from 'node:fs';
import path from 'node:path';

export interface BodyAssetsRelease {
  version: string;
  manifestKey: string;
  manifestSha256: string;
  bodyEnvironment: Record<string, string>;
  shapeBakeEnabled?: boolean;
  initImages?: Partial<Record<'inference' | 'converter' | 'bff', string>>;
}

export function configureBodyAssets(
  task: ecs.FargateTaskDefinition,
  main: ecs.ContainerDefinition,
  assets: s3.Bucket,
  image: ecs.ContainerImage,
  release: BodyAssetsRelease,
  role: 'inference' | 'converter' | 'bff',
) {
  if (!/^body-models\/releases\/[a-z0-9-]+\/manifest\.json$/.test(release.manifestKey) || !/^[a-f0-9]{64}$/.test(release.manifestSha256)) throw new Error('invalid pinned body release');
  const initImage = release.initImages?.[role];
  if (initImage && !/@sha256:[a-f0-9]{64}$/.test(initImage)) throw new Error('body initializer image must be digest pinned');
  const root = '/app/body-staging';
  for (const [key, value] of Object.entries(release.bodyEnvironment)) {
    if (!/^BODY_[A-Z0-9_]+_URI$/.test(key) || !/^\/app\/body-staging\/fbx\/[a-z0-9-]+\.fbx$/.test(value)) throw new Error('invalid body registry environment');
  }
  const environment = role === 'inference'
    ? { BODY_CATALOG_PATH: `${root}/body-catalog.json`, BODY_MATCHING_MODE: 'auto', BODY_VLM_PROVIDER: 'gemini', BODY_VLM_MODEL: 'gemini-flash-lite-latest', BODY_TIMEOUT_SECONDS: '45', ROUTING_FULLBODY_ENABLED: '1', ROUTING_PREPARE_ASSETS: '1', POSE_CALIBRATION_FROM_MANIFEST: '1', POSE_MODEL_VARIANT: 'humanart-m', VLM_PERSON_TAGS: '1' }
    : role === 'bff'
      ? { BODY_CATALOG_PATH: `${root}/body-models.json`, BODY_SELECTION_ENABLED: 'true', BODY_UX_ENABLED: 'true', ...(release.shapeBakeEnabled ? { BODY_SHAPE_EDIT_ENABLED: 'true', BODY_SHAPE_BAKE_ENABLED: 'true', CONVERTER_SHAPE_TIMEOUT_MS: '320000' } : {}) }
      : { CONVERTER_CHARACTER_REGISTRY: `${root}/characters.json`, POSE_PREVIEW_URI: `${root}/preview`, ...(release.shapeBakeEnabled ? { CONVERTER_SHAPE_REGISTRY: `${root}/shape-bakes.json`, CONVERTER_SHAPE_TIMEOUT_SECONDS: '300' } : {}), ...release.bodyEnvironment };
  for (const [name, value] of Object.entries(environment)) main.addEnvironment(name, value);
  task.addVolume({ name: 'body-assets' });
  main.addMountPoints({ sourceVolume: 'body-assets', containerPath: root, readOnly: true });
  const source = readFileSync(path.join(__dirname, '..', 'scripts', role === 'bff' ? 'body-assets-init.mjs' : 'body-assets-init.py'), 'utf8');
  const init = task.addContainer('body-assets-init', {
    image: initImage ? ecs.ContainerImage.fromRegistry(initImage) : image,
    essential: false,
    user: '0',
    entryPoint: [],
    command: role === 'bff' ? ['node', '--input-type=module', '-e', source] : ['python', '-c', source],
    memoryReservationMiB: 128,
    logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'body-assets-init' }),
    environment: {
      AWS_REGION: Stack.of(task).region,
      AWS_DEFAULT_REGION: Stack.of(task).region,
      BODY_ASSETS_BUCKET: assets.bucketName,
      BODY_ASSETS_MANIFEST_KEY: release.manifestKey,
      BODY_ASSETS_MANIFEST_SHA256: release.manifestSha256,
      BODY_ASSETS_ROLE: role,
      BODY_ASSETS_ROOT: root,
    },
  });
  init.addMountPoints({ sourceVolume: 'body-assets', containerPath: root, readOnly: false });
  main.addContainerDependencies({ container: init, condition: ecs.ContainerDependencyCondition.SUCCESS });
  assets.grantRead(task.taskRole, release.manifestKey.slice(0, release.manifestKey.lastIndexOf('/')) + '/*');
}
