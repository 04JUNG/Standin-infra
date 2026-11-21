# Prepared neutral 20종의 유한 설치 예산

서버 prepared-presets PR의 20종 번들은 기존 768 MiB 상한을 넘는다. 실제 배포에서는 이 저장소의 `scripts/body-assets-init.py`가 task command에 인라인으로 들어가므로 서버 패키저 변경만으로는 설치할 수 없다.

새 manifest의 명시적 `budgetProfile: prepared-neutral-20.v1`에만 다음 정책을 적용한다.

- 일반 자산 합계는 기존 768 MiB 그대로다.
- Converter role의 `fbx/prepared-<64hex>.fbx`와 같은 key의 `qa/prepared-<64hex>.json`만 추가 192 MiB를 쓸 수 있다. 전체 상한은 960 MiB다.
- 준비 FBX 한 개 64 MiB / receipt 한 개 256 KiB 이하, 최대 22쌍이다. 현재 20종과 이전 기본형 두 쌍을 보존할 수 있다.
- 경로 allowlist, 중복 경로, 역할, 각 파일 크기·SHA256, manifest SHA256 및 64 KiB 한도는 계속 검사한다. 쌍이 없거나 잘못된 역할/확장자/개수/프로필이면 설치 전에 거부한다.
- 프로필 없는 기존 릴리스는 계속 768 MiB다. cap을 임의로 늘리는 환경변수는 없다. BFF/Inference는 확장 프로필을 사용할 수 없다.

CPU·메모리·ECS service와 운영 이미지·S3 key·카탈로그/스킨 pin은 바꾸지 않는다. #90의 `lib/app-stack.ts`와 변경 파일이 겹치지 않는다. PR만으로 새 번들이 활성화되지는 않는다. staging 설치용 이미지의 검증 모듈 보완은 아래에 따로 기록한다.

body-assets Converter task는 기존 2 vCPU / 4 GiB, init soft memory reservation은 128 MiB다. 파일을 직렬로 읽고 기존 일반 파일 최대 300 MiB도 유지한다. 새 볼륨 설치의 body 자산 상한은 960 MiB이고 이전 설치와 staging이 동시에 있는 재설치는 최대 1,920 MiB(1.875 GiB)다. 기본 Fargate Linux 1.4+ 저장소 20 GiB에서는 이미지 압축/해제 크기와 다른 볼륨을 차감해야 한다([AWS](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/fargate-task-storage.html)). 전체 운영 task 자유 공간을 실측한 결과는 아니다.

서버에서 승인 원본 193개 파일의 크기·SHA를 확인했고, 현재 develop Linux 번들 233개 / 910,022,778 bytes(867.87 MiB)를 실제 같은 Python 설치기로 로컬 설치했다. 20종 모두 런타임 `prepared`를 확인했다. main은 별도 코드 식별값의 Linux 번들을 생성·검증한다. 서버 QA 문서에 플랫폼·런타임·프리셋별 key/해시·실측을 기록한다.

검증 명령:

```sh
python3 scripts/test-body-assets-init.py
node scripts/test-body-assets-init.mjs
```

Python 테스트는 기존 role/path/hash/pin 검사와 함께 새 예산의 경계, 일반 자산 상한 유지, 쌍/역할/개수/receipt 제한, 손상 시 기존 설치 보존과 복구를 검사한다. 서버 측 테스트는 정확한 승인 20종, catalog/manifest pin·기본값 불일치, Darwin 준비 파일 거부, 기존 두 쌍의 보존, 중복 경로, 전체 번들 설치·FBX 재로드도 검사한다.

승인된 다음 배포에서는 서버 PR과 이 설치기 PR을 함께 사용하고, 최종 Converter 이미지의 코드/build/플랫폼과 prepared identity가 일치하는 번들을 새 immutable prefix로 발행해야 한다. manifest key/SHA·parity pin·인라인 initializer를 한 계획에서 검토한다. 이전 task definition/manifest pin을 보존해 rollback한다. 기존 큰 자산을 삭제할 필요가 없다.

이번 작업은 기능 브랜치와 검토용 PR까지다. SSM·ECS·운영/스테이징 배포·병합·릴리스를 실행하지 않는다. 기존 운영 pin은 그대로다.

## LOD 기본 모델과 과거 자산을 함께 보존하는 예산

`lod-defaults-20.v1`은 새 20종의 source·FBX·UV와 이전 자산을 함께 설치하기 위해 일반 자산에 1,280 MiB, prepared 파일에 기존 192 MiB를 허용한다. 전체 상한은 1,472 MiB다. 이 프로필도 Converter 전용이며, 파일당 300 MiB·prepared FBX 64 MiB·receipt 256 KiB·최대 22쌍·manifest 64 KiB·경로·역할·해시 검사는 유지한다. 일반 릴리스와 기존 prepared profile의 예산은 바꾸지 않는다.

설치기는 파일을 게시하기 전에 실제 Converter reader로 prepared receipt와 FBX의 source·character·preset controls·코드/build/platform 정체성을 확인한다. manifest에 없는 source, index에 없는 prepared 파일과 손상된 쌍은 거절한다. 기존 staging 설치용 이미지 `39c8986a...`에는 `converter.prepared_body`가 없으므로, 이 모듈과 정확한 prepared 코드 지문을 가진 `a4d731fe35682f3e97f2bbeb53e188c3f43fd2bdc3f6da6a89cedb41ab2c5fd6`으로 **PR의 staging initImages.converter만** 고정한다. BFF 설치기는 계속 실제 배포되는 BFF 이미지를 사용한다.

2026-11-21 로컬 Linux/amd64 검증에서는 고정 이미지 자체의 코드를 사용해 ECS와 같은 `python -c` command로 280개 파일 / 1,294,660,307 bytes를 설치했고 `preparedIdentitiesVerified=22`를 확인했다. manifest는 48,482 bytes이며 SHA256은 `89e02553807de145fbd5c28772559e7f6622adc6d66d2a214a548865ab7e9005`다. prepared 코드 지문은 `143fac771bd45decc8bfbb973c13ba9830a53d9d32e207212815c92beee8937d`로 새 20개 receipt와 일치한다. 이는 미게시·미활성 로컬 후보다.

새 모델 기본 ID·최종 자산 pin은 전체 SSR2·스킨/외곽선·실제 앱/CSP·시간 비교 게이트가 끝난 뒤 함께 검토한다. IAM과 운영 구성은 변경하지 않는다.
