#!/usr/bin/env node
import "source-map-support/register";
import * as cdk from "aws-cdk-lib";
import { RegistryStack } from "../lib/registry-stack";
import { AppStack } from "../lib/app-stack";
import { CicdStack } from "../lib/cicd-stack";

const app = new cdk.App();

// 계정·리전은 배포 환경에서 주입한다(코드에 하드코딩하지 않는다).
const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION ?? "ap-northeast-2",
};

const githubOrg = app.node.tryGetContext("githubOrg") as string;
const githubRepos = app.node.tryGetContext("githubRepos") as string[];
const githubOidcSubjectPrefixes = app.node.tryGetContext(
  "githubOidcSubjectPrefixes",
) as string[];
const publicUrl = (app.node.tryGetContext("publicUrl") as string) ?? "";

function booleanContext(name: string, defaultValue = false): boolean {
  const value = app.node.tryGetContext(name) as unknown;
  if (value === undefined) return defaultValue;
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  throw new Error(`${name} must be true or false`);
}

const refineEnabled = booleanContext("refineEnabled");
const refineFeatureEnabled = booleanContext("refineFeatureEnabled");
if (refineFeatureEnabled && !refineEnabled) {
  throw new Error("refineFeatureEnabled=true requires refineEnabled=true");
}

// 1단계(development)로 인프라 배선을 먼저 검증하고, 준비되면
// `cdk deploy -c appEnv=production` 으로 2단계로 넘어간다.
const appEnv = (app.node.tryGetContext("appEnv") as string) === "production"
  ? ("production" as const)
  : ("development" as const);
const jobExecutionMode = (app.node.tryGetContext("jobExecutionMode") as string) === "sqs"
  ? ("sqs" as const)
  : ("inline" as const);

// 이미지는 앱보다 오래 산다 — 앱 스택을 지웠다 다시 만들어도 롤백 대상이 남아야 한다.
const registry = new RegistryStack(app, "StandinRegistry", { env });

// CI는 앱 스택보다 먼저 있어야 이미지를 밀어 넣을 수 있다.
new CicdStack(app, "StandinCicd", {
  env,
  githubOidcSubjectPrefixes:
    githubOidcSubjectPrefixes ?? githubRepos.map((repo) => `repo:${githubOrg}/${repo}`),
  bffRepo: registry.bffRepo,
  inferenceRepo: registry.inferenceRepo,
});

new AppStack(app, "StandinApp", {
  env,
  bffRepo: registry.bffRepo,
  inferenceRepo: registry.inferenceRepo,
  publicUrl,
  appEnv,
  refineEnabled,
  refineFeatureEnabled,
  jobExecutionMode,
});

cdk.Tags.of(app).add("Project", "Standin");

app.synth();
