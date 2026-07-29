# Standin 인프라 (AWS CDK)

Standin의 AWS 인프라를 코드로 관리한다. 두 서비스(BFF·추론)를 함께 배포하므로 앱 저장소와 분리했다.

```
[Tauri 데스크톱]
      │  HTTPS
      ▼
   ALB (public)
      │
      ▼
  ECS Fargate: BFF (arm64) ──Cloud Map──▶ ECS Fargate: 추론 (x86_64)
      │                                          │
      ▼                                          ▼
  RDS PostgreSQL                            S3 (포즈 라이브러리 번들)
  (isolated 서브넷)
```

## 스택 구성

| 스택 | 내용 | 왜 분리했나 |
|---|---|---|
| `StandinRegistry` | ECR 저장소 2개 | 이미지는 앱보다 오래 산다. 앱 스택을 지워도 롤백 대상이 남아야 한다 |
| `StandinCicd` | GitHub OIDC 공급자 + 배포 역할 | 앱 스택보다 먼저 있어야 CI가 이미지를 밀어 넣을 수 있다 |
| `StandinApp` | VPC·보안그룹·RDS·ECS·ALB·S3·시크릿 | 아래 참고 |

**네트워크·DB·서비스를 한 스택에 둔 이유**: 보안그룹이 세 영역에 걸쳐 서로를 참조한다(ALB → BFF → 추론/DB). 스택을 나누면 CDK가 리스너·타깃을 붙이며 보안그룹 규칙을 자동 추가하는 지점에서 순환 의존이 계속 생긴다. 이 규모에서는 한 스택이 더 단순하고 안전하다.

## 설계 결정

- **NAT Gateway 없음** (월 ~$32 절약). 태스크는 퍼블릭 서브넷 + 퍼블릭 IP로 외부(VLM API·S3)에 나가고, 인바운드는 보안그룹으로 막는다. RDS는 isolated 서브넷이라 인터넷에서 닿지 않는다.
- **공개 경계는 BFF 하나뿐.** 추론 서버는 무인증이므로(`Standin-server/docs/API_CONTRACT.md`) ALB에 붙이지 않고 Cloud Map 내부 DNS(`inference.standin.local`)로만 노출한다. 보안그룹도 BFF에서 오는 8000만 연다.
- **BFF는 arm64(Graviton), 추론은 x86_64.** BFF는 같은 성능에 더 싸고, 추론은 ONNX 런타임 호환성을 위해 x86을 유지한다.
- **자격증명은 코드에 없다.** DB 비밀번호는 CDK가 Secrets Manager에 생성하고, JWT 키도 자동 생성한다. 태스크는 IAM 역할로 S3를 읽는다.
- **GPU 전환 경로.** 포즈 백엔드를 GPU로 올리면 추론 서비스만 EC2 캐패시티 프로바이더로 옮긴다. 클러스터·ALB·BFF는 그대로다. Fargate는 GPU를 지원하지 않는다.

## 배포 순서

```bash
npm install
npx cdk bootstrap                      # 계정·리전당 1회

npx cdk deploy StandinRegistry         # 1. 이미지 저장소
npx cdk deploy StandinCicd             # 2. CI 역할 → 출력된 ARN을 GitHub 변수에 등록
#    → 앱 저장소에서 워크플로 실행(templates/ 참고)으로 이미지를 먼저 밀어 넣는다
npx cdk deploy StandinApp              # 3. 이미지가 있어야 서비스가 뜬다
```

`StandinApp`은 ECR에 `latest` 태그가 있어야 태스크가 기동한다. **2번과 3번 사이에 이미지 푸시가 반드시 들어간다.**

배포 후 출력되는 `AlbUrl`을 `cdk.json`의 `publicUrl`에 채우고 `StandinApp`을 다시 배포한다. OAuth 콜백과 이메일 인증 링크가 이 값을 쓴다.

## 배포 전에 끝내야 할 것

### 1. BFF의 DB 접속 방식 (필수)

CDK는 RDS가 만든 시크릿을 **표준 `PG*` 변수**로 주입한다(`PGHOST`/`PGPORT`/`PGUSER`/`PGPASSWORD`/`PGDATABASE`). 접속 문자열을 따로 만들어 보관하지 않기 위해서다.

