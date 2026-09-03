import { CfnOutput, Duration, RemovalPolicy, SecretValue, Stack, type StackProps } from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import type * as ecr from "aws-cdk-lib/aws-ecr";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as iam from "aws-cdk-lib/aws-iam";
import * as kms from "aws-cdk-lib/aws-kms";
import * as rds from "aws-cdk-lib/aws-rds";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as servicediscovery from "aws-cdk-lib/aws-servicediscovery";
import * as sqs from "aws-cdk-lib/aws-sqs";
import type { Construct } from "constructs";

export interface AppStackProps extends StackProps {
  /**
   * 배포 대상 환경. 물리 이름(시크릿·KMS 별칭·IAM 정책·Cloud Map)의 유일성을 만든다.
   *
   * `appEnv`와 다른 축이다 — staging도 `appEnv: "production"`으로 돌려야 실모델·실
   * 라이브러리 경로를 검증할 수 있고, 그러면 appEnv만으로는 두 환경을 구분할 수 없다.
   */
  envName: "prod" | "staging";
  bffRepo: ecr.Repository;
  inferenceRepo: ecr.Repository;
  converterRepo: ecr.Repository;
  /** BFF의 공개 HTTPS 기준 URL(OAuth 콜백·이메일 인증 링크). */
  publicUrl: string;
  /**
   * CORS 허용 Origin 목록(콤마 구분).
   *
   * 환경마다 다르다 — staging BFF가 프로덕션 가입 페이지를 허용하면, 테스터가 어느
   * 백엔드에 계정을 만들었는지 알 수 없게 된다.
   */
  corsOrigins: string;
  /**
   * OAuth 성공 후 데스크톱 앱으로 되돌아가는 딥링크.
   *
   * ⚠ 스킴은 **설치 시점에 OS에 등록**된다. 두 환경이 같은 스킴을 쓰면 어느 앱이 링크를
   *   받을지 OS가 정하고(Windows는 마지막 등록이 이긴다), staging 로그인의 교환 코드가
   *   프로덕션 앱으로 넘어간다. 그래서 환경마다 스킴을 다르게 둔다.
   */
  oauthSuccessRedirect: string;
  /** ALB HTTPS 리스너에 연결할, 같은 리전의 발급 완료된 ACM 인증서 ARN. */
  certificateArn: string;
  /**
   * 배포 단계 스위치.
   *   development — 합성 라이브러리·mock 백엔드로 인프라 배선만 검증(1단계)
   *   production  — 실 라이브러리·실모델. 둘 중 하나라도 없으면 태스크가 기동하지 않는다(2단계)
   * `cdk deploy -c appEnv=production` 으로 전환한다. 코드 수정이 필요 없다.
   */
  appEnv: "development" | "production";
  /** 추론 서버에서 실제 BVH 조정 연산을 허용한다. 기본값은 false다. */
  refineEnabled: boolean;
  /** BFF가 클라이언트에 refine 기능을 노출한다. 추론 flag가 켜진 뒤에만 활성화한다. */
  refineFeatureEnabled: boolean;
  /** 기본 inline. 앱·queue 검증 뒤 sqs로 전환하면 worker desiredCount도 1이 된다. */
  jobExecutionMode: "inline" | "sqs";
  /**
   * 서비스별 태스크 수. 프로덕션은 1, staging은 기본 0이다.
   *
   * staging 스택을 지우지 않고 태스크만 0으로 두면 유휴 비용이 ALB+RDS만 남는다.
   * 도메인·인증서·시크릿을 매번 다시 세팅하지 않아도 되는 것이 destroy 대비 이점이다.
   */
  serviceDesiredCount: number;
  /** 앱의 QUOTA_GLOBAL_DAILY. staging은 Gemini 비용 때문에 낮게 잡는다. */
  quotaGlobalDaily: string;
  /**
   * Human-Art M 모델 번들의 빌드 ID. 비우면 `POSE_MODEL_URI`를 넣지 않는다.
   *
   * 추론이 기동 시 `s3://<assets>/pose-models/humanart-m/<buildId>/manifest.json`을 받아
   * sha256으로 검증하고 로컬에 원자 공개한다(Standin-server #49). 매니페스트를 가리키고
   * model.onnx·detector.onnx는 형제 경로로 찾는다.
   *
   * ⚠ 값이 있는데 S3에 번들이 없으면 `POSE_MODEL_VARIANT=cascade`에서 **기동이 실패한다.**
   *   업로드가 이 값보다 먼저다.
   */
  poseModelBuildId: string;
  /**
   * converter 서비스를 만들지.
   *
   * 두 단계로 나눈 이유는 refine과 같다 — 서비스를 띄워 헬스체크가 통과하는지 먼저 보고,
   * 그 다음에 `fbxExportEnabled`로 사용자에게 연다.
   *
   * ⚠ converter의 `/healthz`는 캐릭터 아티팩트를 검사한다(`default_character`).
   *   `standin-master-v2.fbx`가 S3에 없으면 503을 돌려주고 ECS가 태스크를 교체 루프에
   *   넣는다. **아티팩트 업로드가 이 스위치보다 먼저다.**
   */
  converterEnabled: boolean;
  /**
   * BFF가 클라이언트에 FBX 저장을 노출한다. `converterEnabled=true`일 때만 허용한다.
   *
   * 앱은 `CONVERTER_BASE_URL`과 `FBX_EXPORT_ENABLED=true`가 **둘 다** 있어야
   * `capabilities.fbxExport`를 true로 준다(Standin-app-server/docs/API.md).
   * false면 저장 포맷 선택에서 FBX가 사라지고 BVH로만 저장된다.
   */
  fbxExportEnabled: boolean;
  /**
   * converter 태스크 정의가 참조할 ECR 태그.
   *
   * BFF·추론과 **따로 둔다**. converter는 빌드 파이프라인이 별개라(`converter-deploy.yml`)
   * 움직이는 태그가 다른 시점에 다른 규칙으로 움직인다. 같은 `imageTag`를 물리면
   * 한쪽 파이프라인의 사정이 다른 쪽 배포를 흔든다.
   */
  converterImageTag: string;
  /**
   * 태스크 정의가 참조할 ECR 이미지 태그. 환경마다 **달라야 한다**.
   *
   * 배포는 GitHub Actions가 커밋 SHA로 고정한 리비전으로 하지만, `cdk deploy`가
   * 서비스를 건드리면 CloudFormation이 이 태그를 쓰는 리비전으로 되돌린다. 두 환경이
   * 같은 움직이는 태그를 보면 그 되돌림이 **엉뚱한 환경의 이미지를 끌어온다** —
   * staging에 프로덕션 이미지가 올라가거나, 그 반대가 된다.
   *
   * main 빌드가 `latest`를, develop 빌드가 `develop`을 옮긴다(앱 저장소 deploy.yml).
   */
  imageTag: string;
  /**
   * 로그 출하 경로(계획 5단계). 기본 cloudwatch.
   * firelens로 바꾸면 fluent-bit 사이드카가 외부 수집기로 보내고 CloudWatch에는 남지 않는다.
   */
  logShipping: "cloudwatch" | "firelens";
  /** 컨테이너 로그 보존일. 기본 14일(클로즈베타 데이터 정책과 맞물려 있다). */
  logRetentionDays: number;
}

/**
 * 네트워크 · DB · 서비스를 한 스택에 둔다.
 *
 * 원래 셋으로 나눴다가 합쳤다. 보안그룹이 세 영역에 걸쳐 서로를 참조해서
 * (ALB → BFF → 추론/DB) 스택을 나누면 순환 의존이 계속 생긴다. CDK가 리스너·타깃을
 * 붙일 때 보안그룹 규칙을 자동으로 추가하기 때문에 참조 방향을 통제하기도 어렵다.
 * 이 규모에서는 한 스택이 더 단순하고 안전하다.
 *
 * ECR과 CI/CD는 수명주기가 달라 따로 둔다 — 이미지는 앱 스택을 지워도 남아야 하고,
 * OIDC 역할은 앱보다 먼저 있어야 CI가 이미지를 밀어 넣을 수 있다.
 *
 * NAT Gateway를 두지 않는다(월 ~$32). 태스크는 퍼블릭 서브넷 + 퍼블릭 IP로 외부에
 * 나가고, 인바운드는 보안그룹으로 막는다. RDS는 isolated 서브넷이라 인터넷에서 닿지 않는다.
 *
 * 공개 경계는 BFF 하나뿐이다. 추론 서버는 **무인증**이라(docs/API_CONTRACT) ALB에 붙이지
 * 않고 Cloud Map 내부 DNS로만 노출한다.
 *
 * 나중에 포즈 백엔드를 GPU로 올리면 추론 서비스만 EC2 캐패시티 프로바이더로 옮긴다 —
 * 클러스터·ALB는 그대로 두고 태스크 정의에 GPU 리소스를 추가하면 된다
 * (Fargate는 GPU를 지원하지 않는다).
 */
