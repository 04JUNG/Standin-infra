import { CfnOutput, Duration, RemovalPolicy, Stack } from "aws-cdk-lib";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Construct } from "constructs";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as efs from "aws-cdk-lib/aws-efs";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import type * as s3 from "aws-cdk-lib/aws-s3";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import { validateSceneWorkerRelease, type SceneWorkerRelease } from "./scene-worker-config";

interface SceneWorkerProps {
  envName: "prod" | "staging";
  cluster: ecs.ICluster;
  bffSecurityGroup: ec2.ISecurityGroup;
  assets: s3.IBucket;
  vlmSecret: secretsmanager.ISecret;
  namespaceName: string;
  release: SceneWorkerRelease;
  active: boolean;
  githubSubjectPrefixes: string[];
}

/** Dedicated opt-in runtime; no public listener, shared inference or Converter task. */
export class SceneWorker extends Construct {
  readonly service: ecs.FargateService;
  readonly token: secretsmanager.Secret;
  readonly baseUrl: string;

  constructor(scope: Construct, id: string, props: SceneWorkerProps) {
    super(scope, id);
    if (props.envName !== "staging") throw new Error("v4 scene worker is staging-only");
    const release = validateSceneWorkerRelease(props.release);
    const stack = Stack.of(this);
    const vpc = props.cluster.vpc;
    const workerSg = new ec2.SecurityGroup(this, "WorkerSg", { vpc });
    workerSg.addIngressRule(props.bffSecurityGroup, ec2.Port.tcp(8002), "BFF to private scene worker");
    const publisherSg = new ec2.SecurityGroup(this, "PublisherSg", { vpc });
    const fsSg = new ec2.SecurityGroup(this, "AssetSg", { vpc, allowAllOutbound: false });
    fsSg.addIngressRule(workerSg, ec2.Port.tcp(2049), "Worker release reads");
    fsSg.addIngressRule(publisherSg, ec2.Port.tcp(2049), "Explicit release publication");
    const filesystem = new efs.FileSystem(this, "Assets", {
      vpc, securityGroup: fsSg, encrypted: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      allowAnonymousAccess: false, removalPolicy: RemovalPolicy.RETAIN,
    });
    const accessPoint = filesystem.addAccessPoint("ReleaseAccess", {
      path: "/releases", posixUser: { uid: "10001", gid: "10001" },
      createAcl: { ownerUid: "10001", ownerGid: "10001", permissions: "750" },
    });
    const repository = new ecr.Repository(this, "Repository", {
      repositoryName: "standin/scene-worker", imageScanOnPush: true,
      imageTagMutability: ecr.TagMutability.IMMUTABLE,
      removalPolicy: RemovalPolicy.RETAIN,
      // Do not expire a SHA still referenced by a task definition.
    });
    this.token = new secretsmanager.Secret(this, "Token", {
      secretName: "standin/staging/scene-worker-token",
      generateSecretString: { passwordLength: 48, excludePunctuation: true },
    });
    this.token.applyRemovalPolicy(RemovalPolicy.RETAIN);
    const logGroup = new logs.LogGroup(this, "Logs", {
      retention: logs.RetentionDays.TWO_WEEKS, removalPolicy: RemovalPolicy.RETAIN,
    });
    const task = new ecs.FargateTaskDefinition(this, "Task", {
      family: "standin-scene-worker-staging", cpu: 4096, memoryLimitMiB: 8192,
      ephemeralStorageGiB: 30,
      runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.X86_64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX },
      volumes: [{ name: "scene-assets", efsVolumeConfiguration: {
        fileSystemId: filesystem.fileSystemId, transitEncryption: "ENABLED",
        authorizationConfig: { accessPointId: accessPoint.accessPointId, iam: "ENABLED" },
      } }],
    });
    const container = task.addContainer("scene-worker", {
      image: ecs.ContainerImage.fromEcrRepository(repository, release.imageTag),
      user: "10001:10001", essential: true,
      linuxParameters: new ecs.LinuxParameters(this, "Init", { initProcessEnabled: true }),
      logging: ecs.LogDrivers.awsLogs({ logGroup, streamPrefix: "scene-worker" }),
      environment: {
        APP_ENV: "staging", SCENE_REFINEMENT_ENABLED: "1", SCENE_VLM_PROVIDER: "gemini",
        SCENE_VLM_MODEL: release.vlmModel,
        SCENE_ASSET_MANIFEST: `/scene-assets/${release.releaseId}/release.json`,
        SCENE_ASSET_MANIFEST_SHA256: release.manifestSha256,
        DEPLOYMENT_VERSION: release.imageTag,
      },
      secrets: {
        SCENE_REFINEMENT_TOKEN: ecs.Secret.fromSecretsManager(this.token),
        GEMINI_API_KEY: ecs.Secret.fromSecretsManager(props.vlmSecret, "geminiApiKey"),
      },
      portMappings: [{ containerPort: 8002 }], stopTimeout: Duration.seconds(120),
      healthCheck: {
        command: ["CMD-SHELL", "python -c \"import urllib.request; urllib.request.urlopen('http://127.0.0.1:8002/readyz',timeout=3)\""],
        interval: Duration.seconds(30), timeout: Duration.seconds(5), retries: 3,
        startPeriod: Duration.seconds(300),
      },
    });
    container.addMountPoints({ sourceVolume: "scene-assets", containerPath: "/scene-assets", readOnly: true });
    task.taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ["elasticfilesystem:ClientMount"], resources: [filesystem.fileSystemArn],
      conditions: { StringEquals: { "elasticfilesystem:AccessPointArn": accessPoint.accessPointArn } },
    }));
    this.service = new ecs.FargateService(this, "Service", {
      cluster: props.cluster, taskDefinition: task, desiredCount: props.active ? 1 : 0,
      securityGroups: [workerSg],
      // Existing VPC has no NAT. Egress follows existing tasks; SG permits only BFF ingress.
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC }, assignPublicIp: true,
      minHealthyPercent: 0, maxHealthyPercent: 100, circuitBreaker: { rollback: true },
      healthCheckGracePeriod: Duration.seconds(300),
      cloudMapOptions: { name: "scene-worker" },
    });
    this.service.node.addDependency(filesystem.mountTargetsAvailable);
    this.baseUrl = `http://scene-worker.${props.namespaceName}:8002`;

    // One-off publisher: never a service; no credentials for Gemini or scene requests.
    const publisher = new ecs.FargateTaskDefinition(this, "PublisherTask", {
      family: "standin-scene-release-publisher-staging", cpu: 1024, memoryLimitMiB: 2048,
      ephemeralStorageGiB: 40, runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.X86_64, operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      }, volumes: [{ name: "scene-assets", efsVolumeConfiguration: {
        fileSystemId: filesystem.fileSystemId, transitEncryption: "ENABLED",
        authorizationConfig: { accessPointId: accessPoint.accessPointId, iam: "ENABLED" },
      } }],
    });
    publisher.addContainer("release-publisher", {
      image: ecs.ContainerImage.fromEcrRepository(repository, release.imageTag),
      user: "10001:10001", entryPoint: ["python", "-c"],
      command: [readFileSync(path.join(__dirname, "..", "scripts", "publish-scene-release.py"), "utf8")],
      environment: {
        SCENE_RELEASE_BUCKET: props.assets.bucketName, SCENE_RELEASE_KEY: release.bundleKey,
        SCENE_RELEASE_BUNDLE_SHA256: release.bundleSha256, SCENE_RELEASE_ID: release.releaseId,
        SCENE_ASSET_MANIFEST_SHA256: release.manifestSha256,
      }, logging: ecs.LogDrivers.awsLogs({ logGroup, streamPrefix: "release-publisher" }),
    }).addMountPoints({ sourceVolume: "scene-assets", containerPath: "/scene-assets", readOnly: false });
    props.assets.grantRead(publisher.taskRole, release.bundleKey);
    publisher.taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ["elasticfilesystem:ClientMount", "elasticfilesystem:ClientWrite"],
      resources: [filesystem.fileSystemArn],
      conditions: { StringEquals: { "elasticfilesystem:AccessPointArn": accessPoint.accessPointArn } },
    }));

    // Created but not attached to a person. An administrator selects the operator.
    const operatorPolicy = new iam.ManagedPolicy(this, "ReleaseOperatorPolicy", {
      description: "Publish one pinned staging scene release and inspect its dedicated tasks",
      statements: [
        new iam.PolicyStatement({ actions: ["s3:PutObject", "s3:GetObject", "s3:GetObjectVersion", "s3:AbortMultipartUpload"],
          resources: [props.assets.arnForObjects(release.bundleKey)] }),
        new iam.PolicyStatement({ actions: ["ecs:RunTask"], resources: [publisher.taskDefinitionArn],
          conditions: { ArnEquals: { "ecs:cluster": props.cluster.clusterArn } } }),
        new iam.PolicyStatement({ actions: ["iam:PassRole"],
          resources: [publisher.taskRole.roleArn, publisher.executionRole!.roleArn],
          conditions: { StringEquals: { "iam:PassedToService": "ecs-tasks.amazonaws.com" } } }),
        new iam.PolicyStatement({ actions: ["ecs:DescribeTasks"],
          resources: [`arn:${stack.partition}:ecs:${stack.region}:${stack.account}:task/${props.cluster.clusterName}/*`] }),
        new iam.PolicyStatement({ actions: ["ecs:DescribeServices"], resources: [this.service.serviceArn] }),
        new iam.PolicyStatement({ actions: ["cloudformation:DescribeStacks"], resources: [stack.stackId] }),
        new iam.PolicyStatement({ actions: ["logs:DescribeLogStreams", "logs:GetLogEvents", "logs:FilterLogEvents"],
          resources: [logGroup.logGroupArn] }),
      ],
    });

    const subjects = props.githubSubjectPrefixes.map(prefix => `${prefix}:environment:staging`);
    if (!subjects.length || subjects.some(subject => subject.includes("*"))) {
      throw new Error("scene deploy requires explicit server GitHub OIDC subject prefixes");
    }
    const deployRole = new iam.Role(this, "DeployRole", {
      description: "Staging-only scene worker image and dedicated service deployment",
      assumedBy: new iam.WebIdentityPrincipal(
        `arn:${stack.partition}:iam::${stack.account}:oidc-provider/token.actions.githubusercontent.com`, {
          StringEquals: { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
            "token.actions.githubusercontent.com:sub": subjects },
        }),
    });
    repository.grantPullPush(deployRole);
    deployRole.addToPolicy(new iam.PolicyStatement({
      actions: ["ecr:DescribeRepositories", "ecr:DescribeImages"], resources: [repository.repositoryArn],
    }));
    deployRole.addToPolicy(new iam.PolicyStatement({
      actions: ["ecs:DescribeServices", "ecs:UpdateService"], resources: [this.service.serviceArn],
    }));
    deployRole.addToPolicy(new iam.PolicyStatement({
      actions: ["ecs:DescribeTaskDefinition", "ecs:RegisterTaskDefinition"], resources: ["*"],
    }));
    deployRole.addToPolicy(new iam.PolicyStatement({
      actions: ["iam:PassRole"], resources: [task.taskRole.roleArn, task.executionRole!.roleArn],
      conditions: { StringEquals: { "iam:PassedToService": "ecs-tasks.amazonaws.com" } },
    }));
    for (const [name, value] of Object.entries({
      SceneWorkerCluster: props.cluster.clusterName, SceneWorkerService: this.service.serviceName,
      SceneWorkerDeployRole: deployRole.roleArn, SceneWorkerUrl: this.baseUrl,
      SceneWorkerTokenArn: this.token.secretArn, ScenePublisherTask: publisher.taskDefinitionArn,
      ScenePublisherSecurityGroup: publisherSg.securityGroupId,
      SceneReleaseOperatorPolicy: operatorPolicy.managedPolicyArn,
      SceneWorkerLogGroup: logGroup.logGroupName, SceneReleaseBucket: props.assets.bucketName,
      SceneAssetFileSystem: filesystem.fileSystemId, SceneAssetAccessPoint: accessPoint.accessPointId,
    })) new CfnOutput(this, name, { value });
  }
}
