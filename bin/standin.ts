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
const publicUrl = (app.node.tryGetContext("publicUrl") as string) ?? "";

// 이미지는 앱보다 오래 산다 — 앱 스택을 지웠다 다시 만들어도 롤백 대상이 남아야 한다.
const registry = new RegistryStack(app, "StandinRegistry", { env });

// CI는 앱 스택보다 먼저 있어야 이미지를 밀어 넣을 수 있다.
new CicdStack(app, "StandinCicd", {
  env,
  githubOrg,
  githubRepos,
  bffRepo: registry.bffRepo,
  inferenceRepo: registry.inferenceRepo,
});

new AppStack(app, "StandinApp", {
  env,
  bffRepo: registry.bffRepo,
  inferenceRepo: registry.inferenceRepo,
  publicUrl,
});

cdk.Tags.of(app).add("Project", "Standin");

app.synth();
