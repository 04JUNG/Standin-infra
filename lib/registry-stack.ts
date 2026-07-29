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

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const common = {
      // 스택을 지워도 이미지는 남긴다(실수로 롤백 대상을 잃지 않게).
      removalPolicy: RemovalPolicy.RETAIN,
      imageScanOnPush: true,
      lifecycleRules: [
        {
          description: "태그 없는 이미지는 하루 뒤 정리",
          tagStatus: ecr.TagStatus.UNTAGGED,
          maxImageAge: undefined,
          maxImageCount: undefined,
        },
      ],
    };

    this.bffRepo = new ecr.Repository(this, "BffRepo", {
      ...common,
      repositoryName: "standin/bff",
      lifecycleRules: [
        { description: "최근 20개만 보관", maxImageCount: 20 },
      ],
    });

    this.inferenceRepo = new ecr.Repository(this, "InferenceRepo", {
      ...common,
      repositoryName: "standin/inference",
      lifecycleRules: [
        { description: "최근 20개만 보관", maxImageCount: 20 },
      ],
    });
  }
}
