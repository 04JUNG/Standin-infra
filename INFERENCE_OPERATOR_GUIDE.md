# 추론 서버 담당자 사용 안내

포즈 라이브러리를 추론 서버에 배포하는 방법입니다. AWS CLI v2를 설치하고 명령은
**Git Bash**에서 실행합니다.

배포는 `Standin-server` 저장소의 스크립트 하나로 끝납니다. 검증 → 압축 → 업로드 →
재기동 → 확인을 순서대로 하고, 번들이 잘못됐으면 **업로드 자체를 하지 않습니다.**

```bash
python scripts/deploy_pose_library.py data/
```

## 관리자가 전달할 정보

관리자는 배포에 사용한 AWS 계정에서 다음 명령으로 버킷·클러스터·서비스 이름과 추론
운영 정책 ARN을 확인합니다.

```bash
aws cloudformation describe-stacks \
  --stack-name StandinApp \
  --query "Stacks[0].Outputs[?OutputKey=='AssetsBucketName' || OutputKey=='ClusterName' || OutputKey=='InferenceServiceName' || OutputKey=='InferenceLogGroupName' || OutputKey=='InferenceOperatorPolicyArn'].[OutputKey,OutputValue]" \
  --output table
```

IAM Identity Center에서 추론 팀 그룹용 권한 세트를 만들고, 출력된
`InferenceOperatorPolicyArn`의 고객 관리형 정책 `standin-inference-operator`를 연결합니다.
그룹에 AWS 계정과 권한 세트를 할당한 뒤 담당자에게 다음 정보만 전달합니다.

- SSO 시작 URL과 SSO 리전
- AWS 계정과 권한 세트 이름
- `InferenceLogGroupName` (로그를 볼 때만 필요합니다. 4장 참고)

버킷·클러스터·서비스 이름은 스크립트에 기본값으로 들어 있어 담당자가 외울 필요가 없습니다.
스택을 다시 만들어 이름이 바뀌었다면 위 명령의 출력값을 담당자에게 알려주고, 담당자는
환경변수로 덮어씁니다(맨 아래 '이름이 바뀐 경우' 참고).

사람별 IAM 사용자 또는 장기 Access Key와 Secret Access Key는 만들거나 전달하지 않습니다.

## 1. 최초 1회 설정

### SSO 로그인

관리자에게 전달받은 SSO 정보로 프로필을 설정합니다. 프로필 이름은 스크립트 기본값과
같은 `standin-inference`로 만듭니다.

```bash
aws configure sso --profile standin-inference
```

안내에 따라 SSO 시작 URL, SSO 리전, AWS 계정과 권한 세트를 선택하고 기본 리전은
`ap-northeast-2`로 설정합니다. 설정이 끝나면 로그인하고 현재 자격증명을 확인합니다.

```bash
aws sso login --profile standin-inference
aws sts get-caller-identity --profile standin-inference
```

세션이 만료되면 `aws sso login --profile standin-inference`를 다시 실행합니다.

### 스크립트 준비

```bash
git clone https://github.com/04JUNG/Standin-server
cd Standin-server
pip install numpy boto3
```

### production 모드 확인 (관리자 작업)

S3 라이브러리는 `StandinApp`이 `production` 모드일 때만 사용됩니다. `development`
모드에서는 파일을 올리고 재기동해도 합성 라이브러리가 사용됩니다.

```bash
cd /c/workspaces/Standin-infra
npx cdk deploy StandinApp -c appEnv=production
```

이 배포는 관리자 작업이며 추론 서버 담당자 권한으로는 수행하지 않습니다.

## 2. 배포

`data` 폴더에 `poses.db`, `bvh/`, `thumbs/`가 있다고 가정합니다.

```bash
aws sso login --profile standin-inference     # 세션이 살아 있으면 생략
python scripts/deploy_pose_library.py data/
```

정상이면 이렇게 진행됩니다.

```text
[1/5] 번들 검증              (C:\...\data)
      feature_version  1 == src/repo.py 규격                  OK
      view             back, front, side, three_quarter       OK
      포즈             1307개 · 투영 5228개                   OK
      bvh              1307개 · DB↔파일 누락 0                OK
      feature_blob     빈 값 0 · 길이 균일(136B)              OK
      thumbs           5228개 · 누락 0                        OK
[2/5] 압축                   11.2 MiB
[3/5] 업로드                 s3://<AssetsBucketName>/pose-library/v1.tar.gz
[4/5] 추론 서비스 재기동      force-new-deployment
[5/5] 안정화 대기            최대 10분
      완료                   134초

배포 완료 — 새 태스크가 헬스체크를 통과했습니다.
  /healthz는 포즈가 0개면 503을 주므로, 통과 = 새 번들이 로드됐다는 뜻입니다.
  직전 번들 VersionId: p2zJuUeitVIhHkgepeQlCnQHCZmnL0mS
  되돌리려면: python scripts/deploy_pose_library.py --rollback
```

