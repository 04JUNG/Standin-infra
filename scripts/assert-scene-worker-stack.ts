import assert from 'node:assert/strict';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { SceneWorkerStack, validateStagingSceneContext } from '../lib/scene-worker-stack';
const context = {
  envName: 'staging' as const, account: '111111111111', region: 'ap-northeast-2',
  vpcId: 'vpc-1234', availabilityZones: ['ap-northeast-2a', 'ap-northeast-2b'],
  publicSubnetIds: ['subnet-1234', 'subnet-2345'], isolatedSubnetIds: ['subnet-3456', 'subnet-4567'],
  clusterArn: 'arn:aws:ecs:ap-northeast-2:111111111111:cluster/StandinStagingApp-cluster',
  bffSecurityGroupId: 'sg-1234', namespaceId: 'ns-test',
  namespaceArn: 'arn:aws:servicediscovery:ap-northeast-2:111111111111:namespace/ns-test',
  namespaceName: 'standin-staging.local', assetsBucketName: 'standinstagingapp-assetsbucket-test',
  vlmSecretArn: 'arn:aws:secretsmanager:ap-northeast-2:111111111111:secret:standin/staging/vlm-abcdef',
  githubSubjectPrefixes: ['repo:04JUNG/Standin-server'],
};
const release = {releaseId: 'fixture', manifestSha256: 'a'.repeat(64), bundleKey: 'scene-releases/fixture.tar.gz', bundleSha256: 'b'.repeat(64), imageTag: 'c'.repeat(40), vlmModel: 'test-model'};
for (const active of [false, true]) {
  const app = new App();
  const stack = new SceneWorkerStack(app, 'StandinStagingSceneWorker', {env: {account: context.account, region: context.region}, context, release, active});
  const resources = Object.values(Template.fromStack(stack).toJSON().Resources) as any[];
  const tasks = resources.filter(r => r.Type === 'AWS::ECS::TaskDefinition');
  assert.deepEqual(tasks.map(r => r.Properties.Family).sort(), ['standin-scene-release-publisher-staging', 'standin-scene-worker-staging']);
  const services = resources.filter(r => r.Type === 'AWS::ECS::Service');
  assert.equal(services.length, 1);
  assert.equal(services[0].Properties.DesiredCount, active ? 1 : 0);
  for (const type of ['AWS::S3::Bucket', 'AWS::RDS::DBInstance', 'AWS::EC2::VPC', 'AWS::ECS::Cluster', 'AWS::ServiceDiscovery::PrivateDnsNamespace', 'AWS::ElasticLoadBalancingV2::LoadBalancer']) {
    assert(!resources.some(r => r.Type === type), `${type} must only be referenced`);
  }
  const taskContainers = tasks.flatMap(t => t.Properties.ContainerDefinitions.map((c: any) => c.Name));
  assert.deepEqual(taskContainers.sort(), ['release-publisher', 'scene-worker']);
  assert(!JSON.stringify(resources).includes('StandinApp-'));
}
for (const bad of [
  {...context, envName: 'prod'}, {...context, clusterArn: context.clusterArn.replace('Staging', '')},
  {...context, assetsBucketName: 'standinapp-assetsbucket-production'},
  {...context, vlmSecretArn: context.vlmSecretArn.replace('/staging/', '/production/')},
  {...context, namespaceName: 'standin.local'}, {...context, account: '222222222222'},
  {...context, isolatedSubnetIds: context.publicSubnetIds},
]) assert.throws(() => validateStagingSceneContext(bad));
console.log('Standalone scene stack creates only new staging worker resources.');
