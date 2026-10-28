import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { App, Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import * as ecr from "aws-cdk-lib/aws-ecr";
import { AppStack, type AppStackProps } from "../lib/app-stack";
import { validateSceneWorkerRelease } from "../lib/scene-worker-config";

const release = {
  releaseId: "test-release", manifestSha256: "a".repeat(64),
  bundleKey: "scene-releases/test-release.tar.gz", bundleSha256: "b".repeat(64),
  imageTag: "c".repeat(40), vlmModel: "test-gemini-model",
};
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
const baselineFile = path.join(__dirname, "..", "lib", ".scene-baseline-app-stack.ts");
if (process.env.SCENE_BASE_REF) try {
  writeFileSync(baselineFile, execFileSync("git", ["show", `${process.env.SCENE_BASE_REF}:lib/app-stack.ts`]));
  const Original = (require(baselineFile) as { AppStack: typeof AppStack }).AppStack;
  for (const envName of ["prod", "staging"] as const) {
    const app = new App();
    const before = Template.fromStack(new Original(app, "TestApp", props(envName, app))).toJSON();
    assert.deepEqual(synth({}, envName), before, `${envName} default template changed`);
  }
} finally { unlinkSync(baselineFile); }

const configured = { sceneWorkerRelease: release,
  sceneWorkerGithubSubjects: ["repo:04JUNG/Standin-server"] };
const prepared = synth(configured);
const active = synth({ ...configured, sceneWorkerActive: true, sceneRefinementEnabled: true });
const resources = (template: ReturnType<typeof synth>, type: string) =>
  Object.entries(template.Resources).filter(([, r]: any) => r.Type === type).map(([id, r]: any) => ({ id, ...r.Properties }));
for (const envName of ["prod", "staging"] as const) {
  const defaults = synth({}, envName);
  assert(!Object.keys(defaults.Resources).some(id => id.startsWith("SceneWorker")));
}
const sceneTasks = resources(active, "AWS::ECS::TaskDefinition");
const worker = sceneTasks.find(t => t.Family === "standin-scene-worker-staging");
const publisher = sceneTasks.find(t => t.Family === "standin-scene-release-publisher-staging");
assert(worker && publisher);
assert.equal(worker.RuntimePlatform.CpuArchitecture, "X86_64");
assert.equal(worker.Cpu, "4096");
assert.equal(worker.Memory, "8192");
assert.equal(worker.ContainerDefinitions.length, 1);
const wc = worker.ContainerDefinitions[0];
assert.equal(wc.Name, "scene-worker");
assert(wc.HealthCheck.Command.some((v: string) => v.includes("8002/readyz")));
assert.equal(wc.HealthCheck.StartPeriod, 300);
assert.equal(wc.MountPoints[0].ReadOnly, true);
assert(!wc.Command && !wc.EntryPoint);
assert.equal(worker.Volumes[0].EFSVolumeConfiguration.TransitEncryption, "ENABLED");
assert.equal(worker.Volumes[0].EFSVolumeConfiguration.AuthorizationConfig.IAM, "ENABLED");
const env = Object.fromEntries(wc.Environment.map((e: any) => [e.Name, e.Value]));
assert.equal(env.APP_ENV, "staging");
assert.equal(env.SCENE_REFINEMENT_ENABLED, "1");
assert.equal(env.SCENE_ASSET_MANIFEST_SHA256, release.manifestSha256);
assert.deepEqual(wc.Secrets.map((s: any) => s.Name).sort(), ["GEMINI_API_KEY", "SCENE_REFINEMENT_TOKEN"]);
assert(!env.SCENE_REFINEMENT_TOKEN && !env.GEMINI_API_KEY);
assert.equal(publisher.ContainerDefinitions[0].MountPoints[0].ReadOnly, false);
assert(!publisher.ContainerDefinitions[0].Secrets);
const findService = (t: ReturnType<typeof synth>) => resources(t, "AWS::ECS::Service")
  .find(s => s.id.startsWith("SceneWorkerService"));
assert.equal(findService(prepared).DesiredCount, 0);
assert.equal(findService(active).DesiredCount, 1);
assert.deepEqual(findService(active).DeploymentConfiguration.MaximumPercent, 100);
assert.deepEqual(findService(active).DeploymentConfiguration.MinimumHealthyPercent, 0);
const sceneIngress = resources(active, "AWS::EC2::SecurityGroupIngress")
  .filter(r => r.FromPort === 8002 || (r.FromPort === 2049));
assert.equal(sceneIngress.length, 3);
assert(sceneIngress.every(r => r.SourceSecurityGroupId && !r.CidrIp && !r.CidrIpv6));
const bffContainer = (t: ReturnType<typeof synth>) => resources(t, "AWS::ECS::TaskDefinition")
  .flatMap(t => t.ContainerDefinitions).find((c: any) => c.Name === "bff");
assert.equal(bffContainer(prepared).Environment.find((e: any) => e.Name === "SCENE_REFINEMENT_ENABLED").Value, "false");
assert.equal(bffContainer(active).Environment.find((e: any) => e.Name === "SCENE_REFINEMENT_ENABLED").Value, "true");
assert.deepEqual(bffContainer(active).Secrets.find((s: any) => s.Name === "SCENE_REFINEMENT_TOKEN").ValueFrom,
  wc.Secrets.find((s: any) => s.Name === "SCENE_REFINEMENT_TOKEN").ValueFrom);
const deploy = resources(active, "AWS::IAM::Role").find(r => r.id.startsWith("SceneWorkerDeployRole"));
assert.deepEqual(deploy.AssumeRolePolicyDocument.Statement[0].Condition.StringEquals["token.actions.githubusercontent.com:sub"],
  ["repo:04JUNG/Standin-server:environment:staging"]);
const policies = resources(active, "AWS::IAM::Policy");
const deployPolicy = policies.find(p => p.id.startsWith("SceneWorkerDeployRoleDefaultPolicy"));
const update = deployPolicy.PolicyDocument.Statement.find((s: any) =>
  (Array.isArray(s.Action) ? s.Action : [s.Action]).includes("ecs:UpdateService"));
assert(update && update.Resource !== "*");
assert(JSON.stringify(update.Resource).includes("SceneWorkerService"));
const taskPolicy = policies.find(p => p.id.startsWith("SceneWorkerTaskTaskRoleDefaultPolicy"));
assert(taskPolicy);
assert(!JSON.stringify(taskPolicy).includes("ClientWrite"));
assert(JSON.stringify(taskPolicy).includes("elasticfilesystem:AccessPointArn"));
const publisherPolicy = policies.find(p => p.id.startsWith("SceneWorkerPublisherTaskTaskRoleDefaultPolicy"));
assert(JSON.stringify(publisherPolicy).includes("ClientWrite"));
assert(!JSON.stringify(publisherPolicy).includes("secretsmanager:GetSecretValue"));
const operator = resources(active, "AWS::IAM::ManagedPolicy").find(p => p.id.startsWith("SceneWorkerReleaseOperatorPolicy"));
assert(operator && !operator.Users && !operator.Groups && !operator.Roles);
assert(resources(active, "AWS::EFS::FileSystem").every(f => f.Encrypted));
assert.equal(resources(active, "AWS::ECR::Repository").find(r => r.RepositoryName === "standin/scene-worker").ImageTagMutability, "IMMUTABLE");
assert.throws(() => synth({ ...configured, sceneRefinementEnabled: true }), /active singleton/);
assert.throws(() => synth({ sceneWorkerActive: true }), /release is required/);
assert.throws(() => synth(configured, "prod"), /requires staging/);
assert.throws(() => synth({ ...configured, fbxExportEnabled: false }), /requires staging/);
for (const patch of [
  { imageTag: "latest" }, { manifestSha256: "0".repeat(64) }, { bundleKey: "scene-releases/../x.tar.gz" },
  { releaseId: "../x" }, { token: "must-not-be-in-config" },
]) assert.throws(() => validateSceneWorkerRelease({ ...release, ...patch }));
console.log("Scene infrastructure checks passed: staging isolation, IAM, EFS, secrets and activation gates verified." +
  (process.env.SCENE_BASE_REF ? " Default templates match the supplied baseline." : ""));