마지막 줄이 곧 검증입니다. 추론 서버 `/healthz`는 포즈가 0개면 503을 반환하고 ECS가 그
응답으로 태스크를 판정하므로, **안정화 성공 = 새 번들이 실제로 로드됐다는 증거**입니다.
CloudWatch 로그를 따로 확인할 필요가 없습니다.

### 올리기 전에 검증만 하기

```bash
python scripts/deploy_pose_library.py data/ --dry-run
```

### 검증에 걸렸을 때

업로드하지 않고 중단하므로 **실행 중인 서비스는 그대로**입니다.

```text
      feature_version  [2] != [1]                             FAIL

중단합니다. 번들 검증 실패:
  - feature_version 불일치([2] != [1]). DB를 재빌드하세요: python scripts/build_db.py
```

주요 검사 항목과 통과하지 못했을 때 실제로 생기는 일:

| 항목 | 막지 못하면 |
|---|---|
| `feature_version` | 서버가 기동을 거부합니다(정규화 규격 불일치) |
| `view` 값 | 서버가 기동 중 `ValueError`로 죽습니다 |
| 투영 없는 포즈 | 그 포즈는 검색 결과에 영원히 안 나옵니다 |
| `bvh` 파일 누락 | `/pose/{id}/bvh` 핸드오프가 404가 됩니다 |
| `feature_blob` 길이 | 검색(kNN)이 조용히 잘못된 결과를 냅니다 |
| `thumbs` 누락 | **에러 없이 썸네일만 사라집니다** |

썸네일 없이 배포해야 하는 사정이 있으면 `--allow-missing-thumbs`를 붙입니다.

## 3. 되돌리기

버킷에 버저닝이 켜져 있어 이전 번들이 남아 있습니다. 버전 ID를 찾을 필요 없이:

```bash
python scripts/deploy_pose_library.py --rollback
```

되돌릴 대상(날짜·크기·VersionId)을 보여주고 확인을 받은 뒤, 복원과 재기동까지 합니다.

## 4. 로그 보기

배포는 로그를 보지 않아도 끝납니다(2장). 로그가 필요한 때는 **안정화에 실패했을 때**뿐입니다
— 실패는 "새 번들이 로드되지 않았다"는 사실만 알려 주고, 이유는 컨테이너 로그에만 있습니다.

관리자에게 받은 `InferenceLogGroupName`을 넣고 실행합니다.

```bash
aws logs tail <InferenceLogGroupName> --since 30m --profile standin-inference
```

배포하면서 실시간으로 보려면 `--follow`를 붙입니다. 다른 창에서 배포 스크립트를 돌립니다.

```bash
aws logs tail <InferenceLogGroupName> --since 5m --follow --profile standin-inference
```

기동 실패 원인은 대개 마지막 수십 줄에 그대로 찍힙니다.

| 로그에 보이는 것 | 뜻 |
|---|---|
| `feature_version mismatch` | DB 규격이 서버와 다릅니다. `build_db.py`로 재빌드합니다 |
| `ValueError: unknown view ...` | `view` 값에 오타가 있습니다 |
| `pose library ... not found` / S3 오류 | 번들이 올라가지 않았거나 경로가 다릅니다 |
| `/healthz 503` 반복 | 포즈 0개로 기동했습니다. 번들 내용이 비어 있습니다 |

원인을 알 수 없으면 **되돌린 뒤**(3장) 로그 마지막 부분을 그대로 복사해 관리자에게 보냅니다.

### 볼 수 있는 범위

권한은 **추론 컨테이너 로그 그룹 하나**에만 열려 있습니다. BFF·데이터베이스 로그에는
사용자 데이터가 흐르므로 열지 않습니다. 웹 콘솔에서 보고 싶으면 CloudWatch → 로그 그룹에서
위 이름을 찾습니다. 다른 그룹은 이름만 보이고 열리지 않습니다.

## 참고

### 안정화에 실패했다면

이전 태스크가 계속 서비스 중이라 장애는 아니지만 새 번들은 적용되지 않은 상태입니다.
`--rollback`으로 직전 번들로 되돌린 뒤 관리자에게 알립니다. 이유는 추론 컨테이너 로그에
남아 있습니다(4장).

### 이름이 바뀐 경우

스택을 다시 만들어 버킷·클러스터·서비스 이름이 바뀌면 환경변수로 덮어씁니다.

```bash
export POSE_LIBRARY_BUCKET=<AssetsBucketName>
export ECS_CLUSTER=<ClusterName>
export ECS_SERVICE=<InferenceServiceName>
python scripts/deploy_pose_library.py data/
```

### 하지 않는 것

Fargate 서버에 파일을 직접 복사하지 않습니다. 실행 중인 서버의 파일은 태스크가 교체되면
사라지므로, 라이브러리는 항상 S3 고정 경로에 업로드한 뒤 서비스를 재기동합니다. 스크립트가
이 순서를 그대로 수행합니다.

```text
검증 → 압축 → S3 고정 경로 업로드 → ECS 강제 재배포 → 안정화 확인
```
