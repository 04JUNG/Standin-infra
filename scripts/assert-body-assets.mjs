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
  assert.ok(main.DependsOn.some(d=>d.ContainerName===init.Name&&d.Condition==='SUCCESS'));
  assert.ok(main.MountPoints.some(m=>m.SourceVolume==='body-assets'&&m.ContainerPath==='/app/body-staging'&&m.ReadOnly===true));
  assert.ok(init.MountPoints.some(m=>m.SourceVolume==='body-assets'&&m.ReadOnly===false));
  assert.ok(init.Environment.some(e=>e.Name==='BODY_ASSETS_MANIFEST_SHA256'&&/^[a-f0-9]{64}$/.test(e.Value)));
  assert.ok(main.Environment.some(e=>['BODY_CATALOG_PATH','CONVERTER_CHARACTER_REGISTRY'].includes(e.Name)&&e.Value.startsWith('/app/body-staging/')));
}
if(mode==='on')assert.equal(checked,4);
console.log(`body asset ${mode}: task startup dependencies and readonly mounts verified`);
