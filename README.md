# Standin 인프라 (AWS CDK)

Standin의 AWS 인프라를 코드로 관리한다. 두 서비스(BFF·추론)를 함께 배포하므로 앱 저장소와 분리했다.

## 현재 AWS 아키텍처

[![Standin AWS 아키텍처](docs/architecture/standin-aws-architecture.png)](docs/architecture/standin-aws-architecture.html)

> `Standin-infra`의 현재 CDK 선언 기준이다. 이미지를 클릭하면 확대 가능한 다이어그램을 볼 수 있다.
>
> 관측성은 CloudWatch 대신 **구조화 로그 → BFF 자체 집계 → 디스코드 알림**으로 간다. CloudWatch는 컨테이너 로그(14일)와 Container Insights만 남기고 일상적으로 열지 않는다. 아래 「인프라 이벤트 알림」·「로그 출하 경로」·「운영 대시보드」 절과 마스터독스의 「관측성 — 로그·모니터링·디스코드 알림」 참고. 다이어그램에는 EventBridge·Lambda·외부 감시자가 아직 반영되지 않았다.

## 스택 구성

| 스택 | 내용 | 왜 분리했나 |
|---|---|---|
| `StandinRegistry` | ECR 저장소 3개(bff·inference·converter) | 이미지는 앱보다 오래 산다. 앱 스택을 지워도 롤백 대상이 남아야 한다 |
| `StandinCicd` | GitHub OIDC 공급자 + 배포 역할 | 앱 스택보다 먼저 있어야 CI가 이미지를 밀어 넣을 수 있다 |
| `StandinApp` | VPC·보안그룹·RDS·ECS·ALB·S3·시크릿 (프로덕션) | 아래 참고 |
| `StandinStagingApp` | 같은 구성의 테스트 환경 | 프로덕션에 바로 배포하지 않기 위해. 「[테스트 환경(staging)](#테스트-환경staging)」 참고 |

`StandinRegistry`와 `StandinCicd`는 **두 환경이 공유한다.** ECR을 나누지 않는 이유는, staging에서 검증한 그 이미지 SHA를 그대로 프로덕션에 올려야 검증이 의미가 있기 때문이다 — 저장소가 갈리면 "staging에서 통과한 이미지"와 "프로덕션에 올라간 이미지"가 다른 빌드일 수 있다.

**네트워크·DB·서비스를 한 스택에 둔 이유**: 보안그룹이 세 영역에 걸쳐 서로를 참조한다(ALB → BFF → 추론/DB). 스택을 나누면 CDK가 리스너·타깃을 붙이며 보안그룹 규칙을 자동 추가하는 지점에서 순환 의존이 계속 생긴다. 이 규모에서는 한 스택이 더 단순하고 안전하다.

## 설계 결정

- **NAT Gateway 없음** (월 ~$32 절약). 태스크는 퍼블릭 서브넷 + 퍼블릭 IP로 외부(VLM API·S3)에 나가고, 인바운드는 보안그룹으로 막는다. RDS는 isolated 서브넷이라 인터넷에서 닿지 않는다.
- **공개 경계는 BFF 하나뿐.** 추론 서버는 무인증이므로(`Standin-server/docs/API_CONTRACT.md`) ALB에 붙이지 않고 Cloud Map 내부 DNS(`inference.standin.local`, staging은 `inference.standin-staging.local`)로만 노출한다. 보안그룹도 BFF에서 오는 8000만 연다.
- **ALB에서 HTTPS 종료.** `api.standinpose.com`을 ALB에 CNAME으로 연결하고 서울 리전 ACM 인증서를 443 리스너에 붙인다. 80은 443으로 영구 리디렉트하며 CloudFront는 사용하지 않는다.
- **BFF는 arm64(Graviton), 추론은 x86_64.** BFF는 같은 성능에 더 싸고, 추론은 ONNX 런타임 호환성을 위해 x86을 유지한다.
- **자격증명은 코드에 없다.** DB 비밀번호는 CDK가 Secrets Manager에 생성하고, JWT 키도 자동 생성한다. 태스크는 IAM 역할로 S3를 읽는다.
- **GPU 전환 경로.** 포즈 백엔드를 GPU로 올리면 추론 서비스만 EC2 캐패시티 프로바이더로 옮긴다. 클러스터·ALB·BFF는 그대로다. Fargate는 GPU를 지원하지 않는다.
- **두 서비스 모두 항상 무중단 롤링이다**(min/max 100/200 + AZ 재분산). 예전에는 refine이 켜지면 추론만 0/100 단일 태스크 교체로 바꿨는데, 조정본 전달 방식이 바뀌면서 그 제약이 사라졌다(#13). `scripts/assert-refine-flags.mjs`가 회귀를 막는다.

## refine (포즈 미세조정) 운영

추론 서버가 선택된 후보를 러프에 맞춰 조정할 수 있다. 인프라 관점의 요점은 세 가지다.

### 1. 조정본은 BFF가 소유한다

추론이 만든 조정본 BVH는 **그 태스크의 로컬 디스크**에 있다. BFF가 `POST /refine` 직후
바로 받아서 `betaData` 버킷의 `installations/{id}/jobs/{jobId}/refined/...`에 넣고, 이후
다운로드는 S3에서만 읽는다. 태스크가 교체돼도 저장된 포즈를 계속 내려받을 수 있어야 하기 때문이다.

새 버킷도, 새 IAM도 만들지 않았다. 경로가 `installations/` 아래라 기존 KMS 암호화,
90일 lifecycle, 동의 철회 시 삭제 스윕, `betaData.grantReadWrite(bffTask.taskRole)`가
그대로 적용된다. 쓰는 쪽은 BFF뿐이므로 **추론 태스크에는 S3 쓰기 권한을 주지 않는다.**

### 2. 배포 설정은 refine과 무관하다 (다운타임 없음)

추론·BFF 모두 `minHealthyPercent: 100` / `maxHealthyPercent: 200` + AZ 재분산으로 **항상
무중단 롤링**한다. refine 플래그가 이 값을 바꾸지 않는다.

예전에는 refine이 켜지면 추론을 `0 / 100` 단일 태스크 교체로 전환했다. 조정본이 생성된
로컬 태스크에서 BFF가 곧바로 GET해야 했고, 구·신 태스크가 함께 Cloud Map에 등록되면 그
GET이 조정본을 갖지 않은 쪽에 닿아 404가 났기 때문이다. 대가로 배포 중 추론이 수십 초~2분
끊겼다.

이제 추론 서버가 `/refine` 응답에 BVH 본문을 실어 보내므로 **두 번째 요청 자체가 없다**
(`Standin-server/docs/REFINE_HANDOFF.md` §3). 로컬 디스크에 의존하는 경로가 사라져 태스크
공존이 무해해졌고, 무중단 롤링으로 되돌렸다(#13). `assert-refine-flags.mjs`가 100/200과
AZ 재분산을 상수로 못 박아 회귀를 막는다.

### 3. flag는 두 개이고 프로덕션은 둘 다 on

| 서비스 | 변수 | 현재 값 |
|---|---|---|
| 추론 | `REFINE_ENABLED` | `1` |
| 추론 | `REFINE_MOVE_GATE` | `0` (P2 이동량 하드 게이트 보류, 진단은 기록) |
| 추론 | `REFINE_COLLISION_GATE` | `1` (P3a 손·전완-몸통 관통 복구) |
| BFF | `REFINE_FEATURE_ENABLED` | `true` |
| BFF | `REFINE_TIMEOUT_MS` | `5000` |

두 배포 플래그는 CDK context로 제어한다. **`cdk.json`의 값이 실제 배포된 상태와 같아야 한다** —
아래 「cdk.json은 배포 상태의 사본이다」 참고.

| CDK context | `cdk.json` | ECS 환경변수 |
|---|---|---|
| `refineEnabled` | `true` | 추론 `REFINE_ENABLED=0|1` |
| `refineFeatureEnabled` | `true` | BFF `REFINE_FEATURE_ENABLED=false|true` |

코드 기본값(`bin/standin.ts`)은 둘 다 `false`다. 단계적으로 켜던 시절의 안전 기본값이며,
지금은 `cdk.json`이 명시적으로 `true`를 준다.

`refineFeatureEnabled=true`는 `refineEnabled=true`와 함께만 허용된다. BFF 노출만
단독으로 켜면 synth 단계에서 실패한다.

```bash
# 1. 코드와 저장소만 배포 — 사용자와 추론 모두 off
npx cdk deploy StandinApp -c appEnv=production -c publicUrl=https://api.standinpose.com -c refineEnabled=false -c refineFeatureEnabled=false

# 2. 내부 canary — 추론만 on, 사용자는 off
npx cdk deploy StandinApp -c appEnv=production -c publicUrl=https://api.standinpose.com -c refineEnabled=true -c refineFeatureEnabled=false

# 3. E2E 통과 후 사용자 공개
npx cdk deploy StandinApp -c appEnv=production -c publicUrl=https://api.standinpose.com -c refineEnabled=true -c refineFeatureEnabled=true
```

두 flag는 별개다. 추론 endpoint가 살아 있어도 BFF flag가 꺼져 있으면 클라이언트에 노출되지
않는다(BFF가 분석 응답의 `capabilities.refine`으로 알려 준다). 추론의 코드 기본값은
`REFINE_ENABLED=1`이므로 **반드시 스택에서 명시한다** — 적어 두지 않으면 검증 전에 켜진 채로 뜬다.

켜는 순서:

1. BFF 배포 (flag off) — 구·신 추론 응답을 모두 받는다
2. 클라이언트 배포 (flag off) — fallback UX만 먼저 나간다
3. 추론 배포 (`REFINE_ENABLED=0`) — 스켈레톤 보완만 smoke test
4. staging에서 조정본 영속화와 export 검증
5. 추론 → BFF 순으로 flag on

## 사용량 제한 운영 (오픈베타)

BFF는 로그인 없이 설치 단위로 쓰이므로 서버가 사용량을 강제한다. 카운터 정본은 RDS
(`usage_counters` 테이블)라 다중 태스크·재배포에도 유지된다. 정책값은 task definition의
환경변수로 노출돼 있어 **앱 코드를 고치지 않고 `cdk deploy`만으로 조정**할 수 있다.

| ECS 환경변수 | 현재 값 | 의미 |
|---|---:|---|
| `QUOTA_INSTALLATION_DAILY` | `10` | 설치별 일일 분석 횟수(KST 자정 리셋) |
| `QUOTA_INSTALLATION_CONCURRENT` | `1` | 설치별 동시 분석 개수 |
| `QUOTA_GLOBAL_DAILY` | `400` | 서비스 전체 일일 상한. 오픈베타 계획 §4-2 산식의 잠정치(단가 실측 후 확정) |
| `ANALYSIS_STALE_AFTER_SECONDS` | `300` | 이 시간 넘게 진행 중인 Job은 유실로 보고 정리 |
| `RATE_IP_REGISTER` / `_WINDOW` | `5` / `3600` | IP별 설치 발급 burst |
| `RATE_IP_ANALYZE` / `_WINDOW` | `5` / `60` | IP별 분석 요청 burst |
| `TRUSTED_PROXY_HOPS` | `0` | XFF에서 client IP 오른쪽의 신뢰 주소 수 |
| `IP_HASH_SALT` | Secrets Manager | IP 해시 솔트(`standin/<env>/ip-hash-salt`, 자동 생성) |

`QUOTA_GLOBAL_DAILY`를 빼면 앱의 코드 기본값과 같은 값이다 — 목적은 운영 중 조정할 손잡이를 만드는 것이다.
0 이하는 앱이 "제한 없음"으로 읽는다.

### ⚠ `TRUSTED_PROXY_HOPS`는 요청 체인에 묶여 있다

체인이 `클라 → ALB → BFF`이고 ALB는 자신이 관측한 client IP를 XFF 오른쪽 끝에
append한다. ALB 자신은 XFF에 들어가지 않으므로 client IP 오른쪽의 주소 수는 **0**이다.
클라가 보낸 왼쪽 XFF는 위조 가능하지만 오른쪽 끝의 ALB 관측값은 바뀌지 않는다. WAF나
다른 프록시를 앞에 넣어 client IP 오른쪽에 주소가 추가되면 이 값도 함께 바꾼다.

IP는 원문을 저장하지 않는다 — `sha256(salt + IP)`만 카운터 키로 쓰고, IPv6는 `/64`로 묶는다.
솔트를 교체하면 진행 중인 IP 카운터가 리셋된다(창이 최대 1시간이라 영향은 작다).

### 운영자 kill switch

분석을 즉시 중단·재개하는 스위치는 **인프라가 아니라 DB**(`service_flags`)에 있다. 재배포가
필요 없고 전 태스크에 최대 5초 안에 전파된다. 조작은 BFF의 관리자 API로 한다 —
`Standin-app-server/README.md`의 「Kill switch」 절 참고. 토큰은
`standin/<env>/beta-review-token` 시크릿이다.

## cdk.json은 배포 상태의 사본이다

`cdk.json`의 context 값은 **실제로 배포된 스택과 같아야 한다.** `-c`로 넘긴 값만 맞고
파일은 다른 값을 담고 있으면, 다음 사람이 `-c` 없이 `cdk deploy`를 돌리는 순간 그 차이가
그대로 프로덕션에 적용된다.

| context | 값 | 틀리면 무슨 일이 나나 |
|---|---|---|
| `appEnv` | `production` | `development`면 실서비스가 **mock VLM·합성 포즈 라이브러리로 뒤집힌다** |
| `publicUrl` | `https://api.standinpose.com` | 비면 OAuth 콜백과 이메일 인증 링크가 깨진다 |
| `certificateArn` | 서울 리전 ACM 인증서 ARN | 발급 완료된 인증서가 아니면 443 리스너 배포가 실패한다 |
| `refineEnabled` | `true` | `false`면 refine이 꺼진다(배포는 항상 무중단이라 다운타임은 없다) |
| `refineFeatureEnabled` | `true` | `false`면 클라이언트에서 refine이 사라진다 |
| `envName` | `prod` | `staging`이면 `StandinStagingApp`을 만든다. **파일에 `staging`을 커밋해 두면 다음 사람의 무인자 배포가 프로덕션이 아니라 staging으로 나간다** |
| `stagingActive` | `false` | `true`면 staging Fargate 태스크가 계속 떠 있어 월 ~$51이 더 나간다 |
| `imageTag` | `latest` | staging과 같은 값이면 `cdk deploy`가 엉뚱한 환경의 이미지를 끌어온다 |
| `converterEnabled` | `false` | `true`면 converter 서비스가 생긴다. 캐릭터 아티팩트가 없으면 태스크 교체 루프에 빠진다 |
| `fbxExportEnabled` | `false` | `true`면 클라이언트에 FBX 저장이 노출된다 |
| `corsOrigins` | 아래 CORS 항목 참고 | 빠진 Origin은 가입 페이지에서 CORS 오류가 난다 |
| `oauthSuccessRedirect` | `standin://auth/callback` | 클라이언트가 등록한 스킴과 다르면 OAuth 로그인이 앱으로 돌아오지 못한다 |
| `quotaGlobalDaily` | `"400"` | 앱의 전체 일일 상한. 오픈베타_계획 §4-2 산식에서 나온 값이다 |

`stagingPublicUrl`·`stagingCertificateArn`·`stagingQuotaGlobalDaily`은 staging 전용이라
프로덕션 배포에 영향을 주지 않는다.

> 실제로 겪었다. 사용량 제한 env를 배포하려고 `cdk diff`를 돌렸더니 `REFINE_ENABLED 1→0`,
> `REFINE_FEATURE_ENABLED true→false`가 함께 나왔다 — 배포된 스택은 refine이 켜져 있는데
> `cdk.json`은 `false`였기 때문이다. 이 값들을 커밋해 두지 않으면 매번 `-c`를 정확히
> 기억해야 하고, 한 번 빠뜨리면 의도하지 않은 기능 롤백이 조용히 나간다.

**배포 상태를 바꿀 때는 `cdk.json`을 같은 PR에서 고친다.** `-c`는 일회성 실험에만 쓴다.
배포 전 `npx cdk diff StandinApp`으로 **의도한 리소스만 바뀌는지** 반드시 확인한다.

## 테스트 환경(staging)

프로덕션에 바로 배포하지 않기 위한 두 번째 환경이다. `-c envName=staging`이면 같은 코드가
`StandinStagingApp` 스택을 만든다.

```bash
npx cdk deploy StandinStagingApp -c envName=staging
```

### ⚠ 프로덕션 스택 ID는 절대 바꾸지 않는다

CloudFormation은 **스택 이름으로 리소스를 추적한다.** 대칭을 맞추겠다고 `StandinApp`을
`StandinProdApp` 같은 이름으로 "정리"하면 CloudFormation이 이를 새 스택으로 보고
**VPC·RDS·ALB를 통째로 새로 만든다.** 프로덕션은 배포된 이름 그대로 두고 staging만 새
이름을 받는다. 물리 이름(시크릿·KMS 별칭·IAM 정책)도 같은 이유로 프로덕션 쪽은 손대지
않았다 — 시크릿 이름이 바뀌면 JWT 서명 키가 교체되어 모든 세션이 끊긴다.

### 두 환경이 갈리는 것 / 공유하는 것

| | 프로덕션 | staging |
|---|---|---|
| 스택 | `StandinApp` | `StandinStagingApp` |
| VPC·RDS·ALB·ECS | 각자 | 각자 |
| 시크릿 | `standin/jwt`, `standin/db` … | `standin/staging/jwt`, `standin/staging/db` … |
| KMS 별칭 | `alias/standin-production-beta-data` | `alias/standin-staging-beta-data` |
| 내부 DNS | `standin.local` | `standin-staging.local` |
| 운영 정책 | `standin-inference-operator` | `standin-staging-inference-operator` |
| ECR 저장소 | `standin/bff`, `standin/inference` — **공유** | |
| 이미지 태그 | `:latest` (main 빌드가 옮긴다) | `:develop` (develop 빌드가 옮긴다) |
| OIDC 배포 역할 | `standin-github-deploy` — **공유** (GitHub environment로 구분) | |

이름 충돌은 합성에서 드러나지 않고 **두 번째 배포가 시작된 뒤** `CREATE_FAILED`로 나온다.
그래서 `scripts/assert-env-isolation.mjs`가 CI에서 두 템플릿의 고정 이름을 비교한다.
새 리소스에 이름을 직접 지정할 때는 이 검사가 통과하는지 확인한다.

### ⚠ 움직이는 태그는 환경마다 나눈다

저장소는 공유하지만 **`latest`를 두 환경이 같이 보면 안 된다.**

배포 자체는 GitHub Actions가 커밋 SHA로 고정한 태스크 정의 리비전으로 한다. 그런데
`cdk deploy`가 서비스를 건드리면 CloudFormation이 **자기가 만든 리비전으로 되돌리고**,
그 리비전은 `imageTag` 컨텍스트의 움직이는 태그를 참조한다. 두 환경이 같은 태그를 보면
그 되돌림이 엉뚱한 환경의 이미지를 끌어온다 — staging에 프로덕션 이미지가 올라가거나,
develop 코드가 프로덕션에 올라간다.

실제로 겪었다. staging 자동 배포가 붙은 날, `develop` 빌드가 `latest`를 옮겼고
프로덕션 태스크 정의가 그 `latest`를 참조하고 있었다. 프로덕션은 SHA로 고정된 리비전을
돌고 있어 사고가 나지는 않았지만, 그 시점에 누가 `cdk deploy StandinApp`을 돌렸다면
리뷰되지 않은 develop 코드가 프로덕션에 올라갔다.

```
main 빌드     → :sha + :latest     프로덕션 태스크 정의 → :latest
develop 빌드  → :sha + :develop    staging 태스크 정의  → :develop
```

앱 저장소의 `deploy.yml`이 브랜치별로 움직이는 태그를 나눠 민다. SHA 태그는 항상
푸시하고, 배포는 그쪽을 쓴다.

### staging도 `appEnv=production`으로 돌린다

mock으로 도는 환경은 **인프라 배선만** 확인할 뿐 추론 회귀를 잡지 못한다 — 그런 회귀는
프로덕션에서 처음 보게 된다. staging은 실모델·실 포즈 라이브러리로 돌리고, 대신 비용을
쿼터로 막는다(`stagingQuotaGlobalDaily`, 기본 50).

따라서 staging에도 다음이 필요하다:

- **포즈 라이브러리 번들** — staging `AssetsBucketName`에도 올려야 한다([INFERENCE_OPERATOR_GUIDE.md](INFERENCE_OPERATOR_GUIDE.md) 절차를 그대로 반복). 없으면 추론 태스크가 기동에 실패한다(의도된 동작).
- **VLM API 키** — `standin/staging/vlm`에 채운다. 프로덕션과 같은 키를 써도 되지만 사용량이 합산된다.
- **OAuth·SMTP 값** — `standin/staging/oauth`, `standin/staging/smtp`. OAuth 콜백 URL이 staging 도메인이라 각 공급자 콘솔에 리디렉트 URI를 추가로 등록해야 한다.

### 평소에는 태스크를 0개로 둔다

스택은 남겨 두고 Fargate 태스크만 0으로 둔다. 유휴 비용이 월 ~$79에서 ~$28(ALB+RDS)로
내려가고, 도메인·인증서·시크릿을 매번 다시 세팅하지 않아도 된다.

```bash
npx cdk deploy StandinStagingApp -c envName=staging -c stagingActive=true
```

테스트가 끝나면 `stagingActive`를 다시 `false`로 되돌려 배포한다. `aws ecs update-service
--desired-count 1`로 임시로 올릴 수도 있지만, 태스크 정의가 바뀌는 다음 `cdk deploy`에서
0으로 되돌아간다. 재현 가능한 쪽은 컨텍스트 스위치다.

### 클라이언트는 환경별로 빌드한다

**앱 설정에서 서버 주소만 바꾸는 런타임 스위치로는 안 된다.** OAuth 딥링크 스킴은 앱을
설치할 때 OS에 등록되므로 런타임에 바꿀 수 없다. 두 빌드가 같은 `standin://`를 쓰면 어느
앱이 링크를 받을지 OS가 정하고(Windows는 마지막 등록이 이긴다), staging 로그인의 1회용
교환 코드가 프로덕션 앱으로 넘어간다.

| | 프로덕션 빌드 | staging 빌드 |
|---|---|---|
| API 기준 URL | `https://api.standinpose.com` | `https://api-staging.standinpose.com` |
| 딥링크 스킴 | `standin://auth/callback` | `standin-staging://auth/callback` |
| bundle id | 현행 | 별도 id (동시 설치 가능해야 한다) |

두 값 모두 스택 출력(`PublicUrl`, `OauthSuccessRedirect`)에서 읽을 수 있다. 앱에는 눈에
보이는 환경 배지를 넣는다 — 테스터가 어느 쪽에 버그를 보고하는지 헷갈리는 것이 실제로
가장 흔한 사고다.

**Vercel 가입 페이지**는 Preview 환경변수로 `VITE_API_BASE_URL`을 staging으로 돌린다.
Preview 도메인은 배포마다 바뀌어 CORS에 넣을 수 없으므로 **브랜치 고정 도메인**
(`standin-seven-git-develop-….vercel.app`)을 쓰고, 그 주소를 `cdk.json`의
`stagingCorsOrigins`에 추가한다. 끝에 `/`를 붙이지 않는다 — Origin 비교는 정확히 일치해야
한다.

**OAuth 공급자 콘솔**은 staging용 클라이언트를 따로 만드는 쪽을 권한다. 시크릿이 이미
`standin/staging/oauth`로 갈려 있고, 하나의 클라이언트에 리디렉트 URI를 둘 넣으면 staging
설정 실수가 프로덕션 클라이언트를 건드릴 수 있다.

`scripts/assert-env-isolation.mjs`가 `PUBLIC_URL`·`OAUTH_SUCCESS_REDIRECT`·`CORS_ORIGINS`
세 값이 두 환경에서 갈리는지 CI에서 확인한다. 이 셋은 이름 충돌과 달리 **배포가 성공한
뒤에** 문제가 되므로 합성 단계에서 잡아야 한다.

### 처음 한 번만 하는 준비

1. `api-staging.standinpose.com`용 **서울 리전 ACM 인증서**를 발급하고 가비아에 검증 CNAME을 넣는다. ⚠ 호스트 이름에 점을 하나만 쓴다 — 가비아 DNS 관리는 호스트 필드에 점을 하나까지만 받는다. `staging.api.standinpose.com`을 쓰면 검증 레코드가 `_hash.staging.api`(점 2개)라 등록 자체가 안 된다. `api-staging`은 `_hash.api-staging`(점 1개)이라 들어간다.
2. `cdk.json`의 `stagingPublicUrl`·`stagingCertificateArn`을 채운다. 둘 중 하나라도 비어 있으면 `-c envName=staging` 배포가 합성 단계에서 막힌다.
3. `npx cdk deploy StandinStagingApp -c envName=staging`
4. 스택 출력의 `AlbUrl`을 가비아에 CNAME으로 연결한다.
5. 위 「staging도 `appEnv=production`으로 돌린다」의 시크릿·번들을 채운다.
6. 앱 저장소에 GitHub environment `staging`을 만들고 배포 가능 브랜치를 `develop`으로 제한한다. OIDC 역할은 이미 `:environment:staging`을 신뢰한다.
7. 각 OAuth 공급자 콘솔에 staging 리디렉트 URI를 등록하고, staging 클라이언트 빌드에 `standin-staging://` 스킴을 등록한다(위 「클라이언트는 환경별로 빌드한다」).

### 승격 흐름

```
develop 머지 → GitHub env: staging → StandinStagingApp 에 이미지 SHA 배포 → 검증
                                                                              ↓
main 머지    → GitHub env: beta    → StandinApp 에 **같은 SHA** 배포
```

ECR을 공유하므로 프로덕션 배포는 새로 빌드하지 않고 staging에서 통과한 태그를 그대로 쓴다.

## FBX converter (선택)

Blender 5.2를 번들한 별도 서비스다. 기본은 꺼져 있다.

| context | 기본 | 역할 |
|---|---|---|
| `converterEnabled` | `false` | converter ECS 서비스를 만든다 |
| `fbxExportEnabled` | `false` | BFF가 클라이언트에 FBX 저장을 노출한다 |

refine과 같은 두 단계다 — 서비스를 띄워 헬스체크가 통과하는지 보고, 그 다음에 노출한다.
`fbxExportEnabled=true`인데 `converterEnabled=false`면 합성이 실패한다.

### ⚠ 캐릭터 아티팩트가 먼저다

converter의 `/healthz`는 `default_character`를 검사한다. `standin-master-v2.fbx`가 없으면
**503을 돌려주고 ECS가 태스크를 무한 교체**한다. 그래서 순서가 이렇다:

```bash
# 1. 캐릭터 업로드 (레지스트리의 sha256과 일치해야 한다)
aws s3 cp standin-master-v2.fbx s3://<AssetsBucketName>/characters/standin-master-v2.fbx

# 2. 서비스만 켠다 (사용자에게는 아직 안 보인다)
npx cdk deploy StandinStagingApp -c envName=staging -c converterEnabled=true

# 3. 헬스체크 통과 확인 후 노출
npx cdk deploy StandinStagingApp -c envName=staging -c converterEnabled=true -c fbxExportEnabled=true
```

### 사이징 근거

로컬 실측(합성 캐릭터 기준):

| | |
|---|---|
| 이미지 | 1.61 GB (Blender 5.2 포함, **amd64 전용**) |
| Blender 기동만 | 344 MiB / 1.5초 |
| BVH 파싱 + 리타깃 + FBX export 전체 | **372 MiB / 3.4초** |

요청마다 Blender를 subprocess로 새로 띄우고 **동시 실행은 1개**다
(`CONVERTER_MAX_CONCURRENT_PROCESSES=1`, uvicorn `--workers 1`). vCPU를 늘려도 처리량이
늘지 않으므로 **1 vCPU / 2 GB**로 잡았다 — 실측 대비 5배 헤드룸이다. 메모리의 대부분이
Blender 런타임 자체이고 변환 페이로드는 28 MiB뿐이라, 실제 캐릭터가 커져도 여유가 있다.

BFF는 **인물마다 한 번씩** 호출한다. 동시성이 1이라 3인 이미지는 직렬 ~10초다.

### converter 이미지 태그는 따로다

converter는 빌드 파이프라인이 별개다(`Standin-server/.github/workflows/converter-deploy.yml`).
지금 그 워크플로는 `main`에서만 돌아 `:latest`만 옮기므로 **두 환경 모두 `latest`를 본다**.
converter CI가 develop 빌드를 갖게 되면 `stagingConverterImageTag`를 `develop`으로 바꾼다.

### 배포 역할

`converter-deploy.yml`은 `CONVERTER_AWS_DEPLOY_ROLE`이라는 별도 변수로 역할을 받는다.
그 변수에 `StandinCicd`의 `DeployRoleArn`을 넣으면 이 스택이 준 권한으로 배포된다. 경계를
정말 분리하고 싶으면 별도 역할을 만들어 그 변수만 바꾸면 되고, 앱 저장소 쪽은 영향이 없다.

## 배포는 2단계로 나눈다

`appEnv`로 실행 환경을 전환하고, 두 refine 컨텍스트로 기능 활성화 단계를 제어한다.
코드를 고치거나 ECS 태스크 정의를 콘솔에서 직접 수정하지 않는다.

| | 1단계 `development` | 2단계 `production` (현재 `cdk.json` 값) |
|---|---|---|
| 포즈 라이브러리 | 합성(자동 생성) | S3 번들 — 없으면 **기동 실패** |
| VLM · 포즈 백엔드 | mock | gemini · rtmlib — mock으로 폴백하면 **기동 실패** |
| 목적 | ALB·RDS·서비스 디스커버리·시크릿 주입·CI 배선 검증 | 실서비스 |

1단계는 실 라이브러리도 API 키도 없이 뜬다. **인프라가 실제로 물리는지 먼저 확인하고**, 준비되면 2단계로 넘어간다.

⚠ 아래 명령들은 **최초 구축 기록**이다. 지금은 `cdk.json`이 `appEnv=production`을 담고 있으므로
`-c` 없는 `npx cdk deploy StandinApp`이 곧 프로덕션 배포다. 1단계로 되돌리려면 `-c appEnv=development`를
명시해야 하고, 그건 실서비스를 mock으로 뒤집는 동작이다.

```bash
npm install
npx cdk bootstrap                      # 계정·리전당 1회

npx cdk deploy StandinRegistry         # 1. 이미지 저장소
npx cdk deploy StandinCicd             # 2. CI 역할 → 출력된 ARN을 GitHub 변수에 등록
#    → 앱 저장소에서 워크플로를 돌려 이미지를 먼저 밀어 넣는다(templates/ 참고)
npx cdk deploy StandinApp              # 3. 1단계 기동

# … 검증 후, 라이브러리·키가 준비되면
npx cdk deploy StandinApp -c appEnv=production -c refineEnabled=false -c refineFeatureEnabled=false
```

`StandinApp`은 ECR에 `latest` 태그가 있어야 태스크가 기동한다. **2번과 3번 사이에 이미지 푸시가 반드시 들어간다.**

`cdk.json`의 `publicUrl`과 `certificateArn`을 채운 뒤 배포한다. OAuth 콜백과 이메일 인증
링크는 `https://api.standinpose.com`을 쓴다.

```bash
npx cdk deploy StandinApp
# 출력: PublicUrl=https://api.standinpose.com
```

클라이언트의 API 기준 URL과 각 OAuth provider의 Redirect URI도 `PublicUrl`을 사용한다.
`AlbUrl`은 가비아 CNAME 대상 확인용이며 인증서 이름이 달라 직접 HTTPS 호출하지 않는다.

BFF는 OAuth 성공 시 `OAUTH_SUCCESS_REDIRECT`(`cdk.json`의 `oauthSuccessRedirect`, 프로덕션은 `standin://auth/callback`)로 리디렉트한다. URL에는 토큰 대신 1회용 교환 코드만 담기며, 데스크톱 앱이 `/v1/auth/oauth/exchange`로 토큰을 받아간다.

운영 가입 페이지 `https://standin-seven.vercel.app`은 BFF의 `CORS_ORIGINS`(`cdk.json`의 `corsOrigins`)에 허용돼 있다. Vercel의 `VITE_API_BASE_URL`은 `https://api.standinpose.com`으로 설정하며, Origin 비교가 정확히 일치하도록 Vercel 주소 끝에는 `/`를 붙이지 않는다.

## 배포 전에 끝내야 할 것

### 1. BFF의 DB 접속 방식 — ✅ 완료

CDK는 RDS가 만든 시크릿을 **표준 `PG*` 변수**로 주입한다(`PGHOST`/`PGPORT`/`PGUSER`/`PGPASSWORD`/`PGDATABASE`). 접속 문자열을 따로 조립해 보관하지 않기 위해서다 — 시크릿을 두 벌로 만들면 회전할 때 어긋난다.

BFF(`feat/postgres`)는 `PGHOST`가 있으면 `connectionString`을 넘기지 않아 `pg`가 `PG*`를 읽는다. 로컬은 `PGHOST`가 없으므로 `DATABASE_URL` 기본값이 그대로 쓰인다.

**단, 이 코드는 아직 `feat/postgres` 브랜치에 있다. main에 머지돼야 배포할 수 있다.**

### 2. 포즈 라이브러리 번들 업로드 (2단계)

`Standin-server` 저장소의 배포 스크립트를 쓴다. 검증 → 압축 → 업로드 → 재기동 → 확인을
한 번에 하고, 번들이 잘못됐으면 업로드 자체를 막는다.

```bash
python scripts/deploy_pose_library.py data/
```

업로드하지 않으면 추론 태스크가 기동에 실패한다(프로덕션에서는 합성 라이브러리로 대체하지 않는다).

수동으로 만들 때는 `thumbs`를 빠뜨리지 않는다 — 빠져도 에러가 나지 않고 썸네일만 조용히 사라진다.

```bash
tar -czf v1.tar.gz -C data poses.db index.pkl bvh thumbs
aws s3 cp v1.tar.gz s3://<AssetsBucketName>/pose-library/v1.tar.gz
```

버킷 이름은 `StandinApp` 출력에서 확인한다.

`requirements.txt`의 `boto3` 주석도 해제해야 `s3://`를 받을 수 있다.

#### 추론 서버 담당자 IAM 설정

`StandinApp`은 `standin-inference-operator` 관리형 정책을 함께 만든다. 이 정책은
`pose-library/` 아래의 업로드·조회, 해당 추론 ECS 서비스의 조회·재기동, 그리고 **추론
컨테이너 로그 그룹 하나의 읽기**만 허용한다. 버킷의 다른 경로, 객체 삭제, 다른 ECS 서비스
변경 권한은 포함하지 않는다.

로그를 연 이유: 배포가 안정화에 실패하면 스크립트는 "새 번들이 로드되지 않았다"까지만
알려 주고 원인은 컨테이너 로그에만 남는다. 그때마다 관리자가 로그를 떠서 전달하면 담당자가
스스로 되돌릴지 판단할 수 없다. 그룹은 `InferenceLogGroupName` 출력으로 알려 준다.

BFF·worker·RDS 로그 그룹은 열지 않는다 — 사용자 데이터가 흐른다. 다른 그룹은 이름만
보이고(`logs:DescribeLogGroups`, 콘솔 목록용) 내용은 열리지 않는다.

사람별 IAM 사용자나 장기 액세스 키를 새로 만들지 말고, IAM Identity Center에서 추론 팀
그룹용 권한 세트를 만든 뒤 출력된 `InferenceOperatorPolicyArn`의 고객 관리형 정책
`standin-inference-operator`를 연결한다. 기존 사내 운영 역할을 쓰는 경우에는 그 역할에
같은 정책을 연결해도 된다.

담당자는 SSO로 로그인한 뒤 번들을 업로드하고 추론 서비스만 새로 배포한다.

```bash
aws configure sso --profile standin-inference    # 최초 1회
aws sso login --profile standin-inference

python scripts/deploy_pose_library.py data/      # 검증·업로드·재기동·확인
python scripts/deploy_pose_library.py --rollback # 직전 번들로 되돌리기

aws logs tail <InferenceLogGroupName> --since 30m --profile standin-inference
```

버킷·클러스터·서비스 이름은 스크립트에 기본값으로 들어 있다. 스택을 다시 만들어 이름이
바뀌면 `POSE_LIBRARY_BUCKET`·`ECS_CLUSTER`·`ECS_SERVICE` 환경변수로 덮어쓴다. 값은
`aws cloudformation describe-stacks --stack-name StandinApp` 출력에서 확인한다.

버킷 버전 관리가 켜져 있으므로 같은 키로 새 번들을 올려도 이전 버전은 보존된다 —
`--rollback`이 그 버전을 찾아 되돌린다. 실행 중 Fargate 컨테이너에 직접 복사한 파일은
태스크 교체 시 사라지므로 운영 절차로 사용하지 않는다.

자세한 담당자 안내는 [INFERENCE_OPERATOR_GUIDE.md](INFERENCE_OPERATOR_GUIDE.md) 참고.

### 3. 소셜 로그인 키

`standin/oauth` 시크릿에는 **키 6개가 빈 값으로 이미 만들어져 있다.** 콘솔에서 값만 채우면 된다.

키를 미리 만들어 두는 이유: ECS는 태스크를 띄울 때 시크릿의 JSON 키를 해석하는데, 없는 키를 참조하면 컨테이너가 시작조차 못 한다. 값이 비어 있으면 앱이 `PROVIDER_UNAVAILABLE`로 처리하므로 기동에는 문제가 없다 — 소셜 로그인만 비활성이다.

각 provider 콘솔의 Redirect URI도 `{AlbUrl}/v1/auth/oauth/{provider}/callback`로 등록한다.

### 4. VLM API 키 (2단계)

`standin/vlm` 시크릿의 `geminiApiKey`에 값을 채운다. 배선은 이미 돼 있다.

값이 비면 추론 서버가 조용히 mock으로 폴백하는데, 런타임 가드가 그걸 잡아 기동을 막는다 — 가짜 후보가 서빙되는 일은 없다.

### 5. 이메일 인증 SMTP

`standin/smtp` 시크릿에 아래 값을 채운다. Gmail SMTP, SES SMTP 등 표준 SMTP 공급자를 사용할 수 있다.

| 키 | 예시 |
|---|---|
| `host` | `smtp.gmail.com` |
| `port` | `587`(STARTTLS) 또는 `465`(TLS) |
| `user` | SMTP 사용자명 |
| `pass` | SMTP 비밀번호 또는 앱 비밀번호 |
| `from` | `Standin <인증된-발신주소>` |

시크릿 값을 바꾼 뒤에는 BFF ECS 서비스를 강제 재배포해야 새 태스크가 값을 읽는다. 개인 Gmail을 쓸 경우 일반 계정 비밀번호가 아니라 앱 비밀번호를 사용한다. SES SMTP를 쓸 경우 SES 콘솔에서 별도로 발급한 SMTP 자격증명을 사용하며 IAM 액세스 키를 그대로 넣지 않는다.

### 6. 장애 알림 디스코드 웹훅

`standin/discord` 시크릿에 채널별 웹훅 URL을 채운다. **키 3개가 빈 값으로 이미 만들어져 있다** — SMTP·OAuth와 같은 이유다(ECS가 없는 키를 참조하면 컨테이너가 시작조차 못 한다).

| 키 | 채널 | 등급 |
|---|---|---|
| `webhookAlert` | `#standin-alert` | P1 — 기동 실패·DB 접속 불가·추론 헬스 연속 실패 |
| `webhookWarn` | `#standin-warn` | P2 — 처리되지 않은 예외·분석 실패 |
| `webhookOps` | `#standin-ops` | P3 — 기동·배포·요약 |

디스코드 채널에서 **채널 설정 → 연동 → 웹후크**로 발급한다. **웹훅 URL 자체가 비밀이다** — URL을 아는 누구나 그 채널에 글을 쓸 수 있으므로 코드·문서·이슈에 남기지 않는다.

값이 비어 있으면 알림기는 조용히 no-op으로 동작한다. 기동에는 문제가 없고 알림만 나가지 않는다.

**P1에는 `@here` 멘션이 기본으로 붙는다**(2026-08-18 팀 결정). 새벽에도 울린다는 뜻이므로, 어떤 사건을 P1로 올릴지는 그때마다 "이게 새벽 3시에 울려도 되는가"로 판단한다. 야간 호출을 끄려면 합성 시점에 비운다.

```bash
DISCORD_ALERT_MENTION="" npx cdk deploy StandinApp
```

설계 정본은 마스터독스의 「관측성 — 로그·모니터링·디스코드 알림」이다.

### 7. 인프라 이벤트 알림 (자동)

`InfraAlerts` Lambda와 EventBridge 규칙 3개가 스택에 함께 만들어진다. 채울 값은 없다 — `standin/discord`를 실행 시점에 읽는다.

여기서 잡는 사건은 **앱이 원리적으로 보고할 수 없는 것들**이다.

| 규칙 | 잡는 것 | 등급 |
|---|---|---|
| `TaskStoppedRule` | 태스크 기동 실패·OOM(exit 137)·필수 컨테이너 비정상 종료 | P1 |
| `DeploymentStateRule` | 서킷브레이커 롤백(`SERVICE_DEPLOYMENT_FAILED`) / 배포 완료 | P1 / P3 |
| `DatabaseEventRule` | RDS 저장공간·장애조치·유지보수 | P1 / P2 |

정상 종료(롤링 배포·스케일 인)는 Lambda가 걸러 낸다. 이벤트 패턴만으로는 `stopCode`와 `exitCode` 조합을 판단할 수 없어서 코드에서 거른다.

**롤백 알림이 이 셋 중 가장 값어치가 크다.** 서킷브레이커가 롤백하면 옛 태스크가 계속 돌아 서비스는 "정상"으로 보이고, 새 코드가 반영되지 않은 것을 아무도 모른다.

### 8. 외부 헬스 감시자 (AWS 밖, 선택이지만 권장)

위 7번까지는 전부 같은 AWS 계정 안에 있다. 계정·리전이 통째로 흔들리면 알림도 함께 죽는다. 그 마지막 구멍은 `watchdog/cloudflare`의 Cloudflare Worker가 메운다 — 1분마다 공개 API `/healthz`를 밖에서 두드리고 2회 연속 실패하면 P1을 보낸다.

배포는 [watchdog/cloudflare/README.md](watchdog/cloudflare/README.md) 참고. Cloudflare 무료 등급으로 충분하다.

## 로그 출하 경로

기본은 CloudWatch Logs다(`awslogs` 드라이버, 보존 14일).

```bash
npx cdk deploy StandinApp -c logRetentionDays=3          # 보존만 줄인다
npx cdk deploy StandinApp -c logShipping=firelens        # 외부 수집기로 보낸다
```

| 값 | 동작 |
|---|---|
| `cloudwatch`(기본) | ECS `awslogs` 드라이버 → CloudWatch Logs |
| `firelens` | fluent-bit 사이드카 → Loki/Grafana Cloud. CloudWatch에는 사이드카 자신의 로그만 3일 남는다 |

`firelens`로 켜면 `standin/log-shipping` 시크릿(`host`·`user`·`password`)이 함께 만들어진다. 값을 채운 뒤 재배포한다.

**언제 켜나**: 계획 문서 §8의 기준은 "3단계 자체 대시보드로 원인을 못 찾아 CloudWatch 콘솔을 여는 일이 월 3회를 넘을 때"다. 그 전에 세우면 유지비만 나간다. 지금은 스위치만 배선돼 있다.

⚠ `firelens` 경로는 **실제 수집기에 붙여 검증한 적이 없다.** 처음 켤 때는 반드시 development에서 먼저 확인한다.

`logRetentionDays`는 CloudWatch가 받는 값만 허용한다(1·3·5·7·14·30·60·90·180·365). 기본 14일은 클로즈베타 데이터 수집 문서의 "운영 로그" 정책과 맞물려 있으므로 줄이기 전에 팀 확인이 필요하다.

## 운영 대시보드

지표는 BFF가 1분 롤업으로 RDS에 쌓고, 화면도 BFF가 낸다.

```
https://api.standinpose.com/v1/admin/ops/dashboard
```

관리자 토큰(`standin/<env>/beta-review-token`)을 화면에서 입력한다. 주소창에 `?token=`으로 넘겨도 되지만 페이지가 로드 즉시 지운다.

별도 박스를 세우지 않은 이유: 데이터가 isolated 서브넷의 RDS에 있어 **어떤 대시보드든 BFF를 거쳐야 읽는다.** 따로 세워도 BFF가 죽으면 화면만 뜨고 숫자는 안 나온다 — 월 $5~14를 내고 독립성을 사지 못한다. 그 독립성은 위 8번 외부 감시자가 월 $0에 준다.

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

배포 워크플로 템플릿(`templates/deploy-*.yml`)은 브랜치로 환경을 고른다 — `main`이면 GitHub
environment `beta`(프로덕션), 그 외에는 `staging`이다. OIDC 역할은 **보호된 environment에
붙은 job만** 신뢰하므로 워크플로에서 `environment:`를 지우면 role assume이 실패한다.

클러스터·서비스 이름은 environment 변수(`ECS_CLUSTER`, `ECS_SERVICE`)로 넘긴다. 이름에
CDK가 붙인 해시가 들어가 환경마다 다르고, 워크플로에 하드코딩하면 staging 배포가
프로덕션으로 나갈 수 있다. 값은 각 스택의 `ClusterName`·`BffServiceName`·
`InferenceServiceName` 출력에서 가져온다.

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

### staging 추가분

| 상태 | 월 |
|---|---|
| 유휴 (`stagingActive=false`, 태스크 0개) | **~$28** — ALB $16 + RDS $12 |
| 테스트 중 (`stagingActive=true`) | **~$79** — 프로덕션과 같은 구성 |

태스크를 상시 띄우지 않는 이유가 이 표다. staging을 항상 켜 두면 인프라 고정비가 두 배가
되어 `QUOTA_GLOBAL_DAILY` 산식(오픈베타_계획 §4-2)의 전제가 무너진다. 여기에 staging의
Gemini 호출 비용이 별도로 붙으므로 `stagingQuotaGlobalDaily`를 낮게 유지한다.

## 알려진 한계

- **CDN·WAF 없음.** 클라이언트가 인터넷 공개 ALB에 직접 연결한다. 대규모 DDoS 완화나 엣지 WAF가 필요해지면 별도 공개 경계를 다시 검토한다.
- **단일 태스크·단일 AZ.** `desiredCount: 1`, RDS `multiAz: false`. 가용성이 필요해지면 올린다.
- **Job 실행 모드.** 기본 `jobExecutionMode=inline`은 롤백 경로다. 앱 서버 #23 배포와
  queue/worker 검증 뒤 `-c jobExecutionMode=sqs`로 전환한다. SQS는 DLQ 3회, Worker lease와
  visibility heartbeat를 사용하며 queue age·DLQ를 CloudWatch Alarm으로 감시한다.

### SQS 전환 순서

1. `Standin-app-server`의 outbox/worker 이미지를 먼저 배포하되 `inline` 유지
2. 이 스택을 배포해 SQS·DLQ와 desiredCount 0 Worker를 생성
3. staging에서 `-c jobExecutionMode=sqs`로 Worker 1개 활성화
4. BFF 강제 재시작·Worker 중단 중에도 Job이 완료되는지 확인
5. queue age와 DLQ가 비어 있는지 확인한 뒤 production을 `sqs`로 전환
- **RDS `removalPolicy: SNAPSHOT`, `deletionProtection: false`.** 초기 단계 설정이다. 실사용자가 생기면 `RETAIN` + 삭제 보호로 바꿀 것.
- **staging은 같은 AWS 계정에 있다.** 스택·물리 이름은 갈렸지만 IAM·서비스 쿼터·청구는 프로덕션과 같은 계정을 쓴다. staging 작업이 실수로 프로덕션 리소스를 건드릴 여지가 남아 있다. 폭발 반경을 완전히 끊으려면 Organizations로 계정을 나눠야 한다(그때는 CDK bootstrap·OIDC 공급자·교차계정 ECR pull이 추가로 필요하다).
- **staging은 프로덕션과 규모가 다르지 않다.** 태스크 크기·RDS 인스턴스가 같아 부하 특성은 비슷하지만, `desiredCount`가 1이라 다중 태스크에서만 나는 문제(세션 고정, 동시성 경합)는 여기서도 잡히지 않는다.
- **SMTP 공급자 운영 설정 필요.** 인프라 배선은 `standin/smtp`로 완료돼 있지만 실제 발신 계정과 주소는 별도로 준비해야 한다. SES를 선택하면 프로덕션 액세스 신청과 발신 주소 인증에 시간이 걸릴 수 있다.
