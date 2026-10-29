import { Stack, type StackProps } from "aws-cdk-lib";
import { Construct } from "constructs";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as secrets from "aws-cdk-lib/aws-secretsmanager";
import * as discovery from "aws-cdk-lib/aws-servicediscovery";
import { SceneWorker } from "./scene-worker";
import { validateSceneWorkerRelease, type SceneWorkerRelease } from "./scene-worker-config";

export interface StagingSceneContext {
  envName: "staging";
  account: string;
  region: string;
  vpcId: string;
  availabilityZones: string[];
  publicSubnetIds: string[];
  isolatedSubnetIds: string[];
  clusterArn: string;
  bffSecurityGroupId: string;
  namespaceId: string;
  namespaceArn: string;
  namespaceName: string;
  assetsBucketName: string;
  vlmSecretArn: string;
  githubSubjectPrefixes: string[];
}

export function validateStagingSceneContext(value: unknown): StagingSceneContext {
  const c = value as StagingSceneContext;
  if (!c || c.envName !== "staging" || !/^\d{12}$/.test(c.account) || c.region !== "ap-northeast-2") {
    throw new Error("standalone scene worker requires an explicit staging account and region");
  }
  const prefix = `arn:aws:`;
  if (!c.clusterArn?.startsWith(`${prefix}ecs:${c.region}:${c.account}:cluster/StandinStagingApp-`) ||
      !c.vlmSecretArn?.startsWith(`${prefix}secretsmanager:${c.region}:${c.account}:secret:standin/staging/`) ||
      !c.assetsBucketName?.startsWith("standinstagingapp-assetsbucket") ||
      c.namespaceName !== "standin-staging.local" ||
      c.namespaceArn !== `${prefix}servicediscovery:${c.region}:${c.account}:namespace/${c.namespaceId}`) {
    throw new Error("standalone scene references must belong to staging");
  }
  if (!/^vpc-[a-f0-9]+$/.test(c.vpcId) || !/^sg-[a-f0-9]+$/.test(c.bffSecurityGroupId) ||
      !/^ns-[a-z0-9]+$/.test(c.namespaceId)) throw new Error("invalid staging resource identity");
  for (const subnets of [c.publicSubnetIds, c.isolatedSubnetIds]) {
    if (!Array.isArray(subnets) || subnets.length !== c.availabilityZones?.length || !subnets.length ||
        subnets.some(id => !/^subnet-[a-f0-9]+$/.test(id))) throw new Error("explicit ordered staging subnets required");
  }
  if (new Set([...c.publicSubnetIds, ...c.isolatedSubnetIds]).size !== c.publicSubnetIds.length + c.isolatedSubnetIds.length ||
      c.availabilityZones.some(zone => !/^ap-northeast-2[a-z]$/.test(zone)) ||
      c.githubSubjectPrefixes?.length !== 1 || c.githubSubjectPrefixes[0] !== "repo:04JUNG/Standin-server") {
    throw new Error("invalid staging subnet or GitHub ownership");
  }
  return c;
}

/** Imports existing references only: never synthesizes BFF/inference/Converter resources. */
export class SceneWorkerStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps & {
    context: StagingSceneContext; release: SceneWorkerRelease; active: boolean;
  }) {
    super(scope, id, props);
    const c = validateStagingSceneContext(props.context);
    if (id !== "StandinStagingSceneWorker" || this.account !== c.account || this.region !== c.region) {
      throw new Error("standalone scene stack target mismatch");
    }
    const vpc = ec2.Vpc.fromVpcAttributes(this, "ExistingVpc", {
      vpcId: c.vpcId, availabilityZones: c.availabilityZones,
      publicSubnetIds: c.publicSubnetIds, isolatedSubnetIds: c.isolatedSubnetIds,
    });
    const namespace = discovery.PrivateDnsNamespace.fromPrivateDnsNamespaceAttributes(this, "ExistingNamespace", c);
    const cluster = ecs.Cluster.fromClusterAttributes(this, "ExistingCluster", {
      clusterArn: c.clusterArn, clusterName: c.clusterArn.split("/").pop()!,
      vpc, securityGroups: [], defaultCloudMapNamespace: namespace,
    });
    new SceneWorker(this, "SceneWorker", {
      envName: "staging", cluster,
      bffSecurityGroup: ec2.SecurityGroup.fromSecurityGroupId(this, "ExistingBffSg", c.bffSecurityGroupId, { mutable: false }),
      assets: s3.Bucket.fromBucketName(this, "ExistingAssets", c.assetsBucketName),
      vlmSecret: secrets.Secret.fromSecretCompleteArn(this, "ExistingVlm", c.vlmSecretArn),
      namespaceName: c.namespaceName, release: validateSceneWorkerRelease(props.release),
      active: props.active, githubSubjectPrefixes: c.githubSubjectPrefixes,
    });
  }
}
