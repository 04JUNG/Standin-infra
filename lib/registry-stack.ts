import { RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as ecr from "aws-cdk-lib/aws-ecr";
import type { Construct } from "constructs";

/**
 * 컨테이너 이미지 저장소.
 *
 * 저장소를 서비스 스택과 분리한 이유: 서비스 스택을 지웠다 다시 만들어도 이미지는 남아야
 * 하고, CI(GitHub Actions)가 서비스보다 먼저 이미지를 밀어 넣기 때문이다.
 */
export class RegistryStack extends Stack {
  public readonly bffRepo: ecr.Repository;
  public readonly inferenceRepo: ecr.Repository;
  /**
   * FBX converter(Blender 5.2 번들). 추론과 따로 두는 이유는 이미지가 완전히 다르기
   * 때문이다 — Blender를 포함해 1.6GB이고 amd64 전용이다. 같은 저장소에 섞으면
   * 개수 규칙(최근 100개)이 서로의 롤백 대상을 밀어낸다.
   */
  public readonly converterRepo: ecr.Repository;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // 저장소를 staging과 프로덕션이 공유한다. 개수 규칙만 두면 잦은 staging 빌드가
    // 프로덕션이 돌리고 있는 이미지를 밀어낸다 — 2026-10-08에 BFF·추론 프로덕션 이미지가
    // 이렇게 지워졌고, 이틀 뒤 태스크 교체가 CannotPullContainerError로 실패했다.
    //
    // 앱 워크플로는 main 빌드에 `latest`, develop 빌드에 `develop`을 붙이고 그 이미지를
    // 배포한다. ECR은 태그 조건에 걸린 이미지를 우선순위가 낮은 규칙으로 지우지 않으므로,
    // 앞의 두 규칙이 각 환경의 현재 이미지를 개수 규칙에서 빼낸다. 인덱스가 참조하는
    // 플랫폼·attestation 매니페스트도 인덱스가 남아 있는 동안은 지워지지 않는다.
    const lifecycleRules: ecr.LifecycleRule[] = [
      {
        rulePriority: 1,
        description: "프로덕션 현재 이미지(latest)는 남긴다",
        tagPatternList: ["latest"],
        maxImageCount: 1,
      },
      {
        rulePriority: 2,
        description: "staging 현재 이미지(develop)는 남긴다",
        tagPatternList: ["develop"],
        maxImageCount: 1,
      },
      // 나머지는 롤백 대상이다. 빌드 한 번에 인덱스·플랫폼·attestation 매니페스트로
      // 항목이 2~3개씩 생기므로 100개면 빌드 30~50번 분량이다.
      { rulePriority: 3, description: "그 밖에는 최근 100개만 보관", maxImageCount: 100 },
    ];

    const common = {
      // 스택을 지워도 이미지는 남긴다(실수로 롤백 대상을 잃지 않게).
      removalPolicy: RemovalPolicy.RETAIN,
      imageScanOnPush: true,
      lifecycleRules,
    };

    this.bffRepo = new ecr.Repository(this, "BffRepo", {
      ...common,
      repositoryName: "standin/bff",
    });

    this.inferenceRepo = new ecr.Repository(this, "InferenceRepo", {
      ...common,
      repositoryName: "standin/inference",
    });

    this.converterRepo = new ecr.Repository(this, "ConverterRepo", {
      ...common,
      repositoryName: "standin/converter",
    });
  }
}
