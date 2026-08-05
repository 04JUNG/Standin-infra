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
console.log(`refine flags verified: inference=${expectedInference}, bff=${expectedBff}`);