`node-postgres`는 `connectionString`이 없으면 이 변수들을 자동으로 읽는다. `src/db.ts`에서 한 줄만 바꾸면 된다.

```ts
// connectionString이 비면 pg가 PG* 환경변수를 쓴다.
connectionString: config.databaseUrl || undefined,
```

이 변경 없이 배포하면 로컬 기본값(`localhost:5433`)으로 접속을 시도해 기동에 실패한다.

### 2. 포즈 라이브러리 번들 업로드

```bash
tar -czf v1.tar.gz -C data poses.db index.pkl bvh
aws s3 cp v1.tar.gz s3://<AssetsBucketName>/pose-library/v1.tar.gz
```

버킷 이름은 `StandinApp` 출력에서 확인한다. 업로드하지 않으면 추론 태스크가 기동에 실패한다(프로덕션에서는 합성 라이브러리로 대체하지 않는다).

`requirements.txt`의 `boto3` 주석도 해제해야 `s3://`를 받을 수 있다.

### 3. 소셜 로그인 키

`standin/oauth` 시크릿에 아래 키로 값을 채운다. 비어 있으면 태스크가 기동하지 못한다.

```json
{
  "googleClientId": "", "googleClientSecret": "",
  "kakaoClientId": "", "kakaoClientSecret": "",
  "naverClientId": "", "naverClientSecret": ""
}
```

각 provider 콘솔의 Redirect URI도 `{AlbUrl}/v1/auth/oauth/{provider}/callback`로 등록한다.

### 4. VLM API 키

추론 태스크는 `APP_ENV=production`이라 mock 백엔드로 뜨지 않는다. `VLM_PROVIDER=gemini`에 맞는 `GEMINI_API_KEY`를 시크릿으로 추가하고 `lib/app-stack.ts`의 추론 컨테이너에 연결해야 한다. **현재 스캐폴드에는 이 연결이 비어 있다.**

## CI/CD

`templates/`의 워크플로를 각 앱 저장소의 `.github/workflows/deploy.yml`로 복사한다.

- `deploy-bff.yml` → `Standin-app-server`
- `deploy-inference.yml` → `Standin-server`

저장소 변수 두 개가 필요하다(Settings → Secrets and variables → Actions → Variables):

| 변수 | 값 |
|---|---|
| `AWS_REGION` | `ap-northeast-2` |
| `AWS_DEPLOY_ROLE` | `StandinCicd` 스택의 `DeployRoleArn` 출력 |

장기 액세스 키를 만들지 않는다 — GitHub이 실행마다 발급하는 OIDC 토큰으로 역할을 assume한다.

## 비용 (서울 리전 대략, 유휴 기준)

| 항목 | 월 |
|---|---|
| Fargate BFF (0.5 vCPU / 1 GB, arm64) | ~$15 |
| Fargate 추론 (1 vCPU / 2 GB) | ~$36 |
| ALB | ~$16 |
| RDS t4g.micro + 20GB | ~$12 (첫 12개월 프리티어 가능) |
| S3 · ECR · CloudWatch · Secrets Manager | ~$3 |
| **합계** | **~$80** |

NAT Gateway를 뺀 구성이다. 넣으면 ~$32가 더 든다.

## 알려진 한계

- **HTTPS 미설정.** ALB가 80만 연다. 도메인과 ACM 인증서가 준비되면 443 리스너로 바꾸고 80은 리다이렉트해야 한다. **그 전까지 토큰이 평문으로 오간다 — 실사용자를 받기 전에 반드시 처리할 것.**
- **단일 태스크·단일 AZ.** `desiredCount: 1`, RDS `multiAz: false`. 가용성이 필요해지면 올린다.
- **Job 유실.** BFF의 분석 Job이 아직 프로세스 내 fire-and-forget이라 배포·태스크 교체 시 진행 중 작업이 사라진다. SQS로 옮기기 전까지의 감수 사항이다.
- **RDS `removalPolicy: SNAPSHOT`, `deletionProtection: false`.** 초기 단계 설정이다. 실사용자가 생기면 `RETAIN` + 삭제 보호로 바꿀 것.
- **환경 분리 없음.** dev/prod 스택 분리는 넣지 않았다. 필요해지면 스택 이름과 컨텍스트를 환경별로 나눈다.
