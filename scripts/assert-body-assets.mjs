import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const [mode,file]=process.argv.slice(2);
assert.ok(['on','off'].includes(mode));
const template=JSON.parse(readFileSync(file,'utf8'));
const tasks=Object.values(template.Resources).filter(r=>r.Type==='AWS::ECS::TaskDefinition');
const mains=['bff','inference','converter','analysis-worker'];
let checked=0;
for(const task of tasks) {
  const containers=task.Properties.ContainerDefinitions;
  const main=containers.find(c=>mains.includes(c.Name));
  if(!main)continue;
  const init=containers.find(c=>c.Name==='body-assets-init');
  if(mode==='off'){assert.equal(init,undefined);continue;}
  checked++;
  assert.ok(init);
  assert.equal(init.Essential,false);
  assert.equal(init.User,'0');
  if(main.Name==='bff'||main.Name==='analysis-worker') {
    assert.deepEqual(init.Image,main.Image,'Node initializer must use the deployed BFF runtime');
  } else {
    assert.match(init.Image,/@sha256:[a-f0-9]{64}$/);
  }
  assert.ok(main.DependsOn.some(d=>d.ContainerName===init.Name&&d.Condition==='SUCCESS'));
  assert.ok(main.MountPoints.some(m=>m.SourceVolume==='body-assets'&&m.ContainerPath==='/app/body-staging'&&m.ReadOnly===true));
  assert.ok(init.MountPoints.some(m=>m.SourceVolume==='body-assets'&&m.ReadOnly===false));
  assert.ok(init.Environment.some(e=>e.Name==='BODY_ASSETS_MANIFEST_SHA256'&&/^[a-f0-9]{64}$/.test(e.Value)));
  const env=Object.fromEntries(main.Environment.map(e=>[e.Name,e.Value]));
  if(main.Name==='bff'||main.Name==='analysis-worker') {
    for(const flag of ['BODY_SELECTION_ENABLED','BODY_UX_ENABLED','BODY_SHAPE_EDIT_ENABLED','BODY_SHAPE_BAKE_ENABLED'])assert.equal(env[flag],'true');
    assert.equal(env.CONVERTER_SHAPE_TIMEOUT_MS,'320000');
  }
  if(main.Name==='converter')assert.equal(env.CONVERTER_SHAPE_REGISTRY,'/app/body-staging/shape-bakes.json');
  if(main.Name==='inference') {
    assert.equal(env.ROUTING_FULLBODY_ENABLED,'1');assert.equal(env.ROUTING_PREPARE_ASSETS,'1');
    assert.equal(env.POSE_MODEL_VARIANT,'humanart-m');
  }
  assert.ok(main.Environment.some(e=>['BODY_CATALOG_PATH','CONVERTER_CHARACTER_REGISTRY'].includes(e.Name)&&e.Value.startsWith('/app/body-staging/')));
}
if(mode==='on')assert.equal(checked,4);
console.log(`body asset ${mode}: task startup dependencies and readonly mounts verified`);
