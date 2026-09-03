import { readFile } from "node:fs/promises";

/**
 * 두 환경의 템플릿이 같은 물리 이름을 만들지 않는지 확인한다.
 *
 * 이 검사가 있는 이유: 시크릿·KMS 별칭·IAM 정책 이름은 계정+리전에서 유일해야 하는데,
 * 충돌은 합성에서 드러나지 않고 **두 번째 배포가 시작된 뒤에** CREATE_FAILED로 나온다.
 * 이미 만들어진 리소스를 롤백하는 도중이라 원인을 읽기도 어렵다. 이름을 새로 고정할
 * 때마다 여기서 먼저 걸리게 한다.
 *
 * usage: node scripts/assert-env-isolation.mjs <templateA.json> <templateB.json>
 */
const [pathA, pathB] = process.argv.slice(2);
if (!pathA || !pathB) {
  throw new Error("usage: node scripts/assert-env-isolation.mjs <templateA> <templateB>");
}

// 이름이 계정+리전 단위로 유일해야 하는 리소스만 본다.
// AWS::ServiceDiscovery::Service는 네임스페이스 안에서만 유일하면 되므로 제외한다
// (두 환경 모두 `inference`를 쓰는 것이 정상이다).
const UNIQUE_NAME_PROPS = {
  "AWS::SecretsManager::Secret": ["Name"],
  "AWS::KMS::Alias": ["AliasName"],
  "AWS::IAM::ManagedPolicy": ["ManagedPolicyName"],
  "AWS::IAM::Role": ["RoleName"],
  "AWS::ECR::Repository": ["RepositoryName"],
  "AWS::SQS::Queue": ["QueueName"],
  "AWS::S3::Bucket": ["BucketName"],
  "AWS::ECS::Cluster": ["ClusterName"],
  "AWS::Lambda::Function": ["FunctionName"],
  "AWS::ServiceDiscovery::PrivateDnsNamespace": ["Name"],
  "AWS::RDS::DBInstance": ["DBInstanceIdentifier"],
  "AWS::ElasticLoadBalancingV2::LoadBalancer": ["Name"],
};

async function fixedNames(path) {
  const template = JSON.parse(await readFile(path, "utf8"));
  const names = new Set();
  for (const resource of Object.values(template.Resources ?? {})) {
    for (const property of UNIQUE_NAME_PROPS[resource.Type] ?? []) {
      const value = resource.Properties?.[property];
      // 토큰(Fn::Join 등)은 스택 이름이 들어가 있어 환경마다 자동으로 갈린다.
      if (typeof value === "string") names.add(`${resource.Type} ${property}=${value}`);
    }
  }
  return names;
}

const [a, b] = await Promise.all([fixedNames(pathA), fixedNames(pathB)]);
const collisions = [...a].filter((name) => b.has(name)).sort();

if (collisions.length > 0) {
  throw new Error(
    `두 환경이 같은 물리 이름을 만든다 — 두 번째 배포가 CREATE_FAILED로 죽는다:\n` +
      collisions.map((name) => `  ${name}`).join("\n"),
  );
}

/**
 * 환경마다 반드시 갈려야 하는 클라이언트 접점.
 *
 * 이름 충돌과 달리 이쪽은 **배포가 성공한 뒤에** 문제가 된다.
 *   PUBLIC_URL             — 이메일 인증 링크가 엉뚱한 환경을 가리킨다.
 *   OAUTH_SUCCESS_REDIRECT — 딥링크 스킴은 앱 설치 시점에 OS에 등록된다. 같으면 어느
 *                            앱이 링크를 받을지 OS가 정하고, staging 로그인의 1회용
 *                            교환 코드가 프로덕션 앱으로 넘어간다.
 *   CORS_ORIGINS           — staging BFF가 프로덕션 가입 페이지를 허용하면 테스터가
 *                            어느 백엔드에 계정을 만들었는지 알 수 없다.
 */
const MUST_DIFFER = ["PUBLIC_URL", "OAUTH_SUCCESS_REDIRECT", "CORS_ORIGINS"];

async function bffEnvironment(path) {
  const template = JSON.parse(await readFile(path, "utf8"));
  const container = Object.values(template.Resources ?? {})
    .filter((resource) => resource.Type === "AWS::ECS::TaskDefinition")
    .flatMap((resource) => resource.Properties.ContainerDefinitions)
    .find((candidate) => candidate.Name === "bff");
  if (!container) throw new Error(`${path}: bff 컨테이너를 찾을 수 없다`);
  return Object.fromEntries(
    (container.Environment ?? []).map((entry) => [entry.Name, entry.Value]),
  );
}

const [envA, envB] = await Promise.all([bffEnvironment(pathA), bffEnvironment(pathB)]);
const shared = MUST_DIFFER.filter(
  (key) => typeof envA[key] === "string" && envA[key] === envB[key],
);

if (shared.length > 0) {
  throw new Error(
    "두 환경의 클라이언트 접점이 같다 — 배포는 성공하지만 로그인·가입이 환경을 넘나든다:\n" +
      shared.map((key) => `  bff:${key}=${envA[key]}`).join("\n"),
  );
}

console.log(
  `env isolation verified: ${a.size} + ${b.size} fixed names, ` +
    `${MUST_DIFFER.length} client-facing env values, no collision ` +
    `(${pathA} vs ${pathB})`,
);
