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

/**
 * 배포 대상 환경. 기본 prod.
 *
 *   prod    — 실서비스. 스택 이름은 `StandinApp`이다.
 *   staging — 테스트 환경. 스택 이름은 `StandinStagingApp`이다.
 *
 * ⚠ **프로덕션 스택 ID(`StandinApp`)를 절대 바꾸지 않는다.** CloudFormation은 스택
 *   이름으로 리소스를 추적하므로, 이름을 "정리"하는 순간 VPC·RDS·ALB가 통째로 새로
 *   만들어진다. staging만 새 이름을 받고 프로덕션은 있던 이름 그대로 둔다.
 *
 * 한 번의 synth는 한 환경만 만든다. refine·job 모드 같은 나머지 스위치는 아래 최상위
 * 컨텍스트를 그대로 쓰므로 `-c` 덮어쓰기가 두 환경에서 똑같이 동작한다.
 *   예) npx cdk deploy StandinStagingApp -c envName=staging -c jobExecutionMode=sqs
 */
const envName = (app.node.tryGetContext("envName") as string) === "staging"
  ? ("staging" as const)
  : ("prod" as const);
const isStaging = envName === "staging";

const githubOrg = app.node.tryGetContext("githubOrg") as string;
const githubRepos = app.node.tryGetContext("githubRepos") as string[];
const githubOidcSubjectPrefixes = app.node.tryGetContext(
  "githubOidcSubjectPrefixes",
) as string[];
const githubDeployEnvironments =
  (app.node.tryGetContext("githubDeployEnvironments") as string[]) ?? ["beta"];

function requiredContext(name: string): string {
  const value = (app.node.tryGetContext(name) as string) ?? "";
  if (!value) {
    throw new Error(
      `${name} is required for envName=${envName}. ` +
        "staging은 자기 도메인과 ACM 인증서가 있어야 배포할 수 있다(README 「테스트 환경」).",
    );
  }
  return value;
}

const publicUrl = isStaging
  ? requiredContext("stagingPublicUrl")
  : ((app.node.tryGetContext("publicUrl") as string) ?? "");
const certificateArn = isStaging
  ? requiredContext("stagingCertificateArn")
  : ((app.node.tryGetContext("certificateArn") as string) ?? "");
if (!publicUrl.startsWith("https://")) {
  throw new Error("publicUrl must be an https:// URL");
}
if (!certificateArn.startsWith("arn:aws:acm:")) {
  throw new Error("certificateArn must be an ACM certificate ARN");
}

function booleanContext(name: string, defaultValue = false): boolean {
  const value = app.node.tryGetContext(name) as unknown;
  if (value === undefined) return defaultValue;
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  throw new Error(`${name} must be true or false`);
}

/**
 * FBX converter. refine과 같은 두 단계 스위치다.
 *
 *   converterEnabled  — converter 서비스를 만든다
 *   fbxExportEnabled  — BFF가 클라이언트에 FBX 저장을 노출한다
 *
 * ⚠ converter의 `/healthz`는 캐릭터 아티팩트(`standin-master-v2.fbx`)를 검사한다.
 *   S3에 없으면 503이고 ECS가 태스크를 교체 루프에 넣는다. 업로드가 먼저다.
 */
const converterEnabled = booleanContext("converterEnabled");
const fbxExportEnabled = booleanContext("fbxExportEnabled");
if (fbxExportEnabled && !converterEnabled) {
  throw new Error("fbxExportEnabled=true requires converterEnabled=true");
}

/**
 * converter 이미지 태그. BFF·추론과 **따로 둔다**.
 *
 * converter는 빌드 파이프라인이 별개다(`converter-deploy.yml`). 지금 그 워크플로는
 * `main`에서만 돌아 `:latest`만 옮기므로 두 환경 모두 `latest`를 본다. converter CI가
 * develop 빌드를 갖게 되면 staging을 `-c stagingConverterImageTag=develop`으로 넘긴다.
 */
const converterImageTag = String(
  app.node.tryGetContext(isStaging ? "stagingConverterImageTag" : "converterImageTag") ??
    "latest",
);