export class AppStack extends Stack {
  constructor(scope: Construct, id: string, props: AppStackProps) {
    super(scope, id, props);

    const isProd = props.appEnv === "production";
    const isPrimary = props.envName === "prod";

    /**
     * 시크릿 이름. 프로덕션은 **이미 배포된 이름 그대로** 두고 staging에만 경로를 하나 판다.
     *
     * ⚠ 이름을 바꾸면 CloudFormation이 시크릿을 교체한다 — JWT 서명 키가 새로 생겨
     *   모든 세션이 끊기고, 콘솔에서 채워 둔 OAuth·SMTP·Discord 값이 빈 껍데기로 돌아간다.
     *   그래서 접두사는 새로 만드는 환경에만 붙인다.
     */
    const secretName = (suffix: string) =>
      isPrimary ? `standin/${suffix}` : `standin/${props.envName}/${suffix}`;

    /**
     * 이미 `appEnv`를 이름에 넣어 배포된 리소스들의 환경 구분자.
     *
     * staging도 `appEnv=production`으로 돌기 때문에 appEnv만으로는 두 환경이 같은 이름을
     * 만든다. 프로덕션은 배포된 값(`production`)을 유지하고 staging만 `staging`을 쓴다.
     */
    const envSegment = isPrimary ? props.appEnv : props.envName;

    /**
     * staging 데이터는 버려도 되는 것이다 — 스택을 지우면 같이 지운다.
     *
     * 프로덕션에서 RETAIN을 유지하는 이유는 사고 복구지만, staging에 그대로 두면
     * 지운 스택이 KMS 별칭과 버킷을 남겨 다음 재생성이 이름 충돌로 실패한다.
     */
    const dataRemovalPolicy = isPrimary ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;

    // ── 네트워크 ─────────────────────────────────────────────────
    const vpc = new ec2.Vpc(this, "Vpc", {
      maxAzs: 2, // RDS 서브넷 그룹이 최소 2개 AZ를 요구한다
      natGateways: 0,
      subnetConfiguration: [
        { name: "public", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: "isolated", subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    });

    const bffSg = new ec2.SecurityGroup(this, "BffSg", {
      vpc: vpc,
      description: "Standin BFF tasks",   // ALB에서만 인바운드
    });

    const inferenceSg = new ec2.SecurityGroup(this, "InferenceSg", {
      vpc: vpc,
      description: "Standin inference tasks (unauthenticated - never expose publicly)",
    });
    const workerSg = new ec2.SecurityGroup(this, "WorkerSg", {
      vpc,
      description: "Standin analysis queue workers",
    });

    const converterSg = new ec2.SecurityGroup(this, "ConverterSg", {
      vpc,
      description: "Standin FBX converter (unauthenticated - never expose publicly)",
    });

    const dbSg = new ec2.SecurityGroup(this, "DbSg", {
      vpc: vpc,
      description: "Standin BFF PostgreSQL",
      allowAllOutbound: false,
    });

    // 유일하게 허용하는 내부 경로 두 개.
    inferenceSg.addIngressRule(bffSg, ec2.Port.tcp(8000), "BFF to inference");
    inferenceSg.addIngressRule(workerSg, ec2.Port.tcp(8000), "Worker to inference");
    // converter도 추론과 같은 취급이다 — 무인증이므로 ALB에 붙이지 않고 내부에서만 연다.
    // 쓰는 쪽은 BFF뿐이다(워커는 FBX를 만들지 않는다).
    converterSg.addIngressRule(bffSg, ec2.Port.tcp(8001), "BFF to converter");
    dbSg.addIngressRule(bffSg, ec2.Port.tcp(5432), "BFF to PostgreSQL");
    dbSg.addIngressRule(workerSg, ec2.Port.tcp(5432), "Worker to PostgreSQL");
  
    // ── 데이터베이스 ──────────────────────────────────────────────
    const database = new rds.DatabaseInstance(this, "Postgres", {
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_16,
      }),
      // 소규모 시작. 부하가 붙으면 인스턴스 클래스만 올린다.
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MICRO),
      vpc: vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [dbSg],
      databaseName: "standin",
      credentials: rds.Credentials.fromGeneratedSecret("standin", {
        secretName: secretName("db"),
      }),
      allocatedStorage: 20,
      maxAllocatedStorage: 100, // 오토스케일 상한
      multiAz: false, // 초기엔 단일 AZ. 가용성이 필요해지면 켠다(비용 2배)
      publiclyAccessible: false,
      // staging 데이터는 언제든 다시 만들 수 있다 — 백업 보관에 돈을 쓰지 않는다.
      backupRetention: Duration.days(isPrimary ? 7 : 1),
      deleteAutomatedBackups: !isPrimary,
      // ⚠ 초기 단계 설정이다. 실사용자가 생기면 RETAIN + deletionProtection으로 바꿀 것.
      //   staging은 스냅샷도 남기지 않는다(지운 뒤 다시 만들 때 스냅샷 요금만 쌓인다).
      removalPolicy: isPrimary ? RemovalPolicy.SNAPSHOT : RemovalPolicy.DESTROY,
      deletionProtection: false,
      storageEncrypted: true,
      enablePerformanceInsights: false, // t4g.micro는 미지원
    });

    
  
    // ── 서비스 ───────────────────────────────────────────────────
    // Cloud Map 네임스페이스 이름은 계정+리전에서 유일해야 한다(VPC가 달라도 겹치면
    // CreateNamespace가 실패한다). 환경마다 다른 이름을 쓰고, 내부 주소는 이 값에서
    // 만들어 쓴다 — 두 군데 하드코딩해 두면 반드시 한쪽만 고쳐진다.
    const namespaceName = isPrimary ? "standin.local" : `standin-${props.envName}.local`;
    const inferenceBaseUrl = `http://inference.${namespaceName}:8000`;
    const converterBaseUrl = `http://converter.${namespaceName}:8001`;

    const cluster = new ecs.Cluster(this, "Cluster", {
      vpc: vpc,
      containerInsightsV2: ecs.ContainerInsights.ENABLED,
      defaultCloudMapNamespace: {
        name: namespaceName,
        type: servicediscovery.NamespaceType.DNS_PRIVATE,
      },
    });

