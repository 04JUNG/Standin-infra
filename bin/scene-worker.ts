#!/usr/bin/env node
import "source-map-support/register";
import { App } from "aws-cdk-lib";
import { readFileSync } from "node:fs";
import { SceneWorkerStack, validateStagingSceneContext } from "../lib/scene-worker-stack";
import { validateSceneWorkerRelease } from "../lib/scene-worker-config";

// Separate app entry point intentionally does not instantiate the existing AppStack.
const app = new App();
const read = (name: string) => {
  const file = app.node.tryGetContext(name);
  if (typeof file !== "string" || !file) throw new Error(`${name} operator file is required`);
  return JSON.parse(readFileSync(file, "utf8"));
};
const context = validateStagingSceneContext(read("stagingSceneContext"));
const active = app.node.tryGetContext("stagingSceneWorkerActive") ?? false;
if (![true, false, "true", "false"].includes(active)) throw new Error("invalid staging worker activation");
new SceneWorkerStack(app, "StandinStagingSceneWorker", {
  env: { account: context.account, region: context.region }, context,
  release: validateSceneWorkerRelease(read("stagingSceneWorkerConfig")),
  active: active === true || active === "true",
});
