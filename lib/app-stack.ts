import { CfnOutput, Duration, RemovalPolicy, SecretValue, Stack, type StackProps } from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import type * as ecr from "aws-cdk-lib/aws-ecr";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
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
  bffRepo: ecr.Repository;
  inferenceRepo: ecr.Repository;
  /** ALB DNS를 알기 전 첫 배포에서는 비워 둔다. 이후 채워서 재배포. */
  publicUrl: string;
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

    const dbSg = new ec2.SecurityGroup(this, "DbSg", {
      vpc: vpc,
      description: "Standin BFF PostgreSQL",
      allowAllOutbound: false,
    });

    // 유일하게 허용하는 내부 경로 두 개.
    inferenceSg.addIngressRule(bffSg, ec2.Port.tcp(8000), "BFF to inference");
    inferenceSg.addIngressRule(workerSg, ec2.Port.tcp(8000), "Worker to inference");
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
        secretName: "standin/db",
      }),
      allocatedStorage: 20,
      maxAllocatedStorage: 100, // 오토스케일 상한
      multiAz: false, // 초기엔 단일 AZ. 가용성이 필요해지면 켠다(비용 2배)
      publiclyAccessible: false,
      backupRetention: Duration.days(7),
      deleteAutomatedBackups: false,
      // ⚠ 초기 단계 설정이다. 실사용자가 생기면 RETAIN + deletionProtection으로 바꿀 것.
      removalPolicy: RemovalPolicy.SNAPSHOT,
      deletionProtection: false,
      storageEncrypted: true,
      enablePerformanceInsights: false, // t4g.micro는 미지원
    });

    
  
    // ── 서비스 ───────────────────────────────────────────────────
    const cluster = new ecs.Cluster(this, "Cluster", {
      vpc: vpc,
      containerInsightsV2: ecs.ContainerInsights.ENABLED,
      defaultCloudMapNamespace: {
        name: "standin.local",
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
      alias: `alias/standin-${props.appEnv}-beta-data`,
      enableKeyRotation: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const betaData = new s3.Bucket(this, "BetaDataBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: betaDataKey,
      enforceSSL: true,
      versioned: false,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      lifecycleRules: [{ id: "ExpireBetaInputs", expiration: Duration.days(90) }],
      removalPolicy: RemovalPolicy.RETAIN,
      autoDeleteObjects: false,
    });

    const jwtSecret = new secretsmanager.Secret(this, "JwtSecret", {
      secretName: "standin/jwt",
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
      secretName: "standin/oauth",
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
      secretName: "standin/vlm",
      description: "VLM provider API keys. Fill values in the console before switching to production.",
      secretObjectValue: {
        geminiApiKey: SecretValue.unsafePlainText(""),
        openaiApiKey: SecretValue.unsafePlainText(""),
      },
    });
    const betaReviewSecret = new secretsmanager.Secret(this, "BetaReviewSecret", {
      secretName: `standin/${props.appEnv}/beta-review-token`,
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
      secretName: `standin/${props.appEnv}/ip-hash-salt`,
      description: "Salt for hashing client IPs into rate-limit buckets",
      generateSecretString: { passwordLength: 48, excludePunctuation: true },
    });

    // 이메일 인증용 SMTP 설정. 공급자(Gmail·SES SMTP 등)는 배포 후 콘솔에서 채운다.
    // ECS가 JSON 키를 시작 시 해석하므로 값이 비어 있어도 모든 키를 미리 만든다.
    const smtpSecret = new secretsmanager.Secret(this, "SmtpSecret", {
      secretName: "standin/smtp",
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
      secretName: "standin/discord",
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

    // CloudFront만 ALB를 통과할 수 있게 하는 origin 검증값. 값은 코드나 출력에 남기지 않는다.
    const originVerifySecret = new secretsmanager.Secret(this, "OriginVerifySecret", {
      description: "Shared secret used to verify CloudFront requests at the ALB",
      generateSecretString: { passwordLength: 48, excludePunctuation: true },
    });

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
            secretName: "standin/log-shipping",
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

    inferenceTask.addContainer("inference", {
      image: ecs.ContainerImage.fromEcrRepository(props.inferenceRepo, "latest"),
      logging: containerLogging(inferenceTask, "inference"),
      environment: {
        APP_ENV: props.appEnv,
        // 1단계는 mock으로 인프라 배선만 확인하고, 2단계에서 실모델로 넘어간다.
        // production에서 mock이면 추론 서버가 기동을 거부한다(조용한 폴백도 잡는다).
        VLM_PROVIDER: isProd ? "gemini" : "mock",
        // 기본 모델 변경이나 지원 종료에 영향받지 않도록 배포 모델을 명시한다.
        GEMINI_MODEL: "gemini-flash-latest",
        GEMINI_REQUEST_TIMEOUT_MS: "20000",
        GEMINI_MAX_ATTEMPTS: "3",
        GEMINI_RETRY_BASE_SECONDS: "0.5",
        GEMINI_RETRY_MAX_SECONDS: "2.0",
        POSE_BACKEND: isProd ? "rtmlib" : "mock",
        DATA_DIR: "/app/data",
        DB_PATH: "/app/data/poses.db",
        INDEX_PATH: "/app/data/index.pkl",
        // 1단계에서는 비운다 → 합성 라이브러리로 기동한다.
        // 2단계에서는 번들을 받아 푼다. 번들이 없으면 기동에 실패한다(의도).
        POSE_LIBRARY_URI: isProd ? `s3://${assets.bucketName}/pose-library/v1.tar.gz` : "",
        POSE_LIBRARY_VERSION: "v1",
        DEPLOYMENT_VERSION: process.env.DEPLOYMENT_VERSION ?? "unknown",
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
        startPeriod: Duration.seconds(90), // 라이브러리 다운로드 시간 확보
      },
    });

    // 번들을 받으려면 읽기 권한이 필요하다(태스크 역할 → 키를 환경에 두지 않는다).
    assets.grantRead(inferenceTask.taskRole);

    const inferenceService = new ecs.FargateService(this, "InferenceService", {
      cluster,
      taskDefinition: inferenceTask,
      desiredCount: 1,
      securityGroups: [inferenceSg],
      // NAT가 없으므로 퍼블릭 서브넷 + 퍼블릭 IP로 외부(VLM API·S3)에 나간다.
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      assignPublicIp: true,
      cloudMapOptions: {
        name: "inference", // → inference.standin.local
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
      managedPolicyName: "standin-inference-operator",
      description: "Upload Standin pose libraries and restart only the inference ECS service",
      statements: [
        new iam.PolicyStatement({
          sid: "ListPoseLibraryPrefix",
          actions: ["s3:ListBucket", "s3:ListBucketVersions"],
          resources: [assets.bucketArn],
          conditions: {
            StringLike: {
              "s3:prefix": ["pose-library", "pose-library/*"],
            },
          },
        }),
        new iam.PolicyStatement({
          sid: "UploadAndVerifyPoseLibrary",
          actions: [
            "s3:PutObject",
            "s3:GetObject",
            "s3:GetObjectVersion",
            "s3:AbortMultipartUpload",
          ],
          resources: [assets.arnForObjects("pose-library/*")],
        }),
        new iam.PolicyStatement({
          sid: "RestartInferenceService",
          actions: ["ecs:DescribeServices", "ecs:UpdateService"],
          resources: [inferenceService.serviceArn],
        }),
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
      image: ecs.ContainerImage.fromEcrRepository(props.bffRepo, "latest"),
      logging: containerLogging(bffTask, "bff"),
      environment: {
        PORT: "8080",
        NODE_ENV: "production",
        PUBLIC_URL: props.publicUrl,
        // Vercel 가입 페이지가 register/resend-verification API를 직접 호출한다.
        CORS_ORIGINS:
          "http://localhost:1420,http://tauri.localhost,tauri://localhost,http://localhost:5173,https://standin-seven.vercel.app",
        // OAuth 완료 후 브라우저에서 데스크톱 앱으로 1회용 교환 코드를 전달한다.
        OAUTH_SUCCESS_REDIRECT: "standin://auth/callback",
        INFERENCE_BASE_URL: "http://inference.standin.local:8000",
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
        BETA_CONSENT_VERSION: "2026-08-02",
        DEPLOYMENT_VERSION: process.env.DEPLOYMENT_VERSION ?? "unknown",
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
        // ⚠ XFF 오른쪽에서 신뢰하는 프록시 홉 수. 이 스택의 체인이
        //   CloudFront → ALB라서 1이다: CloudFront가 뷰어 IP를 덧붙이고 ALB가
        //   엣지 IP를 덧붙이므로 오른쪽에서 2번째가 실제 client IP다.
        //   CloudFront는 클라가 보낸 XFF도 그대로 전달하므로(ALL_VIEWER_EXCEPT_HOST_HEADER)
        //   왼쪽은 위조 가능하다 — 홉 수를 실제 프록시 수보다 크게 잡으면 IP 제한이 우회된다.
        //   체인이 바뀌면(WAF 삽입, ALB 직접 노출 등) 이 값도 같이 바꿔야 한다.
        TRUSTED_PROXY_HOPS: "1",
        QUOTA_INSTALLATION_DAILY: "10",
        QUOTA_INSTALLATION_CONCURRENT: "1",
        // 전체 일일 상한. 오픈베타_계획_2026-08-13 §4-2의 산식에서 나온 값이다:
        // (월 10만원 − AWS 고정비 5만) ÷ 건당 4원 ≈ 12,500회/월 ≈ 일 416회 → 400.
        // ⚠ 입력값 둘(AWS 고정비 실측·Gemini 건당 단가)이 아직 측정 전이라 잠정치다.
        //   단가가 4원을 크게 넘으면 이 값이 아니라 QUOTA_INSTALLATION_DAILY를 먼저 낮춘다.
        QUOTA_GLOBAL_DAILY: "400",
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
      desiredCount: 1,
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
      image: ecs.ContainerImage.fromEcrRepository(props.bffRepo, "latest"),
      command: ["node", "dist/worker.js"],
      stopTimeout: Duration.seconds(120),
      logging: containerLogging(workerTask, "analysis-worker"),
      environment: {
        NODE_ENV: "production",
        INFERENCE_BASE_URL: "http://inference.standin.local:8000",
        BETA_DATA_BUCKET: betaData.bucketName,
        ANALYSIS_QUEUE_URL: analysisQueue.queueUrl,
        WORKER_VISIBILITY_SECONDS: "180",
        WORKER_LEASE_SECONDS: "180",
        ANALYSIS_TIMEOUT_MS: "120000",
        DATABASE_SSL: "true",
        PGDATABASE: "standin",
        DEPLOYMENT_VERSION: process.env.DEPLOYMENT_VERSION ?? "unknown",
        DISCORD_ALERT_MENTION: discordAlertMention,
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
      desiredCount: props.jobExecutionMode === "sqs" ? 1 : 0,
      securityGroups: [workerSg],
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      assignPublicIp: true,
      circuitBreaker: { rollback: true },
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
    });

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

    const listener = alb.addListener("Http", {
      port: 80,
      open: true,
      // ALB DNS로 직접 들어온 요청은 거부한다. 정상 요청은 아래 CloudFront 전용 규칙만 통과한다.
      defaultAction: elbv2.ListenerAction.fixedResponse(403, {
        contentType: "text/plain",
        messageBody: "Access denied",
      }),
    });

    listener.addTargets("BffTarget", {
      priority: 1,
      conditions: [
        elbv2.ListenerCondition.httpHeader(
          "X-Standin-Origin-Verify",
          [originVerifySecret.secretValue.unsafeUnwrap()],
        ),
      ],
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

    // 도메인이 없어도 CloudFront 기본 인증서(*.cloudfront.net)로 공인 HTTPS를 제공한다.
    // API이므로 캐시하지 않고, Host를 제외한 헤더·쿠키·쿼리스트링을 origin에 전달한다.
    const distribution = new cloudfront.Distribution(this, "Distribution", {
      comment: "Standin public HTTPS entry point",
      defaultBehavior: {
        origin: new origins.HttpOrigin(alb.loadBalancerDnsName, {
          protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
          customHeaders: {
            "X-Standin-Origin-Verify": originVerifySecret.secretValue.unsafeUnwrap(),
          },
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD_OPTIONS,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        compress: true,
      },
      enabled: true,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_200,
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
      value: `http://${alb.loadBalancerDnsName}`,
      description: "CloudFront origin 전용 주소(직접 요청은 403)",
    });
    new CfnOutput(this, "CloudFrontUrl", {
      value: `https://${distribution.distributionDomainName}`,
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
    new CfnOutput(this, "InferenceOperatorPolicyArn", {
      value: inferenceOperatorPolicy.managedPolicyArn,
      description: "IAM Identity Center 팀 권한 세트 또는 기존 역할에 연결할 추론 운영 정책",
    });
    }
}