    // ── 자산 버킷 ────────────────────────────────────────────────
    // 포즈 라이브러리 번들(재배포 금지 자료라 이미지에 굽지 않는다).
    const assets = new s3.Bucket(this, "AssetsBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true, // 라이브러리 롤백용
    });

    // ── 시크릿 ───────────────────────────────────────────────────
    // JWT 서명 키는 CDK가 생성한다(사람이 값을 보지 않는다).
    // Closed-beta input images are isolated from the versioned pose-library bucket.
    // Versioning and Object Lock stay disabled so consent withdrawal can delete data.
    //
    // refine이 만든 조정본 BVH도 이 버킷에 들어간다(OPS-01). 사용자 입력에서 파생된
    // private artifact라 공개 포즈 라이브러리 버킷(assets)에 두지 않는다. 저장 경로는
    // `installations/{id}/jobs/{jobId}/refined/...`라서 아래 KMS 암호화, 90일 lifecycle,
    // 동의 철회 시 installations/ prefix 삭제 스윕이 **추가 설정 없이 그대로 적용된다**.
    // 쓰는 쪽은 BFF뿐이므로 inference task role에는 S3 쓰기 권한을 주지 않는다.
    const betaDataKey = new kms.Key(this, "BetaDataKey", {
      alias: `alias/standin-${envSegment}-beta-data`,
      enableKeyRotation: true,
      removalPolicy: dataRemovalPolicy,
    });
    const betaData = new s3.Bucket(this, "BetaDataBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: betaDataKey,
      enforceSSL: true,
      versioned: false,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      lifecycleRules: [{ id: "ExpireBetaInputs", expiration: Duration.days(90) }],
      removalPolicy: dataRemovalPolicy,
      autoDeleteObjects: !isPrimary,
    });

    const jwtSecret = new secretsmanager.Secret(this, "JwtSecret", {
      secretName: secretName("jwt"),
      description: "BFF JWT 서명 키",
      generateSecretString: { passwordLength: 48, excludePunctuation: true },
    });

    // 소셜 로그인 키는 콘솔에서 발급받아 채워야 한다 → 빈 껍데기만 만든다.
    // 소셜 로그인 키는 콘솔에서 발급받아 채운다. 여기서는 **키 이름만** 만들어 둔다.
    //
    // ⚠ ECS는 태스크를 띄울 때 시크릿의 JSON 키를 해석한다. 없는 키를 참조하면
    //   컨테이너가 시작조차 못 한다(ResourceInitializationError). 그래서 값이 없더라도
    //   키는 반드시 존재해야 한다. 앱은 빈 키를 PROVIDER_UNAVAILABLE로 처리하므로
    //   빈 문자열로 두어도 기동에는 문제가 없다.
    const oauthSecret = new secretsmanager.Secret(this, "OAuthSecret", {
      secretName: secretName("oauth"),
      description: "Social login client credentials. Fill values in the console after deploy.",
      secretObjectValue: {
        googleClientId: SecretValue.unsafePlainText(""),
        googleClientSecret: SecretValue.unsafePlainText(""),
        kakaoClientId: SecretValue.unsafePlainText(""),
        kakaoClientSecret: SecretValue.unsafePlainText(""),
        naverClientId: SecretValue.unsafePlainText(""),
        naverClientSecret: SecretValue.unsafePlainText(""),
      },
    });

    // VLM API 키. 같은 이유로 키 이름을 미리 만들어 둔다.
    // 2단계(production)에서 값을 채우지 않으면 추론이 조용히 mock으로 폴백하는데,
    // 추론 서버의 런타임 가드가 그걸 잡아 기동을 막는다.
    const vlmSecret = new secretsmanager.Secret(this, "VlmSecret", {
      secretName: secretName("vlm"),
      description: "VLM provider API keys. Fill values in the console before switching to production.",
      secretObjectValue: {
        geminiApiKey: SecretValue.unsafePlainText(""),
        openaiApiKey: SecretValue.unsafePlainText(""),
      },
    });
    const betaReviewSecret = new secretsmanager.Secret(this, "BetaReviewSecret", {
      secretName: `standin/${envSegment}/beta-review-token`,
      description: "Shared token for the restricted closed-beta quality review API",
      generateSecretString: { passwordLength: 48, excludePunctuation: true },
    });

    // 사용량 제한이 client IP를 셀 때 쓰는 솔트. BFF는 IP 원문을 저장하지 않고
    // sha256(salt + IP)만 카운터 키로 쓴다.
    //
    // 없으면 앱이 JWT_SECRET으로 폴백하는데, 그러면 솔트 교체가 JWT 교체와 묶인다.
    // ⚠ 이 값을 바꾸면 모든 IP 버킷 키가 바뀌어 진행 중인 카운터가 리셋된다
    //   (창이 최대 1시간이라 실무 영향은 작다).
    const ipHashSalt = new secretsmanager.Secret(this, "IpHashSalt", {
      secretName: `standin/${envSegment}/ip-hash-salt`,
      description: "Salt for hashing client IPs into rate-limit buckets",
      generateSecretString: { passwordLength: 48, excludePunctuation: true },
    });

    // 이메일 인증용 SMTP 설정. 공급자(Gmail·SES SMTP 등)는 배포 후 콘솔에서 채운다.
    // ECS가 JSON 키를 시작 시 해석하므로 값이 비어 있어도 모든 키를 미리 만든다.
    const smtpSecret = new secretsmanager.Secret(this, "SmtpSecret", {
      secretName: secretName("smtp"),
      description: "SMTP credentials used by the BFF for email verification.",
      secretObjectValue: {
        host: SecretValue.unsafePlainText(""),
        port: SecretValue.unsafePlainText("587"),
        user: SecretValue.unsafePlainText(""),
        pass: SecretValue.unsafePlainText(""),
        from: SecretValue.unsafePlainText("Standin <no-reply@standin.local>"),
      },
    });

    /**
     * 장애 알림용 디스코드 웹훅. 설계: 마스터독스 「관측성 — 로그·모니터링·디스코드 알림」.
     *
     * ⚠ 웹훅 URL 자체가 비밀이다 — URL을 아는 누구나 그 채널에 글을 쓸 수 있다.
     *   그래서 환경변수가 아니라 시크릿으로 주입한다.
     *
     * ⚠ 값이 비어도 키는 반드시 만들어 둔다. ECS는 태스크를 띄울 때 시크릿의 JSON 키를
     *   해석하는데, 없는 키를 참조하면 컨테이너가 시작조차 못 한다(OAuth 시크릿과 같은 이유).
     *   값이 비면 두 서버의 알림기가 조용히 no-op으로 동작하므로 기동에는 문제가 없다.
     */
    const discordSecret = new secretsmanager.Secret(this, "DiscordSecret", {
      secretName: secretName("discord"),
      description: "Discord webhooks for P1/P2/P3 alerts. Fill values in the console after deploy.",
      secretObjectValue: {
        webhookAlert: SecretValue.unsafePlainText(""), // P1 — 사람을 깨운다
        webhookWarn: SecretValue.unsafePlainText(""), // P2 — 업무시간에 본다
        webhookOps: SecretValue.unsafePlainText(""), // P3 — 기동·배포·요약 기록
      },
    });

    /**
     * P1 알림에 붙일 멘션. 비밀이 아니므로 환경변수로 둔다.
     *
     * 기본값이 `@here`인 이유: 팀이 P1을 "사람을 깨우는 등급"으로 정했다(2026-08-18).
     * 야간 호출을 끄려면 `DISCORD_ALERT_MENTION="" npx cdk deploy StandinApp`.
     * P1을 남발하지 않는 것이 이 기본값을 지탱하는 전제다 — 등급을 올릴 때마다
     * 그 알림이 새벽 3시에 울려도 되는지 먼저 따진다.
     */
    const discordAlertMention = process.env.DISCORD_ALERT_MENTION ?? "@here";

    // ── 로그 출하(계획 5단계) ─────────────────────────────────────
    //
    // 기본은 CloudWatch다. 계획 문서 §8의 전환 기준은 "3단계 자체 대시보드로 원인을 못 찾아
    // CloudWatch 콘솔을 여는 일이 월 3회를 넘을 때"다. 그 전에 수집 인프라를 세우면
    // 유지비만 나간다. 여기서는 그날이 왔을 때 **코드를 새로 쓰지 않고 스위치만 넘기도록**
    // 배선만 해 둔다.
    //
    // ⚠ firelens 경로는 실제 수집기(Grafana Cloud/Loki)에 붙여 검증한 적이 없다.
    //   처음 켤 때는 반드시 development에서 먼저 확인한다.
    const ALLOWED_RETENTION_DAYS = [1, 3, 5, 7, 14, 30, 60, 90, 180, 365];
    if (!ALLOWED_RETENTION_DAYS.includes(props.logRetentionDays)) {
      // CloudWatch는 아무 숫자나 받지 않는다. 배포 중에 실패하지 말고 합성에서 막는다.
      throw new Error(
        `logRetentionDays must be one of ${ALLOWED_RETENTION_DAYS.join(", ")} (got ${props.logRetentionDays})`,
      );
    }
    const logRetention = props.logRetentionDays as logs.RetentionDays;

    // 수집기 접속 정보. firelens를 켤 때만 만든다 — 안 쓰는 시크릿에 매달 요금을 내지 않는다.
    const logShippingSecret =
      props.logShipping === "firelens"
        ? new secretsmanager.Secret(this, "LogShippingSecret", {
            secretName: secretName("log-shipping"),
            description: "External log collector credentials (Loki/Grafana Cloud)",
            secretObjectValue: {
              host: SecretValue.unsafePlainText(""), // 예: logs-prod-013.grafana.net
              user: SecretValue.unsafePlainText(""), // 테넌트 ID
              password: SecretValue.unsafePlainText(""), // API 키
            },
          })
        : undefined;

    /**
     * 컨테이너 로그 드라이버를 만든다. 태스크마다 부른다(사이드카는 태스크 단위라서다).
     *
     * firelens 모드에서는 fluent-bit 사이드카가 로그를 받아 외부로 보낸다. 사이드카 자신의
     * 로그는 CloudWatch에 짧게 남긴다 — 출하가 깨졌을 때 그 사실을 알 수 있는 유일한 경로다.
     */
    const containerLogging = (
      taskDefinition: ecs.FargateTaskDefinition,
      streamPrefix: string,
    ): ecs.LogDriver => {
      if (props.logShipping === "cloudwatch" || !logShippingSecret) {
        return ecs.LogDrivers.awsLogs({ streamPrefix, logRetention });
      }

      taskDefinition.addFirelensLogRouter("log-router", {
        image: ecs.ContainerImage.fromRegistry(
          "public.ecr.aws/aws-observability/aws-for-fluent-bit:stable",
        ),
        firelensConfig: { type: ecs.FirelensLogRouterType.FLUENTBIT },
        logging: ecs.LogDrivers.awsLogs({
          streamPrefix: "log-router",
          logRetention: logs.RetentionDays.THREE_DAYS,
        }),
        memoryReservationMiB: 50,
        // fluent-bit의 forward 입력 포트. 태스크 안에서만 쓰이지만 선언하지 않으면
        // CDK가 "포트 없는 컨테이너"로 보고 합성을 막는다.
        portMappings: [{ containerPort: 24224 }],
      });

      return ecs.LogDrivers.firelens({
        options: {
          Name: "loki",
          // 값은 배포 후 콘솔에서 시크릿에 채운다. 호스트는 비밀이 아니지만 계정마다
          // 다르므로 같은 시크릿에 모아 둔다(두 곳에 두면 반드시 어긋난다).
          port: "443",
          tls: "on",
          // 라벨은 여기서 고정한다. 로그 본문의 필드를 라벨로 올리면 카디널리티가 터진다
          // (requestId를 라벨로 만들면 인덱스가 요청 수만큼 늘어난다).
          labels: `job=standin,service=${streamPrefix}`,
          line_format: "json",
        },
        secretOptions: {
          host: ecs.Secret.fromSecretsManager(logShippingSecret, "host"),
          http_user: ecs.Secret.fromSecretsManager(logShippingSecret, "user"),
          http_passwd: ecs.Secret.fromSecretsManager(logShippingSecret, "password"),
        },
      });
    };

    // ── 추론 서비스(내부 전용) ────────────────────────────────────
    const inferenceTask = new ecs.FargateTaskDefinition(this, "InferenceTask", {
      cpu: 1024,
      memoryLimitMiB: 2048,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.X86_64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });

    // 드라이버를 붙잡아 둔다. 추론 운영자에게 넘길 로그 그룹이 이 안에 있다 —
    // 이름을 문자열로 적으면 스택을 다시 만들 때 조용히 어긋난다.
    const inferenceLogging = containerLogging(inferenceTask, "inference");

    inferenceTask.addContainer("inference", {
      image: ecs.ContainerImage.fromEcrRepository(props.inferenceRepo, props.imageTag),
      logging: inferenceLogging,
      environment: {
        APP_ENV: props.appEnv,
        // 1단계는 mock으로 인프라 배선만 확인하고, 2단계에서 실모델로 넘어간다.
        // production에서 mock이면 추론 서버가 기동을 거부한다(조용한 폴백도 잡는다).
        VLM_PROVIDER: isProd ? "gemini" : "mock",
        // 기본 모델 변경이나 지원 종료에 영향받지 않도록 배포 모델을 명시한다.
        //
        // ⚠ 2026-08-29 장애: `gemini-flash-latest`는 **롤링 별칭**이라 배포 없이도
        //   가리키는 모델이 바뀐다. 그 모델이 무너지자 프로덕션 분석이 통째로 죽었다
        //   (기동 후 gemini_request 27건 = 분석 9건 x 3시도가 전부 503, 성공 0건,
        //   17:22~21:56 KST 4시간 반). 유료 키로 바꾼 뒤에도 같았다 — 키 문제가 아니다.
        //
        //   같은 키·같은 순간에 모델만 바꿔 재보니(Standin-server의 scripts/vlm_probe.py):
        //     gemini-flash-latest      0/6  504 x5 + timeout x1, 전부 ~29초
        //     gemini-3.5-flash         3/3  p50 4.1초
        //     gemini-flash-lite-latest 3/3  p50 1.6초
        //   교체 후 프로덕션 /analyze가 75.6초 503 → 8.97초 200으로 돌아왔다.
        //
        // ⚠ 2.5 계열(gemini-2.5-flash, gemini-2.5-flash-lite)은 이 프로젝트 키에서
        //   404다("no longer available to new users"). models.list에는 보이지만
        //   generateContent에서 거부된다. 404는 추론 서버가 "우리 잘못"으로 분류해
        //   폴백도 못 타고 500 + P2 알림이 된다.
        //   **모델을 바꿀 때는 반드시 실제 키로 먼저 확인할 것** — 별칭 금지, 실측 필수.
        GEMINI_MODEL: "gemini-3.5-flash",
        // ⚠ 2026-08-19 장애: 20000(20초)이 짧아 프로덕션 분석이 전부 이 데드라인에
        //   잘렸다(관측된 Gemini 호출 3건 전부 실패, 성공 0건, 실패 중 2건이 20.0s·20.3s).
        //   이 값이 생기기 전에는 상한이 없어 느린 호출도 결국 끝났다 — 즉 이 값이
        //   "느리지만 되던 것"을 "무조건 실패"로 바꿨다.
        //   timeout에는 HTTP 상태가 없어 재시도 대상이 아니므로(비용 중복 방지)
        //   데드라인 자체를 넉넉히 잡는 것으로 푼다.
        GEMINI_REQUEST_TIMEOUT_MS: "45000",
        // 429/503만 이 횟수 안에서 재시도한다. timeout은 해당하지 않는다.
        GEMINI_MAX_ATTEMPTS: "3",
        // VLM 단계 전체(재시도 포함) 예산(초). 이게 없으면 timeout을 45초로 올린 순간
        // 재시도 3회가 135초가 되어 BFF의 분석 상한(120초)을 넘고, 사용자는 원인을
        // 알 수 없는 ANALYSIS_TIMEOUT을 받는다.
        GEMINI_TOTAL_BUDGET_SECONDS: "75",
        GEMINI_RETRY_BASE_SECONDS: "0.5",
        GEMINI_RETRY_MAX_SECONDS: "2.0",
        POSE_BACKEND: isProd ? "rtmlib" : "mock",
        DATA_DIR: "/app/data",
        DB_PATH: "/app/data/poses.db",
        INDEX_PATH: "/app/data/index.pkl",
        // 1단계에서는 비운다 → 합성 라이브러리로 기동한다.
        // 2단계에서는 번들을 받아 푼다. 번들이 없으면 기동에 실패한다(의도).
        POSE_LIBRARY_URI: isProd ? `s3://${assets.bucketName}/pose-library/v1.tar.gz` : "",
        /**
         * Human-Art M 모델 번들. 앱 배포 워크플로가 아니라 **여기가 소유자**다
         * (Standin-server #49 리뷰에서 정리). 버킷 이름이 환경마다 다른 인프라 설정이고,
         * workflow가 주입하면 `cdk deploy`의 되돌림에 값이 사라져 cascade가 기동에 실패한다.
         *
         * 앱 배포 워크플로는 이 값의 존재만 확인하고 덮어쓰지 않는다.
         */
        ...(props.poseModelBuildId
          ? {
              POSE_MODEL_URI: `s3://${assets.bucketName}/pose-models/humanart-m/${props.poseModelBuildId}/manifest.json`,
              POSE_MODELS_ROOT: "/app/data/pose-models",
            }
          : {}),
        POSE_LIBRARY_VERSION: "v1",
        DISCORD_ALERT_MENTION: discordAlertMention,
        // refine 게이트는 코드 기본값에 맡기지 않고 배포에서 명시한다.
        // 추론의 기본값은 REFINE_ENABLED=1이라, 적어 두지 않으면 조정본 영속화가
        // 검증되기도 전에 켜진 채로 뜬다.
        REFINE_ENABLED: props.refineEnabled ? "1" : "0",
        REFINE_MOVE_GATE: "0", // P2 이동량 하드 게이트 보류(진단은 계속 기록)
        REFINE_COLLISION_GATE: "1", // P3a 손·전완-몸통 관통 복구
      },
      secrets: {
        GEMINI_API_KEY: ecs.Secret.fromSecretsManager(vlmSecret, "geminiApiKey"),
        OPENAI_API_KEY: ecs.Secret.fromSecretsManager(vlmSecret, "openaiApiKey"),
        DISCORD_WEBHOOK_ALERT: ecs.Secret.fromSecretsManager(discordSecret, "webhookAlert"),
        DISCORD_WEBHOOK_WARN: ecs.Secret.fromSecretsManager(discordSecret, "webhookWarn"),
        DISCORD_WEBHOOK_OPS: ecs.Secret.fromSecretsManager(discordSecret, "webhookOps"),
      },
      portMappings: [{ containerPort: 8000 }],
      healthCheck: {
        // 라이브러리가 비면 앱이 503을 준다 → 태스크 교체.
        command: [
          "CMD-SHELL",
          "python -c \"import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/healthz').status==200 else 1)\"",
        ],
        interval: Duration.seconds(30),
        timeout: Duration.seconds(5),
        retries: 3,
        /**
         * 기동 유예. 받아야 할 것이 많다.
         *   포즈 라이브러리 번들   19 MB (S3)
         *   rtmlib 가중치          527 MB (openmmlab, yolox_x 351 + rtmpose 176)
         *   Human-Art M 번들       450 MB (S3, poseModelBuildId가 있을 때)
         *
         * 추론의 모델 다운로드 예산이 기본 300초인데(`POSE_MODEL_DOWNLOAD_BUDGET_SECONDS`)
         * 그 예산은 current-X 초기화 시간을 포함하지 않는다. 유예가 예산보다 짧으면
         * **정상 기동 중인 태스크를 ECS가 먼저 죽여 교체 루프에 빠진다.**
         * 그래서 예산과 같은 300초로 맞춘다(ECS 상한).
         */
        startPeriod: Duration.seconds(300),
      },
    });

    // 번들을 받으려면 읽기 권한이 필요하다(태스크 역할 → 키를 환경에 두지 않는다).
    assets.grantRead(inferenceTask.taskRole);

    // awslogs 드라이버는 컨테이너에 바인딩된 **뒤에야** 로그 그룹을 노출한다.
    // firelens 모드에서는 로그가 CloudWatch에 남지 않으므로 그룹도 없다(undefined).
    const inferenceLogGroup =
      inferenceLogging instanceof ecs.AwsLogDriver ? inferenceLogging.logGroup : undefined;

    const inferenceService = new ecs.FargateService(this, "InferenceService", {
      cluster,
      taskDefinition: inferenceTask,
      desiredCount: props.serviceDesiredCount,
      securityGroups: [inferenceSg],
      // NAT가 없으므로 퍼블릭 서브넷 + 퍼블릭 IP로 외부(VLM API·S3)에 나간다.
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      assignPublicIp: true,
      cloudMapOptions: {
        name: "inference", // → inference.<namespace> (INFERENCE_BASE_URL와 같은 이름)
        dnsRecordType: servicediscovery.DnsRecordType.A,
        dnsTtl: Duration.seconds(10),
      },
      circuitBreaker: { rollback: true }, // 배포가 실패하면 자동 롤백
      /**
       * refine 여부와 무관하게 100/200 무중단 롤링을 쓴다.
       *
       * 예전에는 refine이 켜지면 0/100 단일 태스크 교체로 전환했다. 조정본이 생성된
       * 로컬 태스크에서 BFF가 곧바로 GET해야 했고, 구·신 태스크가 함께 Cloud Map에
       * 등록되면 그 GET이 조정본을 갖지 않은 쪽에 닿아 404가 났기 때문이다. 대가가
       * 컸다 — 배포 중 추론이 완전히 멈추고, minHealthyPercent=0은 배포 실패를 그대로
       * 장애로 만든다.
       *
       * 이제 추론 서버가 /refine 응답에 BVH 본문을 실어 보내므로 두 번째 요청 자체가
       * 없다(REFINE_HANDOFF §3). 로컬 디스크에 의존하는 경로가 사라져 태스크 공존이
       * 무해해졌다.
       *
       * ⚠ 이 변경은 Standin-server 1단계와 Standin-app-server 2단계가 **모두 배포된
       *   뒤에만** 안전하다. 구 BFF가 아직 두 번 요청하는 상태에서 무중단 배포로
       *   되돌리면 조정본 404가 난다.
       */
      availabilityZoneRebalancing: ecs.AvailabilityZoneRebalancing.ENABLED,
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
    });

    // ── 추론 운영자 권한 ─────────────────────────────────────────
    // 사람 자격증명은 이 스택에서 만들지 않는다. IAM Identity Center의 팀 그룹(권장),
    // 기존 역할 또는 사용자에 아래 관리형 정책을 연결한다.
    //
    // Fargate 컨테이너의 로컬 파일은 태스크 교체 시 사라지므로 서버에 직접 파일을
    // 복사하지 않는다. 운영자는 버전 관리되는 S3 경로에 번들을 올리고, 지정된 추론
    // 서비스만 새 태스크로 교체한다. 태스크는 자신의 읽기 전용 역할로 번들을 받는다.
    const inferenceOperatorPolicy = new iam.ManagedPolicy(this, "InferenceOperatorPolicy", {
      managedPolicyName: isPrimary
        ? "standin-inference-operator"
        : `standin-${props.envName}-inference-operator`,
      // ⚠ Description은 바꾸지 않는다. AWS::IAM::ManagedPolicy에서 이 속성은
      //   **교체를 강제한다**(requires replacement). 정책 이름이 고정돼 있어
      //   CloudFormation이 새것을 먼저 만들다 이름 충돌로 실패하고, 설령 교체에
      //   성공해도 ARN이 바뀌어 이 정책을 붙여 둔 권한 세트·역할의 연결이 끊긴다.
      //
      //   허용 범위가 pose-library에서 pose-models까지 넓어졌지만, 그 사실은
      //   아래 PolicyDocument와 주석이 말한다. 문구를 맞추자고 교체를 감수하지 않는다.
      description: "Upload Standin pose libraries and restart only the inference ECS service",
      statements: [
        /**
         * 운영자가 올릴 수 있는 프리픽스.
         *
         *   pose-library/ — 포즈 라이브러리 번들(poses.db · bvh · thumbs)
         *   pose-models/  — 추론 모델 번들(Human-Art M 등 manifest + ONNX)
         *
         * 버킷 전체를 열지 않는다. 같은 버킷에 `characters/`(converter 캐릭터)와
         * 앱이 읽는 다른 자산이 함께 있고, 이 역할은 사람에게 붙는다.
         */
        new iam.PolicyStatement({
          sid: "ListUploadablePrefixes",
          actions: ["s3:ListBucket", "s3:ListBucketVersions"],
          resources: [assets.bucketArn],
          conditions: {
            StringLike: {
              "s3:prefix": [
                "pose-library",
                "pose-library/*",
                "pose-models",
                "pose-models/*",
              ],
            },
          },
        }),
        new iam.PolicyStatement({
          sid: "UploadAndVerifyPoseAssets",
          actions: [
            "s3:PutObject",
            "s3:GetObject",
            "s3:GetObjectVersion",
            "s3:AbortMultipartUpload",
          ],
          resources: [
            assets.arnForObjects("pose-library/*"),
            assets.arnForObjects("pose-models/*"),
          ],
        }),
        new iam.PolicyStatement({
          sid: "RestartInferenceService",
          actions: ["ecs:DescribeServices", "ecs:UpdateService"],
          resources: [inferenceService.serviceArn],
        }),
        // 배포가 안정화에 실패했을 때 이유를 보려면 로그가 필요하다. 안정화 실패는
        // "새 번들이 로드되지 않았다"는 사실만 알려 주고 원인은 컨테이너 로그에만 있다.
        // 추론 컨테이너 그룹 하나만 열어 준다 — BFF 로그에는 사용자 데이터가 흐른다.
        ...(inferenceLogGroup
          ? [
              new iam.PolicyStatement({
                sid: "ReadInferenceLogs",
                actions: [
                  "logs:DescribeLogStreams",
                  "logs:GetLogEvents",
                  "logs:FilterLogEvents",
                  "logs:StartLiveTail",
                  "logs:StartQuery",
                ],
                resources: [
                  // 같은 그룹의 두 표기. 이벤트 API는 `:*`가 붙은 ARN을,
                  // Live Tail은 붙지 않은 ARN을 권한 검사에 쓴다.
                  inferenceLogGroup.logGroupArn,
                  `arn:aws:logs:${this.region}:${this.account}:log-group:${inferenceLogGroup.logGroupName}`,
                ],
              }),
              new iam.PolicyStatement({
                // 아래 액션들은 IAM이 리소스 단위를 지원하지 않는다. 질의를 **시작**하는
                // StartQuery가 위에서 추론 그룹으로 묶여 있으므로, 결과를 받아 오는
                // 이 액션들이 넓어도 다른 그룹의 내용에는 닿지 못한다.
                sid: "ReadOwnLogQueryResults",
                actions: ["logs:GetQueryResults", "logs:DescribeQueries", "logs:StopQuery"],
                resources: ["*"],
              }),
              new iam.PolicyStatement({
                // 콘솔의 로그 그룹 목록이 이 호출로 그려진다. 이름만 보이고 내용은 보이지 않는다.
                sid: "ListLogGroupNames",
                actions: ["logs:DescribeLogGroups"],
                resources: [`arn:aws:logs:${this.region}:${this.account}:log-group:*`],
              }),
            ]
          : []),
      ],
    });

    // ── 분석 Job queue ────────────────────────────────────────────
    const analysisDlq = new sqs.Queue(this, "AnalysisDlq", {
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      retentionPeriod: Duration.days(14),
    });
    const analysisQueue = new sqs.Queue(this, "AnalysisQueue", {
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      visibilityTimeout: Duration.seconds(180),
      retentionPeriod: Duration.days(4),
      receiveMessageWaitTime: Duration.seconds(20),
      deadLetterQueue: { queue: analysisDlq, maxReceiveCount: 3 },
    });

    // ── BFF 서비스(공개 엣지) ─────────────────────────────────────
    // 사용량 쿼터 env. **BFF와 워커가 같은 값을 봐야 한다** — 소비는 BFF(Job 생성),
    // 환불은 워커(분석 실패)에서 일어나므로 값이 갈리면 소비한 창과 다른 창을 되돌린다.
    //
    // 값이 코드 기본값과 같아도 여기 적어 두는 이유는 **운영 중 조정**이다 —
    // env가 없으면 쿼터를 바꾸려고 앱을 고쳐 재배포해야 한다. 0 이하는 "제한 없음"이다.
    const quotaEnv: Record<string, string> = {
      // 설치별 한도는 **주 단위**다. 하루 10회는 "작업하는 날에 몰아 쓴다"는 실제 사용
      // 방식을 막았다 — 같은 총량이라도 창이 넓으면 그 리듬을 막지 않는다.
      // KST 월요일 자정에 리셋된다(앱 `weeklyWindow`).
      QUOTA_INSTALLATION_WEEKLY: "100",
      // 쿼터를 적용하지 않을 설치 ID(콤마 구분). 개발자 단말을 여기 넣는다 — 자기 한도에
      // 막힌 개발자는 정작 한도를 확인해야 할 때 확인하지 못한다. 설치 ID는 앱 설정
      // 화면에 표시된다. 비워 두면 아무도 예외가 아니다.
      // ⚠ 면제되는 것은 주간 한도·전체 상한·동시 분석뿐이다. IP burst는 인증 이전
      //   단계라 그대로 적용된다(RATE_IP_ANALYZE).
      QUOTA_EXEMPT_INSTALLATIONS: "",
      // 전체 일일 상한. 오픈베타_계획_2026-08-13 §4-2의 산식에서 나온 값이다:
      // (월 10만원 − AWS 고정비 5만) ÷ 건당 4원 ≈ 12,500회/월 ≈ 일 416회 → 400.
      // ⚠ 입력값 둘(AWS 고정비 실측·Gemini 건당 단가)이 아직 측정 전이라 잠정치다.
      //   단가가 4원을 크게 넘으면 이 값이 아니라 QUOTA_INSTALLATION_WEEKLY를 먼저 낮춘다.
      QUOTA_GLOBAL_DAILY: props.quotaGlobalDaily,
    };

    const bffTask = new ecs.FargateTaskDefinition(this, "BffTask", {
      cpu: 512,
      memoryLimitMiB: 1024,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.ARM64, // Graviton — 같은 성능에 더 싸다
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });

    betaData.grantReadWrite(bffTask.taskRole);

    bffTask.addContainer("bff", {
      image: ecs.ContainerImage.fromEcrRepository(props.bffRepo, props.imageTag),
      logging: containerLogging(bffTask, "bff"),
      environment: {
        PORT: "8080",
        NODE_ENV: "production",
        PUBLIC_URL: props.publicUrl,
        // Vercel 가입 페이지가 register/resend-verification API를 직접 호출한다.
        CORS_ORIGINS: props.corsOrigins,
        // OAuth 완료 후 브라우저에서 데스크톱 앱으로 1회용 교환 코드를 전달한다.
        OAUTH_SUCCESS_REDIRECT: props.oauthSuccessRedirect,
        INFERENCE_BASE_URL: inferenceBaseUrl,
        BETA_DATA_BUCKET: betaData.bucketName,
        JOB_EXECUTION_MODE: props.jobExecutionMode,
        ANALYSIS_QUEUE_URL: analysisQueue.queueUrl,
        WORKER_VISIBILITY_SECONDS: "180",
        WORKER_LEASE_SECONDS: "180",
        /**
         * refine 노출 스위치. 추론의 REFINE_ENABLED와 **별도**다(OPS-02).
         *
         * 추론 endpoint가 살아 있어도 이 값이 false면 BFF가 클라이언트에 refine을
         * 노출하지 않는다. 조정본 영속화와 저장 전 미리보기를 staging에서 확인한 뒤
         * 추론 → BFF 순으로 켠다.
         */
        REFINE_FEATURE_ENABLED: props.refineFeatureEnabled ? "true" : "false",
        REFINE_TIMEOUT_MS: "5000",
        /**
         * FBX 저장 노출 스위치. converter 서비스 존재와 **별도**다.
         *
         * 앱은 `CONVERTER_BASE_URL`과 `FBX_EXPORT_ENABLED=true`가 둘 다 있어야
         * `capabilities.fbxExport`를 true로 준다. converter를 띄워 헬스체크를 확인한
         * 뒤에 이 값을 켠다 — refine과 같은 순서다.
         */
        FBX_EXPORT_ENABLED: props.fbxExportEnabled ? "true" : "false",
        ...(props.converterEnabled
          ? {
              CONVERTER_BASE_URL: converterBaseUrl,
              /**
               * BFF가 converter 응답을 기다리는 상한. 앱 기본값은 35초인데 그게
               * staging에서 정상 변환을 잘랐다(504, `CONVERTER_TIMEOUT`).
               *
               * converter는 동시 실행이 1개라(`CONVERTER_MAX_CONCURRENT_PROCESSES`)
               * 대기 시간이 변환 시간에 더해진다. BFF는 **인물마다 한 번씩** 부르므로
               * 2인 컷이면 두 번째 호출이 첫 변환 뒤에 줄을 선다. 실제로 그 요청이
               * 35초에 잘렸는데 converter는 그 뒤 변환을 끝까지 마쳤다 — 버려진 일이다.
               *
               * converter 자신의 상한(60초)보다 넉넉해야 대기까지 흡수한다.
               */
              CONVERTER_TIMEOUT_MS: "90000",
            }
          : {}),
        BETA_CONSENT_VERSION: "2026-08-02",
        DISCORD_ALERT_MENTION: discordAlertMention,
        // 분석/포즈 기능은 계정 JWT 대신 동의된 installation 인증을 요구한다.
        // users API는 BFF에서 계속 계정 인증을 요구한다.
        ALLOW_ANONYMOUS_ANALYSIS: "false",
        DATABASE_SSL: "true", // RDS는 TLS 필수
        // DATABASE_URL 대신 표준 PG* 변수를 쓴다 — RDS가 만든 시크릿을 그대로 주입할 수 있어
        // 접속 문자열을 따로 만들어 보관하지 않아도 된다. (README의 앱 변경 사항 참고)
        PGDATABASE: "standin",

        // ── 사용량 제한(오픈베타) ──────────────────────────────────
        // 값은 앱의 코드 기본값과 같다. 여기 적어 두는 이유는 **운영 중 조정**이다 —
        // env가 없으면 쿼터를 낮추려고 앱 코드를 고쳐 재배포해야 한다.
        // 0 이하는 앱에서 "제한 없음"으로 읽는다.
        //
        // ALB는 자신을 XFF에 넣지 않고 client IP를 오른쪽 끝에 append한다. 따라서
        // 오른쪽에서 건너뛸 주소는 0개다. 클라가 앞쪽 XFF를 위조해도 오른쪽 끝은
        // ALB가 관측한 주소라 바뀌지 않는다. 프록시 없는 로컬은 -1로 XFF를 끈다.
        TRUSTED_PROXY_HOPS: "0",
        ...quotaEnv,
        QUOTA_INSTALLATION_CONCURRENT: "1",
        ANALYSIS_STALE_AFTER_SECONDS: "300",
        RATE_IP_REGISTER: "5",
        RATE_IP_REGISTER_WINDOW: "3600",
        RATE_IP_ANALYZE: "5",
        RATE_IP_ANALYZE_WINDOW: "60",
      },
      secrets: {
        JWT_SECRET: ecs.Secret.fromSecretsManager(jwtSecret),
        BETA_REVIEW_ADMIN_TOKEN: ecs.Secret.fromSecretsManager(betaReviewSecret),
        IP_HASH_SALT: ecs.Secret.fromSecretsManager(ipHashSalt),
        PGHOST: ecs.Secret.fromSecretsManager(database.secret!, "host"),
        PGPORT: ecs.Secret.fromSecretsManager(database.secret!, "port"),
        PGUSER: ecs.Secret.fromSecretsManager(database.secret!, "username"),
        PGPASSWORD: ecs.Secret.fromSecretsManager(database.secret!, "password"),
        GOOGLE_CLIENT_ID: ecs.Secret.fromSecretsManager(oauthSecret, "googleClientId"),
        GOOGLE_CLIENT_SECRET: ecs.Secret.fromSecretsManager(oauthSecret, "googleClientSecret"),
        KAKAO_CLIENT_ID: ecs.Secret.fromSecretsManager(oauthSecret, "kakaoClientId"),
        KAKAO_CLIENT_SECRET: ecs.Secret.fromSecretsManager(oauthSecret, "kakaoClientSecret"),
        NAVER_CLIENT_ID: ecs.Secret.fromSecretsManager(oauthSecret, "naverClientId"),
        NAVER_CLIENT_SECRET: ecs.Secret.fromSecretsManager(oauthSecret, "naverClientSecret"),
        SMTP_HOST: ecs.Secret.fromSecretsManager(smtpSecret, "host"),
        SMTP_PORT: ecs.Secret.fromSecretsManager(smtpSecret, "port"),
        SMTP_USER: ecs.Secret.fromSecretsManager(smtpSecret, "user"),
        SMTP_PASS: ecs.Secret.fromSecretsManager(smtpSecret, "pass"),
        SMTP_FROM: ecs.Secret.fromSecretsManager(smtpSecret, "from"),
        DISCORD_WEBHOOK_ALERT: ecs.Secret.fromSecretsManager(discordSecret, "webhookAlert"),
        DISCORD_WEBHOOK_WARN: ecs.Secret.fromSecretsManager(discordSecret, "webhookWarn"),
        DISCORD_WEBHOOK_OPS: ecs.Secret.fromSecretsManager(discordSecret, "webhookOps"),
      },
      portMappings: [{ containerPort: 8080 }],
    });
    analysisQueue.grantSendMessages(bffTask.taskRole);

    const bffService = new ecs.FargateService(this, "BffService", {
      cluster,
      taskDefinition: bffTask,
      desiredCount: props.serviceDesiredCount,
      securityGroups: [bffSg],
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      assignPublicIp: true,
      circuitBreaker: { rollback: true },
      minHealthyPercent: 100,
      // 배포 시 진행 중 요청을 마칠 시간(BFF의 SIGTERM 처리와 맞물린다).
      // Job은 아직 프로세스 내에서 도므로 이 시간이 유실 창을 줄여 준다.
      healthCheckGracePeriod: Duration.seconds(60),
    });

    // HTTP 수신과 분리된 영속 Job worker. inline 단계에서는 서비스만 만들고 0개로 둔다.
    const workerTask = new ecs.FargateTaskDefinition(this, "AnalysisWorkerTask", {
      cpu: 512,
      memoryLimitMiB: 1024,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.ARM64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });
    workerTask.addContainer("analysis-worker", {
      image: ecs.ContainerImage.fromEcrRepository(props.bffRepo, props.imageTag),
      command: ["node", "dist/worker.js"],
      stopTimeout: Duration.seconds(120),
      logging: containerLogging(workerTask, "analysis-worker"),
      environment: {
        NODE_ENV: "production",
        INFERENCE_BASE_URL: inferenceBaseUrl,
        BETA_DATA_BUCKET: betaData.bucketName,
        ANALYSIS_QUEUE_URL: analysisQueue.queueUrl,
        WORKER_VISIBILITY_SECONDS: "180",
        WORKER_LEASE_SECONDS: "180",
        ANALYSIS_TIMEOUT_MS: "120000",
        DATABASE_SSL: "true",
        PGDATABASE: "standin",
        DISCORD_ALERT_MENTION: discordAlertMention,
        // 실패한 분석의 쿼터 환불이 여기서 일어난다(상류 혼잡·입력 저장 실패).
        // BFF와 같은 값이어야 소비한 창을 그대로 되돌린다.
        ...quotaEnv,
      },
      secrets: {
        PGHOST: ecs.Secret.fromSecretsManager(database.secret!, "host"),
        PGPORT: ecs.Secret.fromSecretsManager(database.secret!, "port"),
        PGUSER: ecs.Secret.fromSecretsManager(database.secret!, "username"),
        PGPASSWORD: ecs.Secret.fromSecretsManager(database.secret!, "password"),
        // 분석이 실제로 도는 곳이라 실패 알림이 가장 필요하다.
        DISCORD_WEBHOOK_ALERT: ecs.Secret.fromSecretsManager(discordSecret, "webhookAlert"),
        DISCORD_WEBHOOK_WARN: ecs.Secret.fromSecretsManager(discordSecret, "webhookWarn"),
        DISCORD_WEBHOOK_OPS: ecs.Secret.fromSecretsManager(discordSecret, "webhookOps"),
      },
    });
    betaData.grantRead(workerTask.taskRole);
    analysisQueue.grantConsumeMessages(workerTask.taskRole);

    const workerService = new ecs.FargateService(this, "AnalysisWorkerService", {
      cluster,
      taskDefinition: workerTask,
      desiredCount: props.jobExecutionMode === "sqs" ? props.serviceDesiredCount : 0,
      securityGroups: [workerSg],
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      assignPublicIp: true,
      circuitBreaker: { rollback: true },
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
    });

    // ── FBX converter(선택) ──────────────────────────────────────
    //
    // Blender 5.2를 번들한 amd64 이미지다(추론과 다른 아키텍처라 저장소도 따로 둔다).
    // 실측: Blender 기동만 344 MiB, BVH 파싱+리타깃+FBX export 전체가 372 MiB, 3.4초.
    // 요청마다 Blender를 subprocess로 새로 띄우고 동시 실행은 1개다
    // (`CONVERTER_MAX_CONCURRENT_PROCESSES`, uvicorn `--workers 1`) — vCPU를 늘려도
    // 처리량이 늘지 않으므로 1 vCPU / 2 GB로 잡는다. 2 GB는 실측 대비 5배 헤드룸이다.
    const converterService = props.converterEnabled
      ? (() => {
          const converterTask = new ecs.FargateTaskDefinition(this, "ConverterTask", {
            cpu: 1024,
            memoryLimitMiB: 2048,
            runtimePlatform: {
              // ⚠ Dockerfile.converter가 amd64를 강제한다(Blender 배포판이 x64뿐이다).
              cpuArchitecture: ecs.CpuArchitecture.X86_64,
              operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
            },
          });

          converterTask.addContainer("converter", {
            image: ecs.ContainerImage.fromEcrRepository(
              props.converterRepo,
              props.converterImageTag,
            ),
            logging: containerLogging(converterTask, "converter"),
            environment: {
              APP_ENV: props.appEnv,
              // 캐릭터 아티팩트. converter가 S3에서 받아 레지스트리의 sha256과 대조한다
              // (Standin-server #44). 파일이 바뀌면 ArtifactIntegrityError로 거부하므로
              // 조용한 교체가 일어나지 않는다.
              //
              // 이름은 레지스트리의 `artifact_uri_env`와 정확히 같아야 한다
              // (config/characters.example.json). 캐릭터를 추가하면 여기도 한 줄 는다.
              STANDIN_MASTER_V2_URI: `s3://${assets.bucketName}/characters/standin-master-v2.fbx`,
              STANDIN_FEMALE_V2_LBS_URI: `s3://${assets.bucketName}/characters/standin-female-v2-lbs.fbx`,
              // `CONVERTER_CHARACTER_REGISTRY`는 일부러 두지 않는다 — 이미지 기본값이
              // 레지스트리 경로를 안다. 여기서 경로를 굳히면 이미지가 그 파일을 옮길 때
              // 인프라가 먼저 깨진다.
              CONVERTER_JSON_LOGS: "1",
              CONVERTER_LOG_LEVEL: "INFO",
              /**
               * 변환 하나의 상한.
               *
               * 처음 30초로 잡은 근거는 합성 캐릭터(64 KB) 실측 3.4초였는데, 실제
               * `standin-master-v2`(1.72 MB)로는 **한 건에 18~35초**가 걸린다. 30초는
               * 정상 변환을 자르는 값이다. staging 실측(2026-09-03)에 맞춰 올린다.
               */
              CONVERTER_TIMEOUT_SECONDS: "60",
              CONVERTER_TERMINATE_GRACE_SECONDS: "2",
              // 1을 유지한다. 올리면 Blender 프로세스가 동시에 떠 메모리가 배로 든다.
              CONVERTER_MAX_CONCURRENT_PROCESSES: "1",
              // V3.2.4로 되돌리는 킬 스위치. 평시에는 꺼 둔다.
              CONVERTER_FORCE_EXACT_V324: "false",
              // 입력 BVH 상한(2 MiB). Blender에 넘기기 전에 거른다.
              CONVERTER_MAX_BVH_BYTES: "2097152",
              DISCORD_ALERT_MENTION: discordAlertMention,
            },
            secrets: {
              DISCORD_WEBHOOK_ALERT: ecs.Secret.fromSecretsManager(discordSecret, "webhookAlert"),
              DISCORD_WEBHOOK_WARN: ecs.Secret.fromSecretsManager(discordSecret, "webhookWarn"),
              DISCORD_WEBHOOK_OPS: ecs.Secret.fromSecretsManager(discordSecret, "webhookOps"),
            },
            portMappings: [{ containerPort: 8001 }],
            healthCheck: {
              // ⚠ 이 헬스체크는 캐릭터 아티팩트가 있어야 통과한다. `/healthz`의
              //   `default_character`가 ArtifactUnavailableError면 503이다.
              command: [
                "CMD-SHELL",
                "python -c \"import json,urllib.request,sys; r=urllib.request.urlopen('http://127.0.0.1:8001/healthz',timeout=10); p=json.load(r); sys.exit(0 if r.status==200 and p.get('ok') is True else 1)\"",
              ],
              interval: Duration.seconds(30),
              timeout: Duration.seconds(15),
              retries: 3,
              // 이미지가 1.6GB고 캐릭터를 받아 검증한다. 추론(90초)보다 길게 잡는다.
              startPeriod: Duration.seconds(120),
            },
          });

          // 캐릭터 아티팩트를 받으려면 읽기 권한이 필요하다(키를 환경에 두지 않는다).
          assets.grantRead(converterTask.taskRole);

          return new ecs.FargateService(this, "ConverterService", {
            cluster,
            taskDefinition: converterTask,
            desiredCount: props.serviceDesiredCount,
            securityGroups: [converterSg],
            // NAT가 없으므로 퍼블릭 서브넷 + 퍼블릭 IP로 S3에 나간다.
            vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
            assignPublicIp: true,
            cloudMapOptions: {
              name: "converter", // → converter.<namespace> (CONVERTER_BASE_URL와 같은 이름)
              dnsRecordType: servicediscovery.DnsRecordType.A,
              dnsTtl: Duration.seconds(10),
            },
            circuitBreaker: { rollback: true },
            availabilityZoneRebalancing: ecs.AvailabilityZoneRebalancing.ENABLED,
            minHealthyPercent: 100,
            maxHealthyPercent: 200,
          });
        })()
      : undefined;

    new cloudwatch.Alarm(this, "AnalysisQueueAgeAlarm", {
      metric: analysisQueue.metricApproximateAgeOfOldestMessage({ period: Duration.minutes(1) }),
      threshold: 120,
      evaluationPeriods: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
    });
    new cloudwatch.Alarm(this, "AnalysisDlqAlarm", {
      metric: analysisDlq.metricApproximateNumberOfMessagesVisible({ period: Duration.minutes(1) }),
      threshold: 0,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
    });

    const alb = new elbv2.ApplicationLoadBalancer(this, "Alb", {
      vpc: vpc,
      internetFacing: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
    });

    const httpsListener = alb.addListener("Https", {
      port: 443,
      open: true,
      protocol: elbv2.ApplicationProtocol.HTTPS,
      certificates: [elbv2.ListenerCertificate.fromArn(props.certificateArn)],
      sslPolicy: elbv2.SslPolicy.RECOMMENDED_TLS,
    });

    httpsListener.addTargets("BffTarget", {
      port: 8080,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [bffService],
      healthCheck: {
        path: "/healthz",
        interval: Duration.seconds(30),
        timeout: Duration.seconds(5),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
      },
      deregistrationDelay: Duration.seconds(30),
    });

    alb.addListener("Http", {
      port: 80,
      open: true,
      defaultAction: elbv2.ListenerAction.redirect({
        protocol: "HTTPS",
        port: "443",
        permanent: true,
      }),
    });

    // ── 인프라 이벤트 알림(계획 4단계) ────────────────────────────
    //
    // 앱 안의 알림기가 **원리적으로 보고할 수 없는** 사건들을 여기서 잡는다.
    //   · 태스크가 아예 뜨지 못함 — 알림기가 실행되지도 않는다.
    //   · OOM/강제 종료 — 죽는 순간 알림 버퍼도 함께 사라진다.
    //   · 배포 서킷브레이커 롤백 — 옛 태스크가 계속 돌아 서비스는 "정상"으로 보인다.
    //
    // CloudWatch 알람이 아니라 EventBridge 이벤트 버스를 쓴다. 임계값을 정할 필요가 없고
    // 사건이 일어난 그 순간 한 건이 오며, 비용도 사실상 0이다.
    const infraAlerts = new lambda.Function(this, "InfraAlerts", {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: "index.handler",
      code: lambda.Code.fromAsset("lambda/infra-alerts"),
      // 웹훅 한 번 호출이 전부다. 길게 잡아 둘 이유가 없다.
      timeout: Duration.seconds(10),
      memorySize: 128,
      logRetention: logs.RetentionDays.ONE_WEEK,
      environment: {
        DISCORD_SECRET_ARN: discordSecret.secretArn,
        DISCORD_ALERT_MENTION: discordAlertMention,
      },
      description: "ECS·RDS 이벤트를 디스코드로 알린다(앱이 보고할 수 없는 사건)",
    });
    // 값을 환경변수로 굽지 않는다 — 실행 시점에 읽어야 웹훅을 교체해도 재배포가 필요 없다.
    discordSecret.grantRead(infraAlerts);

    // 태스크 종료. 정상 종료(배포·스케일 인)까지 오는 것은 Lambda가 걸러 낸다 —
    // 이벤트 패턴만으로는 exitCode·stopCode 조합을 판단할 수 없다.
    new events.Rule(this, "TaskStoppedRule", {
      description: "Standin 태스크가 멈추면 알린다",
      eventPattern: {
        source: ["aws.ecs"],
        detailType: ["ECS Task State Change"],
        detail: {
          clusterArn: [cluster.clusterArn],
          lastStatus: ["STOPPED"],
        },
      },
      targets: [new targets.LambdaFunction(infraAlerts)],
    });

    // 배포 결과. 롤백은 "새 코드가 반영되지 않았다"는 뜻이라 가장 값어치 있는 알림이다.
    new events.Rule(this, "DeploymentStateRule", {
      description: "Standin 서비스 배포 실패·완료를 알린다",
      eventPattern: {
        source: ["aws.ecs"],
        detailType: ["ECS Deployment State Change"],
        resources: [
          bffService.serviceArn,
          inferenceService.serviceArn,
          workerService.serviceArn,
          ...(converterService ? [converterService.serviceArn] : []),
        ],
      },
      targets: [new targets.LambdaFunction(infraAlerts)],
    });

    // RDS. 저장공간·장애조치는 앱이 느려지거나 죽기 **전에** 오는 유일한 신호다.
    new events.Rule(this, "DatabaseEventRule", {
      description: "Standin RDS 인스턴스 이벤트를 알린다",
      eventPattern: {
        source: ["aws.rds"],
        detailType: ["RDS DB Instance Event"],
        resources: [database.instanceArn],
      },
      targets: [new targets.LambdaFunction(infraAlerts)],
    });

    // ── 출력 ─────────────────────────────────────────────────────
    new CfnOutput(this, "AlbUrl", {
      value: `https://${alb.loadBalancerDnsName}`,
      description: "가비아 DNS CNAME 대상인 ALB 주소(인증서 이름 불일치로 직접 호출하지 않음)",
    });
    new CfnOutput(this, "PublicUrl", {
      value: props.publicUrl,
      description: "클라 API · OAuth 리디렉트 · 이메일 인증 링크의 공개 HTTPS 기준 URL",
    });
    new CfnOutput(this, "AssetsBucketName", {
      value: assets.bucketName,
      description: "포즈 라이브러리 번들을 올릴 버킷",
    });
    new CfnOutput(this, "BffServiceName", { value: bffService.serviceName });
    new CfnOutput(this, "AnalysisWorkerServiceName", { value: workerService.serviceName });
    new CfnOutput(this, "AnalysisQueueUrl", { value: analysisQueue.queueUrl });
    new CfnOutput(this, "AnalysisDlqUrl", { value: analysisDlq.queueUrl });
    new CfnOutput(this, "BetaDataBucketName", {
      value: betaData.bucketName,
      description: "Private 90-day bucket for consented closed-beta input images",
    });
    new CfnOutput(this, "InferenceServiceName", { value: inferenceService.serviceName });
    new CfnOutput(this, "RefineEnabled", {
      value: String(props.refineEnabled),
      description: "Inference-side refine execution flag",
    });
    new CfnOutput(this, "RefineFeatureEnabled", {
      value: String(props.refineFeatureEnabled),
      description: "BFF refine exposure flag",
    });
    new CfnOutput(this, "ClusterName", { value: cluster.clusterName });
    if (inferenceLogGroup) {
      new CfnOutput(this, "InferenceLogGroupName", {
        value: inferenceLogGroup.logGroupName,
        description: "추론 운영자에게 읽기 권한이 열려 있는 유일한 로그 그룹",
      });
    }
    new CfnOutput(this, "OauthSuccessRedirect", {
      value: props.oauthSuccessRedirect,
      description: "이 환경용 클라이언트 빌드가 등록해야 하는 딥링크 스킴",
    });
    new CfnOutput(this, "CorsOrigins", {
      value: props.corsOrigins,
      description: "이 환경의 BFF가 허용하는 Origin 목록",
    });
    if (converterService) {
      new CfnOutput(this, "ConverterServiceName", { value: converterService.serviceName });
      new CfnOutput(this, "ConverterBaseUrl", {
        value: converterBaseUrl,
        description: "BFF가 FBX 변환에 호출하는 내부 주소",
      });
      new CfnOutput(this, "ConverterCharacterUris", {
        value: [
          `s3://${assets.bucketName}/characters/standin-master-v2.fbx`,
          `s3://${assets.bucketName}/characters/standin-female-v2-lbs.fbx`,
        ].join(","),
        description: "converter가 받는 캐릭터 아티팩트. 기본 캐릭터가 없으면 헬스체크가 503이다",
      });
    }
    new CfnOutput(this, "FbxExportEnabled", {
      value: String(props.fbxExportEnabled),
      description: "BFF의 FBX 노출 스위치",
    });
    new CfnOutput(this, "ImageTag", {
      value: props.imageTag,
      description: "cdk deploy가 서비스를 되돌릴 때 끌어오는 이미지 태그",
    });
    new CfnOutput(this, "EnvName", {
      value: props.envName,
      description: "배포 환경(prod | staging). 배포 워크플로가 대상을 확인하는 값",
    });
    new CfnOutput(this, "ServiceDesiredCount", {
      value: String(props.serviceDesiredCount),
      description: "0이면 스택만 남고 태스크는 떠 있지 않다(staging 유휴 상태)",
    });
    new CfnOutput(this, "InferenceOperatorPolicyArn", {
      value: inferenceOperatorPolicy.managedPolicyArn,
      description: "IAM Identity Center 팀 권한 세트 또는 기존 역할에 연결할 추론 운영 정책",
    });
    }
}
