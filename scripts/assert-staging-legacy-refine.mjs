import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const [production, staging] = process.argv.slice(2);
if (!production || !staging) throw new Error('usage: assert-staging-legacy-refine.mjs PROD_TEMPLATE STAGING_TEMPLATE');
function containers(path) {
  return Object.values(JSON.parse(readFileSync(path, 'utf8')).Resources)
    .filter(r => r.Type === 'AWS::ECS::TaskDefinition')
    .flatMap(r => r.Properties.ContainerDefinitions);
}
const expected = {
  REFINE_RELEASE_ENABLED: '0', REFINE_V2_ENABLED: '1',
  REFINE_DEFAULT_MODE: 'aggressive', REFINE_V25_SELECTOR_ENABLED: '1',
};
for (const name of ['inference', 'bff', 'analysis-worker']) {
  const matches = containers(staging).filter(c => c.Name === name);
  assert.equal(matches.length, 1, `one staging ${name}`);
  const env = Object.fromEntries(matches[0].Environment.map(e => [e.Name, e.Value]));
  assert.equal(env.REFINE_RELEASE_ENABLED, '0', `${name}: RC4 disabled`);
  if (name === 'inference') for (const [key, value] of Object.entries(expected)) assert.equal(env[key], value, key);
  const prod = containers(production).filter(c => c.Name === name);
  assert.equal(prod.length, 1);
  const prodEnv = Object.fromEntries(prod[0].Environment.map(e => [e.Name, e.Value]));
  for (const key of Object.keys(expected)) assert.equal(prodEnv[key], undefined, `production ${name}:${key} unchanged`);
}
console.log('Staging: legacy aggressive + safety selector; RC4 disabled across all callers. Production policy unchanged.');
