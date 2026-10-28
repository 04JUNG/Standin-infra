# v4 장면 자동 보정: 스테이징 준비 및 활성화

기존 개별 `/refine`과 별개인 `src.scene_refinement` 실행 환경이다.
앱서버와 클라이언트의 기존 v4 계약을 사용하며 `/analyze` 설정이나 제한 시간은 바꾸지 않는다.
기본 설정에서는 worker 리소스와 BFF 환경 변수가 추가되지 않는다. 운영 환경에서는 활성화를 거부한다.

## 추가되는 리소스

- `standin/scene-worker` ECR: 커밋 SHA 태그, 덮어쓰기 금지, 자동 만료 없음.
- 전용 X86_64 Fargate task: 4 vCPU / 8 GiB / scratch 30 GiB, 단일 프로세스·서비스 1개.
- EFS와 access point: 암호화·TLS·IAM mount, worker는 읽기만 가능.
- 1회 실행용 release publisher task: 지정된 S3 번들만 읽고 검증 후 EFS에 게시. 자동 실행하지 않는다.
- 별도 worker token: Secrets Manager가 48자를 생성하고 BFF와 worker에 동일한 값을 주입한다.
  Gemini 키는 기존 스테이징 VLM secret을 재사용한다. 비밀 값은 코드·Outputs·GitHub Variables에 넣지 않는다.
- 전용 GitHub OIDC 배포 역할: Standin-server + staging environment만 신뢰한다.
  GitHub staging environment의 허용 배포 브랜치를 develop로 제한해야 한다.
- 자산 게시용 관리형 정책: 특정 S3 object, publisher task 및 역할, 스테이징 worker 조회에 한정한다.
  사람이나 CI에 자동 연결하지 않는다. 최초 인프라 배포 후 관리자가 지정한 운영자에게 연결한다.

서비스에는 ALB/public DNS를 붙이지 않는다. TCP 8002 ingress는 BFF 보안 그룹에서만 허용한다.
기존 VPC에 NAT가 없으므로 다른 기존 태스크와 동일하게 public subnet/public IP를 **outbound용**으로 쓴다.
인터넷에서 들어오는 규칙은 없다. private subnet+NAT가 필요하면 별도 네트워크 변경으로 검토한다.
EFS NFS는 worker/publisher 두 보안 그룹만 접근한다.

## 자산 계약

`config/staging-scene-worker.example.json`을 별도 운영자 설정 파일로 복사하고 실제 값을 채운다.
예시의 placeholder는 합성을 통과하지 않는다.

| 필드 | 실제 값 |
| --- | --- |
| releaseId | 새 불변 release 디렉터리 이름 |
| manifestSha256 | 검토를 마친 `release.json` SHA256 |
| bundleKey | 기존 스테이징 assets bucket의 `scene-releases/*.tar.gz` object key |
| bundleSha256 | 업로드할 tar.gz 전체 SHA256 |
| imageTag | Standin-server develop의 전체 40자리 커밋 SHA |
| vlmModel | 사용할 Gemini model ID |

번들은 최상위에 `release.json`과 inventory에 포함된 파일을 담는다(불필요한 상위 디렉터리 없음).
준비 방식과 모델/rig 제약은 Standin-server의 `docs/scene-worker-staging.md`를 따른다.
publisher는 worker 이미지의 실제 `verify_release`를 호출하여 승인·파일 해시·catalog/BVH·rig·CLIP·
HumanArt metadata를 확인한다. archive hash만 맞는 미검토 번들은 게시하지 않는다.
심볼릭 링크·hard link·장치 파일·경로 탈출·중복 파일을 거부하고 기존 release를 교체하지 않는다.

현재 확인한 로컬 HumanArt manifest는 `candidate`, 검토 `pending`, calibration hash 미고정이다.
이를 승인 완료로 바꿔치기하지 않았다. 배포할 실제 검토·보정 프로필이 포함된 새 release가 필요하다.
또한 v4는 현재 지원하는 hash-bound calibrated rig를 요구하므로 현재 body release와의 호환을 smoke에서 확인해야 한다.

## 실행 순서

아래는 **배포 절차**이며 코드 테스트 통과가 AWS 배포 완료를 뜻하지 않는다.
기존 staging body/library/image context를 유지하고 `cdk diff`로 관련 없는 변경이 없는지 먼저 확인한다.
특히 실행 중인 `JOB_EXECUTION_MODE`, BFF/Converter image, body release, 기존 수동 환경 변수를
실제 task definition과 대조해야 한다. 아래 명령은 전체 기존 context를 대체하는 복사·실행용 명령이 아니다.
worker 외의 변경이나 기존 기능 비활성화가 diff에 나오면 배포하지 않고 운영자 context부터 맞춘다.
`stagingActive=true`를 빠뜨리면 기존 staging 서비스가 내려갈 수 있으므로 명시한다.

