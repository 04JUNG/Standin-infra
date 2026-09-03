import { CfnOutput, Stack, type StackProps } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import type * as ecr from "aws-cdk-lib/aws-ecr";
import type { Construct } from "constructs";

export interface CicdStackProps extends StackProps {
  /** GitHub API가 반환한 저장소별 OIDC subject prefix. */
  githubOidcSubjectPrefixes: string[];
  /**
   * 이 역할을 assume할 수 있는 GitHub environment 이름들.
   *
   * 신뢰 범위를 좁게 유지하는 두 번째 축이다 — 저장소가 맞아도 보호된 environment에
   * 붙은 job이 아니면 assume할 수 없다. 각 environment의 배포 가능 브랜치는 GitHub
   * 쪽에서 제한한다(beta=main, staging=develop).
   */
  githubDeployEnvironments: string[];
  /**
   * PassRole을 허용할 앱 스택 이름 접두사들.
   *
   * ECS 태스크 역할 이름은 `<스택이름>-<논리ID><해시>` 꼴이라 스택마다 다르다.
   * 환경을 추가하면 여기에 그 스택 이름을 넣어야 배포 워크플로가 태스크 정의를
   * 다시 등록할 수 있다.
   */
  appStackPrefixes: string[];
  bffRepo: ecr.Repository;
  inferenceRepo: ecr.Repository;
  /**
   * FBX converter 저장소.
   *
   * converter-deploy.yml은 `CONVERTER_AWS_DEPLOY_ROLE`이라는 **별도 변수**로 역할을
   * 받는다. 그 변수에 이 역할의 ARN을 넣으면 여기서 준 권한으로 배포된다. 경계를 정말
   * 분리하고 싶으면 별도 역할을 만들어 그 변수만 바꾸면 되고, 앱 저장소 쪽은 영향이 없다.
   */
  converterRepo: ecr.Repository;
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

    // Only jobs attached to a protected GitHub environment may assume this role.
    // Each environment restricts which branches may deploy through it
    // (`beta` from `main`, `staging` from `develop`).
    const subjects = props.githubOidcSubjectPrefixes.flatMap((prefix) =>
      props.githubDeployEnvironments.map((environment) => `${prefix}:environment:${environment}`),
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
    props.converterRepo.grantPullPush(role);

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
        // `StandinApp-*`는 `StandinStagingApp-...`에 걸리지 않는다(접두사가 리터럴이다).
        // 환경마다 명시적으로 넣어야 해당 스택의 태스크 역할을 넘길 수 있다.
        resources: props.appStackPrefixes.flatMap((prefix) => [
          `arn:${this.partition}:iam::${this.account}:role/${prefix}-*TaskExecutionRole*`,
          `arn:${this.partition}:iam::${this.account}:role/${prefix}-*TaskTaskRole*`,
        ]),
        conditions: { StringEquals: { "iam:PassedToService": "ecs-tasks.amazonaws.com" } },
      }),
    );

    new CfnOutput(this, "DeployRoleArn", {
      value: role.roleArn,
      description: "GitHub Actions 워크플로의 role-to-assume 값",
    });
  }
}
