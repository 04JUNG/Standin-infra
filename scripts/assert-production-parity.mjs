import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const template=JSON.parse(readFileSync(process.argv[2]??'cdk.out-prod/StandinApp.template.json','utf8'));
const resources=Object.values(template.Resources);
const alb=resources.find(r=>r.Type==='AWS::ElasticLoadBalancingV2::LoadBalancer');
const idleTimeout=alb.Properties.LoadBalancerAttributes.find(a=>a.Key==='idle_timeout.timeout_seconds');
assert.equal(idleTimeout.Value,'330','production must allow the bounded 300s export response');
const tasks=resources.filter(r=>r.Type==='AWS::ECS::TaskDefinition');
const containers=tasks.flatMap(r=>r.Properties.ContainerDefinitions);
const get=name=>{const found=containers.filter(c=>c.Name===name);assert.equal(found.length,1,name);return found[0];};
const env=c=>Object.fromEntries(c.Environment.map(e=>[e.Name,e.Value]));
const profile=JSON.parse(readFileSync('config/production-runtime-parity.json','utf8'));
const body=JSON.parse(readFileSync('config/production-body-assets.json','utf8'));
const stage=JSON.parse(readFileSync('config/staging-body-assets.json','utf8'));
// New staging appearance assets are opt-in; main must retain its approved production pins.
assert.deepEqual(body.manifests,profile.bodyManifests,'production pins match the frozen approved runtime profile');
assert.equal(body.defaultCharacterId,stage.defaultCharacterId,'same default model identity');
assert.equal(body.appearanceEnabled,undefined,'appearance activation requires a separate production rollout');
const inference=env(get('inference'));
const inferenceTask=tasks.find(t=>t.Properties.ContainerDefinitions.some(c=>c.Name==='inference'));
assert.equal(inferenceTask.Properties.Cpu,'4096','preserve deployed production CPU');
assert.equal(inferenceTask.Properties.Memory,'8192','preserve deployed production memory');
assert.equal(inference.BODY_MATCHING_MODE,'off');
// Match the reviewed main prepare_fullbody_deployment.py contract. A partial
// rollout cannot start Human-Art even when its model bundle is installed.
for (const [name,value] of Object.entries({ROUTING_FULLBODY_ENABLED:'1',
  ROUTING_PREPARE_ASSETS:'1',POSE_BACKEND:'rtmlib',POSE_MODEL_VARIANT:'humanart-m',
  POSE_CANARY_STAGE:'canary-100',POSE_STRICT:'1',POSE_CALIBRATION_FROM_MANIFEST:'1'}))
  assert.equal(inference[name],value,`complete fullbody startup: ${name}`);
assert.equal(inference.SEMANTIC_REVIEWED_PROPS_FIRST,'1');
assert.equal(inference.HAND_SKIN_SCREEN_CONCURRENCY,'2');
assert.ok(JSON.stringify(inference.POSE_LIBRARY_URI).includes(profile.poseLibraryKey));
assert.ok(JSON.stringify(inference.POSE_THUMBNAIL_OVERLAY_URI).includes(profile.thumbnailKey));
assert.equal(inference.POSE_THUMBNAIL_OVERLAY_SHA256,profile.thumbnailSha256);
for(const name of ['inference','bff','analysis-worker']) assert.equal(env(get(name)).REFINE_RELEASE_ENABLED,'0');
assert.equal(inference.REFINE_DEFAULT_MODE,'aggressive');assert.equal(inference.REFINE_V25_SELECTOR_ENABLED,'1');
const bff=get('bff'),converter=get('converter');
assert.equal(new Set(profile.accessPolicy.operatorInstallationIds).size,3,'exactly three explicit operator installations');
assert.ok(Number.isFinite(Date.parse(profile.accessPolicy.openBetaEndedAt)),'fixed beta closure time');
for (const name of ['bff','analysis-worker']) {
  const access=env(get(name));
  assert.equal(access.ACCESS_GATE_ENABLED,'true',`${name}: code access gate remains enabled`);
  assert.equal(access.SUPPORTER_ACCESS_ENABLED,'true',`${name}: registered codes stay usable`);
  assert.equal(access.ACCESS_OPERATOR_INSTALLATIONS,profile.accessPolicy.operatorInstallationIds.join(','));
  assert.equal(access.OPEN_BETA_ENDED_AT,profile.accessPolicy.openBetaEndedAt);
}
assert.ok(JSON.stringify(converter.Image).includes(profile.converterImageDigest),'same verified immutable Converter image');
assert.equal(env(bff).INTERACTIVE_STATE_ENABLED,'true');
assert.equal(env(converter).CONVERTER_INTERACTIVE_ENABLED,'true');
const token=c=>c.Secrets.find(s=>s.Name==='CONVERTER_INTERACTIVE_TOKEN')?.ValueFrom;
assert.ok(token(bff));assert.deepEqual(token(bff),token(converter),'private credential shared only within production');
assert.ok(JSON.stringify(token(bff)).includes('ProductionInteractiveToken'));
assert.equal(env(bff).REPLAY_ENVIRONMENT,'production');assert.equal(env(bff).REPLAY_CONSENT_MODE,'explicit');
assert.ok(env(bff).REPLAY_BUCKET,'production replay has durable private storage');
assert.equal(env(converter).REVIEWED_LIBRARY_SHA256,profile.reviewedManifestSha256);
assert.ok(converter.DependsOn.some(d=>d.ContainerName==='reviewed-library-init'&&d.Condition==='SUCCESS'));
assert.ok(converter.MountPoints.some(m=>m.SourceVolume==='reviewed-library'&&m.ReadOnly===true));
for(const c of containers)assert.ok(!JSON.stringify(c.Environment).includes('standinstagingapp-'),'no staging bucket in production');
const service=resources.find(r=>r.Type==='AWS::ECS::Service'&&JSON.stringify(r.Properties.TaskDefinition).includes('ConverterTask'));
assert.equal(service.Properties.DesiredCount,1);
assert.equal(service.Properties.DeploymentConfiguration.MaximumPercent,100);
console.log('Production product flags, approved body/pose/preview assets, private transport, refine rollback and storage verified');
