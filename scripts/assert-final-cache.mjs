import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const [prodPath='cdk.out-prod/StandinApp.template.json', stagePath='cdk.out-staging/StandinStagingApp.template.json'] = process.argv.slice(2);
const load = p => JSON.parse(readFileSync(p,'utf8'));
const prod=load(prodPath), stage=load(stagePath);
function converter(t) {
 return Object.values(t.Resources).filter(r=>r.Type==='AWS::ECS::TaskDefinition')
  .flatMap(r=>r.Properties.ContainerDefinitions).find(c=>c.Name==='converter');
}
const env = c => Object.fromEntries(c.Environment.map(e=>[e.Name,e.Value]));
const p=env(converter(prod)), s=env(converter(stage));
assert.equal(p.CONVERTER_FINAL_CACHE_ROOT,undefined);
assert.equal(p.CONVERTER_REUSE_REST_METRICS,undefined);
assert.equal(s.CONVERTER_FINAL_CACHE_ROOT,'/tmp/standin-verified-final');
assert.equal(s.CONVERTER_FINAL_PREWARM_ENABLED,'0');
assert.equal(s.CONVERTER_REUSE_REST_METRICS,'1');
assert.match(s.CONVERTER_FINAL_LIBRARY_SHA256,/^[a-f0-9]{64}$/);
assert.equal(JSON.stringify(prod).includes('verified-final-data/'),false);
let found=0;
for(const r of Object.values(stage.Resources)) {
 if(r.Type!=='AWS::IAM::Policy') continue;
 for(const st of r.Properties.PolicyDocument.Statement) {
  if(JSON.stringify(st.Resource).includes('verified-final-data/v1/*')) {
   assert.deepEqual(st.Action,'s3:PutObject');found++;
   assert.equal(JSON.stringify(st.Resource).includes('verified-final-control'),false);
  }
 }
}
assert.equal(found,1);
console.log('Staging private cache persistence, write-prefix isolation, fixed controls and unchanged production passed');
