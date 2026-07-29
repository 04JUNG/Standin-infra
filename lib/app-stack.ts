import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import type * as ecr from "aws-cdk-lib/aws-ecr";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as logs from "aws-cdk-lib/aws-logs";
import * as rds from "aws-cdk-lib/aws-rds";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as servicediscovery from "aws-cdk-lib/aws-servicediscovery";
import type { Construct } from "constructs";

export interface AppStackProps extends StackProps {
  bffRepo: ecr.Repository;
  inferenceRepo: ecr.Repository;
  /** ALB DNS를 알기 전 첫 배포에서는 비워 둔다. 이후 채워서 재배포. */
  publicUrl: string;
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

    const dbSg = new ec2.SecurityGroup(this, "DbSg", {
      vpc: vpc,
      description: "Standin BFF PostgreSQL",
      allowAllOutbound: false,
    });

    // 유일하게 허용하는 내부 경로 두 개.
    inferenceSg.addIngressRule(bffSg, ec2.Port.tcp(8000), "BFF to inference");
    dbSg.addIngressRule(bffSg, ec2.Port.tcp(5432), "BFF to PostgreSQL");
  
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
    const jwtSecret = new secretsmanager.Secret(this, "JwtSecret", {
      secretName: "standin/jwt",
      description: "BFF JWT 서명 키",
      generateSecretString: { passwordLength: 48, excludePunctuation: true },
    });

    // 소셜 로그인 키는 콘솔에서 발급받아 채워야 한다 → 빈 껍데기만 만든다.
    const oauthSecret = new secretsmanager.Secret(this, "OAuthSecret", {
      secretName: "standin/oauth",
      description:
        "소셜 로그인 클라이언트 키. 배포 후 콘솔에서 값을 채운다: " +
        "{googleClientId, googleClientSecret, kakaoClientId, kakaoClientSecret, naverClientId, naverClientSecret}",
      generateSecretString: {
        secretStringTemplate: JSON.stringify({}),
        generateStringKey: "placeholder",
      },
    });

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
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: "inference",
        logRetention: logs.RetentionDays.TWO_WEEKS,
      }),
      environment: {
        APP_ENV: "production",
        // ⚠ production에서는 mock이 차단된다. 실제 값으로 바꾸기 전까지 태스크가 뜨지 않는다.
        //    첫 배포를 통과시키려면 아래를 실제 provider로 바꾸고 API 키를 시크릿에 넣어야 한다.
        VLM_PROVIDER: "gemini",
        POSE_BACKEND: "rtmlib",
        DATA_DIR: "/app/data",
        DB_PATH: "/app/data/poses.db",
        INDEX_PATH: "/app/data/index.pkl",
        // 포즈 라이브러리 번들 위치. 업로드 후 이 값을 채운다.
        POSE_LIBRARY_URI: `s3://${assets.bucketName}/pose-library/v1.tar.gz`,
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
      minHealthyPercent: 100,
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

    bffTask.addContainer("bff", {
      image: ecs.ContainerImage.fromEcrRepository(props.bffRepo, "latest"),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: "bff",
        logRetention: logs.RetentionDays.TWO_WEEKS,
      }),
      environment: {
        PORT: "8080",
        NODE_ENV: "production",
        PUBLIC_URL: props.publicUrl,
        INFERENCE_BASE_URL: "http://inference.standin.local:8000",
        DATABASE_SSL: "true", // RDS는 TLS 필수
        // DATABASE_URL 대신 표준 PG* 변수를 쓴다 — RDS가 만든 시크릿을 그대로 주입할 수 있어
        // 접속 문자열을 따로 만들어 보관하지 않아도 된다. (README의 앱 변경 사항 참고)
        PGDATABASE: "standin",
      },
      secrets: {
        JWT_SECRET: ecs.Secret.fromSecretsManager(jwtSecret),
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
      },
      portMappings: [{ containerPort: 8080 }],
    });

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

    const alb = new elbv2.ApplicationLoadBalancer(this, "Alb", {
      vpc: vpc,
      internetFacing: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
    });

    const listener = alb.addListener("Http", {
      port: 80,
      open: true,
      // TODO: 도메인·ACM 인증서가 준비되면 443 리스너로 바꾸고 80은 리다이렉트.
    });

    listener.addTargets("BffTarget", {
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

    // ── 출력 ─────────────────────────────────────────────────────
    new CfnOutput(this, "AlbUrl", {
      value: `http://${alb.loadBalancerDnsName}`,
      description: "클라 VITE_API_BASE_URL · OAuth 리디렉트의 기준 URL",
    });
    new CfnOutput(this, "AssetsBucketName", {
      value: assets.bucketName,
      description: "포즈 라이브러리 번들을 올릴 버킷",
    });
    new CfnOutput(this, "BffServiceName", { value: bffService.serviceName });
    new CfnOutput(this, "InferenceServiceName", { value: inferenceService.serviceName });
    new CfnOutput(this, "ClusterName", { value: cluster.clusterName });
    }
}
