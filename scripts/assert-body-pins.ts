import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { App, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { configureBodyAssets, type BodyAssetRole, type BodyAssetsRelease } from '../lib/body-assets';

const staging: BodyAssetsRelease = JSON.parse(readFileSync('config/staging-body-assets.json', 'utf8'));
const production: BodyAssetsRelease = JSON.parse(readFileSync('config/production-body-assets.json', 'utf8'));
function synth(release: BodyAssetsRelease, role: BodyAssetRole) {
  const stack = new Stack(new App(), release.appearanceEnabled ? 'StandinStagingAppPinTest' : 'PinTest');
  const task = new ecs.FargateTaskDefinition(stack, 'Task');
  const image = ecs.ContainerImage.fromRegistry('example/runtime:test');
  const main = task.addContainer('runtime', { image });
  configureBodyAssets(task, main, new s3.Bucket(stack, 'Assets'), image, release, role);
  const template = Template.fromStack(stack).toJSON();
  const definition: any = Object.values(template.Resources).find((r: any) => r.Type === 'AWS::ECS::TaskDefinition');
  const containers = definition.Properties.ContainerDefinitions;
  const init = containers.find((c: any) => c.Name === 'body-assets-init');
  const env = (container: any) => Object.fromEntries(container.Environment.map((e: any) => [e.Name, e.Value]));
  return { template, init, pin: env(init), main: env(containers.find((c: any) => c.Name === 'runtime')) };
}

const expected = {
  converter: '8149c15685398ba279550a9887fa8d05b5208e26b60264e6fa55a6cc20a09771',
  bff: '0897cb6c18fdef3e24b945bc2df9b09e8e7f65579130a98127e97c72264a97cc',
  inference: '9acb2ee7ec2444706107b5d1c5b264866dc35bdfc8918a31cbec997d12fc9d72',
};
for (const role of ['converter', 'bff', 'inference'] as const) {
  const rendered = synth(staging, role);
  assert.equal(rendered.pin.BODY_ASSETS_MANIFEST_SHA256, expected[role]);
  const key = staging.manifests![role]!.manifestKey;
  assert.equal(rendered.pin.BODY_ASSETS_MANIFEST_KEY, key);
  assert.ok(JSON.stringify(rendered.template).includes(key.slice(0, key.lastIndexOf('/')) + '/*'), 'grant read only under the selected role release');
  if (role === 'bff') {
    assert.equal(rendered.main.CONVERTER_CHARACTER_ID, 'male-base-v0-8-0');
    assert.equal(rendered.main.SKIN_EXPORT_ENABLED, 'true');
    assert.equal(rendered.main.OUTLINE_EXPORT_ENABLED, 'true');
    assert.equal(rendered.init.Image, 'example/runtime:test');
  } else assert.equal(rendered.init.Image, staging.initImages![role]);
  // Production retains its reviewed release until the appearance rollout is approved.
  const promoted = synth(production, role);
  const productionPin = production.manifests?.[role] ?? production;
  assert.equal(promoted.pin.BODY_ASSETS_MANIFEST_KEY, productionPin.manifestKey);
  assert.equal(promoted.pin.BODY_ASSETS_MANIFEST_SHA256, productionPin.manifestSha256);
  if (role === 'bff') {
    assert.equal(promoted.main.CONVERTER_CHARACTER_ID, 'male-base-v0-8-0');
    assert.equal(promoted.main.SKIN_EXPORT_ENABLED, 'true');
    assert.equal(promoted.main.OUTLINE_EXPORT_ENABLED, 'true');
  }
  if (role === 'converter') assert.equal(promoted.main.CONVERTER_SKIN_ENABLED, 'true');
}
for (const manifestKey of ['body-models/releases/test/../escape/manifest.json', 'body-models/releases/test/presets-invalid/manifest.json']) {
  const invalid = structuredClone(staging);
  invalid.manifests!.bff!.manifestKey = manifestKey;
  assert.throws(() => synth(invalid, 'bff'), /invalid pinned body release/);
}
const invalidHash = structuredClone(staging);
invalidHash.manifests!.converter!.manifestSha256 = 'latest';
assert.throws(() => synth(invalidHash, 'converter'), /invalid pinned body release/);
console.log('Staging role pins, default model, scoped IAM, unsafe paths and preserved production pins passed');
