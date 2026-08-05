# 추론 서버 담당자 사용 안내

이 문서는 AWS IAM Identity Center(SSO) 로그인, 포즈 라이브러리 업로드, 추론 서버 적용
방법을 설명합니다. AWS CLI v2를 설치하고 명령은 **Git Bash**에서 실행합니다.

## 관리자가 전달할 정보

관리자는 배포에 사용한 AWS 계정에서 다음 명령으로 버킷·클러스터·서비스 이름과 추론
운영 정책 ARN을 확인합니다.

```bash
aws cloudformation describe-stacks \
  --stack-name StandinApp \
  --query "Stacks[0].Outputs[?OutputKey=='AssetsBucketName' || OutputKey=='ClusterName' || OutputKey=='InferenceServiceName' || OutputKey=='InferenceOperatorPolicyArn'].[OutputKey,OutputValue]" \
  --output table
```

IAM Identity Center에서 추론 팀 그룹용 권한 세트를 만들고, 출력된
`InferenceOperatorPolicyArn`의 고객 관리형 정책 `standin-inference-operator`를 연결합니다.
그룹에 AWS 계정과 권한 세트를 할당한 뒤 담당자에게 다음 정보만 전달합니다.

- SSO 시작 URL과 SSO 리전
- AWS 계정과 권한 세트 이름
- `AssetsBucketName`, `ClusterName`, `InferenceServiceName`

사람별 IAM 사용자 또는 장기 Access Key와 Secret Access Key는 만들거나 전달하지 않습니다.

## 1. 최초 로그인 설정

관리자에게 전달받은 SSO 정보로 프로필을 설정합니다.

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

## 2. 포즈 라이브러리 압축

`data` 폴더에 `poses.db`, `index.pkl`, `bvh`가 있다고 가정합니다.

```bash
tar -czf v1.tar.gz -C data poses.db index.pkl bvh
```

## 3. S3 업로드

관리자에게 전달받은 버킷 이름을 `<AssetsBucketName>`에 넣습니다.
추론 서버는 아래의 **고정 경로**에서 라이브러리를 읽으므로 파일명과 경로를 바꾸지 않습니다.

```bash
aws s3 cp v1.tar.gz \
  s3://<AssetsBucketName>/pose-library/v1.tar.gz \
  --profile standin-inference
```

업로드 여부를 확인합니다.

```bash
aws s3 ls \
  s3://<AssetsBucketName>/pose-library/v1.tar.gz \
  --profile standin-inference
```

## 4. 추론 서버에 적용

### 최초 1회: production 모드 확인

S3 라이브러리는 `StandinApp`이 `production` 모드일 때만 사용됩니다. 관리자는 최초 1회
Gemini API 키와 `rtmlib` 백엔드가 준비되었는지 확인한 뒤 다음 명령으로 배포합니다.

```bash
cd /c/workspaces/Standin-infra
npx cdk deploy StandinApp -c appEnv=production
```

`development` 모드에서는 S3 파일을 올리고 서비스를 재기동해도 합성 라이브러리가
사용됩니다. 위 production 배포는 관리자 작업이며 추론 서버 담당자 권한으로는 수행하지
않습니다.

### 업로드한 라이브러리 적용

관리자에게 전달받은 클러스터와 서비스 이름을 넣어 새 태스크를 시작합니다. 새 태스크는
기동하면서 S3의 최신 `v1.tar.gz`를 내려받습니다.

```bash
aws ecs update-service \
  --cluster <ClusterName> \
  --service <InferenceServiceName> \
  --force-new-deployment \
  --region ap-northeast-2 \
  --profile standin-inference
```

새 태스크가 정상 상태가 될 때까지 기다립니다.

```bash
aws ecs wait services-stable \
  --cluster <ClusterName> \
  --services <InferenceServiceName> \
  --region ap-northeast-2 \
  --profile standin-inference
```

명령이 오류 없이 끝나면 적용이 완료된 것입니다. 적용 순서는 항상 다음과 같습니다.

```text
v1.tar.gz 생성 → S3 고정 경로에 업로드 → ECS 강제 재배포 → 안정화 확인
```

Fargate 서버에 파일을 직접 복사하지 않습니다. 실행 중인 서버의 파일은 태스크가 교체되면
사라지므로, 라이브러리는 항상 위 S3 경로에 업로드한 뒤 서비스를 재기동합니다.