/**
 * Human-Art M 모델 번들 빌드 ID. 비우면 `POSE_MODEL_URI`를 넣지 않는다.
 *
 * ⚠ 값이 있는데 S3에 번들이 없으면 cascade 경로에서 추론이 기동에 실패한다.
 *   업로드 → 이 값 → 배포 순서를 지킨다.
 */
const poseModelBuildId = String(
  app.node.tryGetContext(isStaging ? "stagingPoseModelBuildId" : "poseModelBuildId") ?? "",
);

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

/**
 * CORS 허용 Origin과 OAuth 성공 딥링크. 둘 다 **환경마다 달라야 한다.**
 *
 * CORS: staging BFF가 프로덕션 가입 페이지를 허용하면 테스터가 어느 백엔드에 계정을
 * 만들었는지 알 수 없게 된다.
 *
 * 딥링크: 스킴은 설치 시점에 OS에 등록되므로 런타임에 바꿀 수 없다. 두 환경이 같은
 * 스킴을 쓰면 staging 로그인의 1회용 교환 코드가 프로덕션 앱으로 넘어간다. 즉 **앱
 * 설정에서 서버 주소만 바꾸는 방식은 OAuth 경로에서 반드시 깨진다** — 환경별 빌드가
 * 필요한 진짜 이유다.
 */
const corsOrigins = String(
  app.node.tryGetContext(isStaging ? "stagingCorsOrigins" : "corsOrigins") ?? "",
);
if (!corsOrigins) {
  throw new Error(`${isStaging ? "stagingCorsOrigins" : "corsOrigins"} must not be empty`);
}
const oauthSuccessRedirect = String(
  app.node.tryGetContext(isStaging ? "stagingOauthSuccessRedirect" : "oauthSuccessRedirect") ??
    "",
);
if (!oauthSuccessRedirect.includes("://")) {
  throw new Error("oauthSuccessRedirect must be a deep link URL (scheme://path)");
}

/**
 * staging의 Fargate 태스크를 실제로 띄울지.
 *
 * 기본 false다. 스택(VPC·RDS·ALB·시크릿)은 항상 남겨 두고 태스크만 0개로 둔다 —
 * 유휴 비용이 월 ~$79에서 ~$28(ALB+RDS)로 내려가고, 도메인·인증서·시크릿을 매번 다시
 * 세팅하지 않아도 된다. 테스트할 때만 `-c stagingActive=true`로 다시 배포한다.
 *
 * `aws ecs update-service --desired-count 1`로 임시로 올릴 수도 있지만, 태스크 정의가
 * 바뀌는 다음 `cdk deploy`에서 0으로 되돌아간다. 재현 가능한 쪽은 이 스위치다.
 */
const stagingActive = booleanContext("stagingActive");
const serviceDesiredCount = isStaging ? (stagingActive ? 1 : 0) : 1;

/**
 * 전체 일일 상한. 앱의 QUOTA_GLOBAL_DAILY로 들어간다.
 *
 * staging을 낮게 잡는 이유는 비용이다 — staging도 appEnv=production으로 실제 Gemini를
 * 호출하므로, 상한이 프로덕션과 같으면 테스트가 그달 예산을 두 배로 태울 수 있다.
 */
const quotaGlobalDaily = String(
  app.node.tryGetContext(isStaging ? "stagingQuotaGlobalDaily" : "quotaGlobalDaily") ??
    (isStaging ? "50" : "400"),
);

/**
 * 태스크 정의가 참조할 ECR 이미지 태그.
 *
 * 저장소는 두 환경이 공유하지만 **움직이는 태그는 나눠야 한다.** 배포 자체는 GitHub
 * Actions가 커밋 SHA로 고정하지만, `cdk deploy`가 서비스를 건드리면 CloudFormation이
 * 이 태그를 쓰는 리비전으로 되돌린다. 두 환경이 같은 태그를 보면 그 되돌림이 엉뚱한
 * 환경의 이미지를 끌어온다.
 *
 *   main 빌드    → :sha + :latest    → 프로덕션이 :latest를 본다
 *   develop 빌드 → :sha + :develop   → staging이 :develop을 본다
 */
