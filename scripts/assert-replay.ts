import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { App, Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import * as ecr from "aws-cdk-lib/aws-ecr";
import { AppStack, type AppStackProps } from "../lib/app-stack";
import { replayConfig } from "../lib/replay-config";
function props(envName: "prod" | "staging", app: App): AppStackProps {
  const registry = new Stack(app, "Registry", { env: { account: "111111111111", region: "ap-northeast-2" } });
  return {
    env: { account: "111111111111", region: "ap-northeast-2" }, envName,
    bffRepo: new ecr.Repository(registry, "Bff"),
    inferenceRepo: new ecr.Repository(registry, "Inference"),
    converterRepo: new ecr.Repository(registry, "Converter"),
    publicUrl: "https://test.invalid", corsOrigins: "https://test.invalid",
    oauthSuccessRedirect: "standin-test://auth/callback",
    certificateArn: "arn:aws:acm:ap-northeast-2:111111111111:certificate/test",
    appEnv: "production", refineEnabled: true, refineFeatureEnabled: true,
    jobExecutionMode: "sqs", serviceDesiredCount: 1, quotaGlobalDaily: "50",
    poseModelBuildId: "test-pose", poseLibraryKey: "pose-library/test.tar.gz",
    converterEnabled: true, fbxExportEnabled: true, converterImageTag: "test",
    imageTag: envName === "prod" ? "latest" : "develop", logShipping: "cloudwatch",
    logRetentionDays: 14, handSelectionEnabled: true, semanticSearchEnabled: true,
  };
}
function synth(settings: Partial<AppStackProps> = {}, envName: "prod" | "staging" = "staging") {
  const app = new App();
  return Template.fromStack(new AppStack(app, "TestApp", { ...props(envName, app), ...settings })).toJSON();
}

const values: Record<string, unknown> = { stagingReplayEnabled: true, productionReplayEnabled: false };
assert.equal(replayConfig("staging", k => values[k]).enabled, true);
assert.equal(replayConfig("prod", k => values[k]).enabled, false);
values.stagingReplayEnabled = false;
values.productionReplayEnabled = true;
assert.equal(replayConfig("staging", k => values[k]).enabled, false);
assert.equal(replayConfig("prod", k => values[k]).enabled, true);
assert.throws(() => replayConfig("prod", () => "assumed"), /explicit/);
assert.throws(() => replayConfig("staging", k => k.endsWith("Enabled") ? "yes" : undefined), /true or false/);
for (const envName of ["staging", "prod"] as const) {
  const template = synth({}, envName);
  const resources = Object.entries(template.Resources) as [string, any][];
  const task = resources.find(([id,r]) => id.startsWith("BffTask") && r.Type === "AWS::ECS::TaskDefinition")![1];
  const bff = task.Properties.ContainerDefinitions.find((c: any) => c.Name === "bff");
  const vars = Object.fromEntries(bff.Environment.map((e: any) => [e.Name,e.Value]));
  assert.equal(vars.NODE_ENV, "production");
  assert.equal(vars.REPLAY_ENVIRONMENT, envName === "staging" ? "staging" : "production");
  assert.equal(vars.REPLAY_ENABLED, envName === "staging" ? "true" : "false");
  assert.equal(vars.REPLAY_CONSENT_MODE, envName === "staging" ? "assumed" : "explicit");
  const [bucketId,bucket] = resources.find(([id,r]) => id.startsWith("ReplayBucket") && r.Type === "AWS::S3::Bucket")!;
  assert.deepEqual(vars.REPLAY_BUCKET, { Ref: bucketId });
  assert.equal(bucket.DeletionPolicy, "Retain");
  assert.equal(bucket.Properties.VersioningConfiguration, undefined);
  assert.equal(bucket.Properties.LifecycleConfiguration.Rules[0].ExpirationInDays, 30);
  assert.equal(bucket.Properties.PublicAccessBlockConfiguration.BlockPublicPolicy, true);
  const policy = resources.find(([id,r]) => id.startsWith("ReplayAccess") && r.Type === "AWS::IAM::Policy")![1];
  assert(JSON.stringify(policy).includes(bucketId));
  if (process.env.REPLAY_TEMPLATE_DIR) writeFileSync(join(process.env.REPLAY_TEMPLATE_DIR, `standin-replay-${envName}-template.json`), JSON.stringify(template,null,2));
}
console.log("Replay environment isolation, production consent guard, private storage and BFF wiring passed");
