import { readFile } from "node:fs/promises";

const [expectedInference, expectedBff] = process.argv.slice(2);
if (!["0", "1"].includes(expectedInference) || !["false", "true"].includes(expectedBff)) {
  throw new Error("usage: node scripts/assert-refine-flags.mjs <0|1> <false|true>");
}

const template = JSON.parse(
  await readFile(new URL("../cdk.out/StandinApp.template.json", import.meta.url), "utf8"),
);

const environments = Object.values(template.Resources)
  .filter((resource) => resource.Type === "AWS::ECS::TaskDefinition")
  .flatMap((resource) => resource.Properties.ContainerDefinitions)
  .flatMap((container) =>
    (container.Environment ?? []).map((entry) => ({
      container: container.Name,
      name: entry.Name,
      value: entry.Value,
    })),
  );

function requireValue(container, name, expected) {
  const entry = environments.find((candidate) =>
    candidate.container === container && candidate.name === name
  );
  if (!entry) throw new Error(`missing ${container}:${name}`);
  if (entry.value !== expected) {
    throw new Error(`expected ${container}:${name}=${expected}, received ${entry.value}`);
  }
}

requireValue("inference", "REFINE_ENABLED", expectedInference);
requireValue("bff", "REFINE_FEATURE_ENABLED", expectedBff);

const inferenceService = Object.entries(template.Resources).find(
  ([logicalId, resource]) =>
    logicalId.startsWith("InferenceService") && resource.Type === "AWS::ECS::Service",
);
if (!inferenceService) throw new Error("missing inference ECS service");

const [, inferenceServiceResource] = inferenceService;
const deploymentConfiguration = inferenceServiceResource.Properties.DeploymentConfiguration;
if (inferenceServiceResource.Properties.AvailabilityZoneRebalancing !== "DISABLED") {
  throw new Error("inference ECS service must disable Availability Zone rebalancing");
}
if (
  deploymentConfiguration.MinimumHealthyPercent !== 0 ||
  deploymentConfiguration.MaximumPercent !== 100
) {
  throw new Error("inference ECS service must use minimumHealthyPercent=0 and maximumPercent=100");
}

console.log(`refine flags verified: inference=${expectedInference}, bff=${expectedBff}`);