const imageTag = String(
  app.node.tryGetContext(isStaging ? "stagingImageTag" : "imageTag") ??
    (isStaging ? "develop" : "latest"),
);
if (!imageTag) {
  throw new Error("imageTag must not be empty");
}

/**
 * 로그 출하 경로(계획 5단계).
 *   cloudwatch — 기본. ECS awslogs 드라이버로 CloudWatch Logs에 남긴다.
 *   firelens   — fluent-bit 사이드카로 외부 수집기(Loki/Grafana Cloud)에 보낸다.
 *
 * 기본을 바꾸지 않는 이유는 계획 문서 §8에 있다. 3단계 자체 대시보드로 원인을 못 찾아
 * CloudWatch 콘솔을 여는 일이 월 3회를 넘을 때 전환한다. 그 전에 세우면 유지비만 나간다.
 */
const logShipping = (app.node.tryGetContext("logShipping") as string) === "firelens"
  ? ("firelens" as const)
  : ("cloudwatch" as const);

/**
 * 컨테이너 로그 보존일.
 *
 * ⚠ 기본 14일은 클로즈베타 데이터 수집 문서의 "운영 로그" 정책과 맞물려 있다.
 *   계획 문서는 3일로 줄이자고 제안하지만 팀 확인 전까지 기본값을 바꾸지 않는다.
 *   줄이려면 `-c logRetentionDays=3`.
 */
const logRetentionDays = Number(app.node.tryGetContext("logRetentionDays") ?? 14);
if (!Number.isInteger(logRetentionDays) || logRetentionDays <= 0) {
  throw new Error("logRetentionDays must be a positive integer");
}

// 이미지는 앱보다 오래 산다 — 앱 스택을 지웠다 다시 만들어도 롤백 대상이 남아야 한다.
//
// 저장소는 두 환경이 **공유한다**. staging에서 검증한 그 이미지 SHA를 그대로 프로덕션에
// 올려야 검증이 의미가 있다 — 환경마다 저장소를 나누면 "staging에서 통과한 이미지"와
// "프로덕션에 올라간 이미지"가 다른 빌드가 될 수 있다.
const registry = new RegistryStack(app, "StandinRegistry", { env });

// CI는 앱 스택보다 먼저 있어야 이미지를 밀어 넣을 수 있다.
// OIDC 역할도 두 환경이 공유한다 — 신뢰 범위는 저장소 + GitHub environment로 제한된다.
new CicdStack(app, "StandinCicd", {
  env,
  githubOidcSubjectPrefixes:
    githubOidcSubjectPrefixes ?? githubRepos.map((repo) => `repo:${githubOrg}/${repo}`),
  githubDeployEnvironments,
  appStackPrefixes: ["StandinApp", "StandinStagingApp"],
  bffRepo: registry.bffRepo,
  inferenceRepo: registry.inferenceRepo,
  converterRepo: registry.converterRepo,
});

const appStack = new AppStack(app, isStaging ? "StandinStagingApp" : "StandinApp", {
  env,
  envName,
  bffRepo: registry.bffRepo,
  inferenceRepo: registry.inferenceRepo,
  converterRepo: registry.converterRepo,
  publicUrl,
  certificateArn,
  corsOrigins,
  oauthSuccessRedirect,
  appEnv,
  refineEnabled,
  refineFeatureEnabled,
  jobExecutionMode,
  serviceDesiredCount,
  quotaGlobalDaily,
  poseModelBuildId,
  converterEnabled,
  fbxExportEnabled,
  converterImageTag,
  imageTag,
  logShipping,
  logRetentionDays,
});

cdk.Tags.of(app).add("Project", "Standin");
// 환경 태그는 앱 스택에만 붙인다. Registry·Cicd는 두 환경이 공유하므로 어느 한쪽으로
// 태그되면 비용 배분이 거짓말을 한다.
cdk.Tags.of(appStack).add("Environment", envName);

app.synth();
