import { CfnOutput, Stack, type StackProps } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import type * as ecr from "aws-cdk-lib/aws-ecr";
import type { Construct } from "constructs";

export interface CicdStackProps extends StackProps {
  /** GitHub API가 반환한 저장소별 OIDC subject prefix. */
  githubOidcSubjectPrefixes: string[];
  bffRepo: ecr.Repository;
  inferenceRepo: ecr.Repository;
}

/**
 * GitHub Actions용 OIDC 신뢰 관계.
 *
 * 장기 액세스 키를 만들지 않는다. GitHub이 워크플로 실행마다 발급하는 단기 토큰으로
 * 이 역할을 assume한다 — 저장소 시크릿에 남는 자격증명이 없다.
 *
 * 신뢰 범위를 저장소 단위로 제한한다. 조건을 `repo:org/*`로 넓히면 조직의 아무 저장소나
 * 이 역할을 쓸 수 있게 되므로 그렇게 하지 않는다.
 */
export class CicdStack extends Stack {
  constructor(scope: Construct, id: string, props: CicdStackProps) {
    super(scope, id, props);

    const provider = new iam.OpenIdConnectProvider(this, "GithubOidc", {
      url: "https://token.actions.githubusercontent.com",
      clientIds: ["sts.amazonaws.com"],
    });

    // Only jobs attached to the protected GitHub `beta` environment may assume
    // this role. The environment itself only permits deployments from `main`.
    const subjects = props.githubOidcSubjectPrefixes.map(
      (prefix) => `${prefix}:environment:beta`,
    );

    const role = new iam.Role(this, "GithubDeployRole", {
      roleName: "standin-github-deploy",
      // GitHub Actions가 ECR 푸시·ECS 배포에 사용하는 역할.
      // CloudFormation의 Description은 ASCII만 허용해서 영문으로 둔다.
      description: "Role assumed by GitHub Actions to push ECR images and deploy ECS services",
      assumedBy: new iam.WebIdentityPrincipal(provider.openIdConnectProviderArn, {
        StringEquals: { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com" },
        StringLike: { "token.actions.githubusercontent.com:sub": subjects },
      }),
    });

    // ECR: 로그인 토큰은 리소스 지정이 불가능한 액션이라 분리한다.
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["ecr:GetAuthorizationToken"],
        resources: ["*"],
      }),
    );
    props.bffRepo.grantPullPush(role);
    props.inferenceRepo.grantPullPush(role);

    // ECS: 새 이미지로 서비스를 다시 배포한다.
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "ecs:DescribeServices",
          "ecs:DescribeTaskDefinition",
          "ecs:RegisterTaskDefinition",
          "ecs:UpdateService",
          "ecs:ListTasks",
          "ecs:DescribeTasks",
        ],
        resources: ["*"],
      }),
    );

    // 태스크 정의를 다시 등록하려면 태스크·실행 역할을 넘길 수 있어야 한다.
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["iam:PassRole"],
        resources: [
          `arn:${this.partition}:iam::${this.account}:role/StandinApp-*TaskExecutionRole*`,
          `arn:${this.partition}:iam::${this.account}:role/StandinApp-*TaskTaskRole*`,
        ],
        conditions: { StringEquals: { "iam:PassedToService": "ecs-tasks.amazonaws.com" } },
      }),
    );

    new CfnOutput(this, "DeployRoleArn", {
      value: role.roleArn,
      description: "GitHub Actions 워크플로의 role-to-assume 값",
    });
  }
}