1. release 검토·번들 SHA를 확정한다. 권한 있는 인프라 배포 역할로 우선 task 0개를 준비한다.
   `standin/scene-worker`나 같은 이름의 token이 이미 수동 생성돼 있다면 먼저 소유 stack을
   확인하고 import 계획을 세운다. 이름 충돌을 해결하려고 기존 리소스를 삭제하지 않는다.

   ```sh
   npx cdk diff StandinStagingApp -c envName=staging -c stagingActive=true \
     -c stagingSceneWorkerConfig=/operator/staging-scene-worker.json
   npx cdk deploy StandinStagingApp -c envName=staging -c stagingActive=true \
     -c stagingSceneWorkerConfig=/operator/staging-scene-worker.json
   ```

2. Stack Outputs를 Standin-server의 **staging environment** Variables에 넣는다.
   `SCENE_AWS_DEPLOY_ROLE=SceneWorkerDeployRole`, `SCENE_ECS_CLUSTER=SceneWorkerCluster`,
   `SCENE_ECS_SERVICE=SceneWorkerService`, `AWS_REGION=ap-northeast-2`.
   주소와 token ARN은 BFF에 CDK로 연결되므로 별도 값을 복사하지 않는다.

3. Standin-server의 기존 `Deploy converter` 워크플로를 develop에서 실행한다.
   `target=scene-worker`, `deploy_staging=false`로 먼저 이미지만 만든다.
   설정 파일의 imageTag는 이 빌드의 SHA와 일치해야 한다.
   동일 SHA 재배포에는 이미 발행한 이미지를 재사용하는 worker workflow 변경도 필요하다.
   main 워크플로 등록/수정은 필요 없다.

4. 지정된 object key로 번들을 업로드하고 `ScenePublisherTask`를 수동 `ecs run-task`로 실행한다.
   Outputs의 cluster, publisher security group 및 해당 VPC public subnet을 사용하고
   Fargate public IP를 켠다. exit code 0과 `Scene release: published` 또는 `already_published`를 확인한다.
   실패한 자산을 승인 상태로 바꿔 시작 검사를 우회하지 않는다.

5. worker를 1개 켜되 BFF의 v4 노출은 아직 false로 둔다.

   ```sh
   npx cdk deploy StandinStagingApp -c envName=staging -c stagingActive=true \
     -c stagingSceneWorkerConfig=/operator/staging-scene-worker.json \
     -c stagingSceneWorkerActive=true
   ```

   ECS 안정화와 `/readyz` 통과를 확인한다. `/healthz`만으로는 부족하다.
   readiness는 Gemini 접근·quota·실제 품질까지 보장하지 않으므로 신선한 plan/build smoke가 필요하다.

6. 제한된 스테이징 실험을 위해 동일 명령에 `-c stagingSceneRefinementEnabled=true`를 추가한다.
   BFF에 `SCENE_EXPORT_ENABLED=true`, `SCENE_REFINEMENT_ENABLED=true`, 내부 URL,
   동일 Secret 및 900000ms budget이 반영된다. 기존 beta bucket을 receipt 저장에 사용한다.
   p060/p220/p0718을 새로 분석하고 prepare→미리보기→저장 SHA 및 실제 CSP 결과를 비교한다.
   합친 파일 수와 포함 인원, 방향/범위/팔/관계, 위치/크기, CSP 카메라 적용 여부를 각각 기록한다.
   수동 자세·위치·카메라 보정으로 성공 결과를 만들지 않는다.

## 중지 / 되돌리기

문제가 있으면 동일 release 설정을 유지한 채 `stagingSceneRefinementEnabled=false`로 BFF 노출부터 끈다.
그 다음 `stagingSceneWorkerActive=false`로 worker task만 0개로 낮춘다.
이미 만들었던 리소스에서 config 자체를 제거하면 EFS·repo·secret에 삭제/보존 처리가 걸리므로
롤백으로 설정 파일을 제거하지 않는다. 파일 시스템과 이미지는 RETAIN이다.
새 release는 새 ID·해시·object key를 사용한다. EFS의 기존 release 내용은 수정하지 않는다.

## 확인 범위 / 미완료

- 로컬: 타입 검사, CloudFormation 합성, 기본 prod/staging 템플릿 대조,
  staging 전용 guard·IAM·EFS·secret·실행 토글, archive 공격/게시 검증.
- 미완료: 실제 AWS 리소스 생성, 검토된 자산 release, 이미지 빌드/게시, Linux 전체 모델 시작,
  Gemini 실제 호출, BFF plan/build/save, 사용자 앱 및 CSP 재검증.
- 현재 작업자의 AWS identity는 ECS 조회·ECR 조회·CloudFormation DescribeStacks도 권한 거부됐다.
  기존 인프라 배포 역할을 쓰도록 관리자에게 맡기거나, 승인된 역할 ARN과 AssumeRole 권한이 필요하다.
  이 코드가 사람의 AWS 권한을 자동으로 늘리지는 않는다.
- 한 FBX의 상대 위치와 CSP 화면상의 정확한 구도는 별개다. capture mapping과 camera recipe의
  전파·적용 문제까지 해결됐다고 주장하지 않는다.
