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

// 배포 설정은 이제 refine 플래그와 무관하다. 예전에는 refine이 켜지면 0/100 단일 태스크
// 교체로 전환했는데, 조정본이 생성된 로컬 태스크에서 BFF가 곧바로 GET해야 했기 때문이다.
// 추론 서버가 /refine 응답에 BVH 본문을 실어 보내면서 그 두 번째 요청이 사라졌다
// (Standin-server/docs/REFINE_HANDOFF.md §3). 플래그 상태와 무관하게 항상 무중단이어야
// 하므로, 여기서도 상수로 못 박아 회귀를 막는다.
if (inferenceServiceResource.Properties.AvailabilityZoneRebalancing !== "ENABLED") {
  throw new Error(
    "expected inference Availability Zone rebalancing=ENABLED " +
      `(received ${inferenceServiceResource.Properties.AvailabilityZoneRebalancing})`,
  );
}
if (
  deploymentConfiguration.MinimumHealthyPercent !== 100 ||
  deploymentConfiguration.MaximumPercent !== 200
) {
  throw new Error(
    "expected inference deployment=100/200 " +
      `(received ${deploymentConfiguration.MinimumHealthyPercent}/` +
      `${deploymentConfiguration.MaximumPercent})`,
  );
}

console.log(`refine flags verified: inference=${expectedInference}, bff=${expectedBff}`);
