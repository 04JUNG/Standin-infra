# Prepared neutral 20종의 유한 설치 예산

서버 prepared-presets PR의 20종 번들은 기존 768 MiB 상한을 넘는다. 실제 배포에서는 이 저장소의 `scripts/body-assets-init.py`가 task command에 인라인으로 들어가므로 서버 패키저 변경만으로는 설치할 수 없다.

새 manifest의 명시적 `budgetProfile: prepared-neutral-20.v1`에만 다음 정책을 적용한다.

- 일반 자산 합계는 기존 768 MiB 그대로다.
- Converter role의 `fbx/prepared-<64hex>.fbx`와 같은 key의 `qa/prepared-<64hex>.json`만 추가 192 MiB를 쓸 수 있다. 전체 상한은 960 MiB다.
- 준비 FBX 한 개 64 MiB / receipt 한 개 256 KiB 이하, 최대 22쌍이다. 현재 20종과 이전 기본형 두 쌍을 보존할 수 있다.
- 경로 allowlist, 중복 경로, 역할, 각 파일 크기·SHA256, manifest SHA256 및 64 KiB 한도는 계속 검사한다. 쌍이 없거나 잘못된 역할/확장자/개수/프로필이면 설치 전에 거부한다.
- 프로필 없는 기존 릴리스는 계속 768 MiB다. cap을 임의로 늘리는 환경변수는 없다. BFF/Inference는 확장 프로필을 사용할 수 없다.

CPU·메모리·ECS service·이미지·S3 key·카탈로그/스킨 pin은 바꾸지 않는다. #90의 `lib/app-stack.ts`와 변경 파일이 겹치지 않는다. PR만으로 새 번들이 활성화되지는 않는다.

body-assets Converter task는 기존 2 vCPU / 4 GiB, init soft memory reservation은 128 MiB다. 파일을 직렬로 읽고 기존 일반 파일 최대 300 MiB도 유지한다. 새 볼륨 설치의 body 자산 상한은 960 MiB이고 이전 설치와 staging이 동시에 있는 재설치는 최대 1,920 MiB(1.875 GiB)다. 기본 Fargate Linux 1.4+ 저장소 20 GiB에서는 이미지 압축/해제 크기와 다른 볼륨을 차감해야 한다([AWS](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/fargate-task-storage.html)). 전체 운영 task 자유 공간을 실측한 결과는 아니다.

서버에서 승인 원본 193개 파일의 크기·SHA를 확인했고, 현재 develop Linux 번들 233개 / 910,022,778 bytes(867.87 MiB)를 실제 같은 Python 설치기로 로컬 설치했다. 20종 모두 런타임 `prepared`를 확인했다. main은 별도 코드 식별값의 Linux 번들을 생성·검증한다. 서버 QA 문서에 플랫폼·런타임·프리셋별 key/해시·실측을 기록한다.

검증 명령:

```sh
python3 scripts/test-body-assets-init.py
node scripts/test-body-assets-init.mjs
```

Python 테스트는 기존 role/path/hash/pin 검사와 함께 새 예산의 경계, 일반 자산 상한 유지, 쌍/역할/개수/receipt 제한, 손상 시 기존 설치 보존과 복구를 검사한다. 서버 측 테스트는 정확한 승인 20종, catalog/manifest pin·기본값 불일치, Darwin 준비 파일 거부, 기존 두 쌍의 보존, 중복 경로, 전체 번들 설치·FBX 재로드도 검사한다.

승인된 다음 배포에서는 서버 PR과 이 설치기 PR을 함께 사용하고, 최종 Converter 이미지의 코드/build/플랫폼과 prepared identity가 일치하는 번들을 새 immutable prefix로 발행해야 한다. manifest key/SHA·parity pin·인라인 initializer를 한 계획에서 검토한다. 이전 task definition/manifest pin을 보존해 rollback한다. 기존 큰 자산을 삭제할 필요가 없다.

이번 작업은 별도 develop/main 기능 브랜치와 PR까지다. S3 쓰기·SSM·ECS·운영/스테이징 배포·병합·릴리스를 실행하지 않는다. 기존 pin은 그대로다.

대응 서버 PR: [#236](https://github.com/04JUNG/Standin-server/pull/236). main 실제 사전 빌드 이미지 eca16e9d…(source f31558c30, Linux/amd64, uid10001)의 consumer 코드에서도20종 prepared를 확인했다. 기존196객체를 보존하는 Linux197→233 확장·전체 설치·손상 거부·기본2종 rollback을 실제 로컬 볼륨에서 검사했다. 실제 ECS/S3 다운로드·기동 시간은 미검증이며 기존120초 startTimeout/health startPeriod는 변경하지 않는다.
