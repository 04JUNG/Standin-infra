# develop → main 최종 승격 검토 · 2026-11-12

기준: main `92327d64870b12757960f5b512dc010f2ec22d62`, develop `95547b337ebc3233b39e2351ad628f157b6b7654`.

## 승격 결과

현재 main 기반 release 브랜치에 develop의 제품 코드를 모두 포함한다. 이전 squash 이력에서 중복된 merge 충돌을 정리하고 main 전용 마케팅/유입 연결, macOS bar 복원, 기존 0.2.9 release notes를 보존하고 새 설치 파일 발행이 가능한 0.2.10을 준비했다. develop에 있는 파일 삭제는 없고, 추론의 pipeline/search/features/refine/converter 실행 코드가 develop과 같음을 확인했다.

코드뿐 아니라 production 설정도 승인된 develop 제품 수준으로 맞춘다.

- 같은 SHA256의 역할별 체형 manifest와 남성 v0.8.0·여성 v0.4.0 presets, 기본 `male-base-v0-8-0`.
- `lib-20261110-da2ead1e` 검색 번들, outline-3503 썸네일 overlay, props-r7 미리보기, reviewed58 FBX 자산.
- production 클라이언트의 interactive preview ON. BFF/Converter의 private transport ON과 production 전용 48자 credential. staging credential·URL·S3 bucket은 재사용하지 않는다.
- 수치 체형/손/저장/분석 진행/semantic 검색 등 develop 실행 코드 유지. 자동 체형 감지는 OFF.
- **New Refine RC4 OFF**, legacy **v2.5.4 aggressive**, 안전 selector ON, torso·v3 shadow/evidence OFF.
- production replay는 기존 코드의 명시적 동의 게이트와 private S3 저장을 사용한다. staging의 assumed 수집, staging QA/CSP review 전용 도구, 현재 사용자 UI에서 비활성인 scene export/worker를 production에 복제하지 않는다. 운영 주소·DB·사용자 인증·quota·앱 식별자는 운영 값으로 유지한다.

## 준비 및 검증

동일 릴리스 객체 11,998개 중 11,995개를 production의 새 키에 조건부 복사하고 기존 3개는 전체 S3 checksum/identity 검증 후 재사용했다. `IfNoneMatch=*`와 원본 ETag 조건으로 기존 객체 덮어쓰기를 차단했다. 서비스·DB·secret·ECS 배포는 실행하지 않았다. 독립적인 read-only 재검사에서도 11,998개 모두 일치했다. 증거: infra `docs/PRODUCTION_ASSET_PARITY_2026-11-12.json`, `docs/PRODUCTION_ASSET_VERIFICATION_2026-11-12.json`.

- inference 전체: 3,598 passed, 11 skipped. production/staging/Recall/Converter 배포 계약 69 passed. frozen RC4 unittest 59 passed(원본 runtime hash 보존).
- BFF: Node 22 전체 1,121 passed, 2 skipped + production 설정 검사 6 passed. 실제 일회용 PostgreSQL 16의 acquisition 동시성/동의/철회 검사 통과. 마케팅 탭 DOM과 develop 탭 공존 검사 통과.
- client: 최종 0.2.10 Node 22 전체 1,576 passed, 5 skipped, typecheck/build/release:check 및 lint(error 0) 통과. production interactive flag를 켠 실제 Vite 빌드도 통과했다. 기존 Windows/macOS Rust PR 검사가 모두 통과했다.
- infra: typecheck/build, prod/staging/off/canary synth, 역할별 body pin·환경 격리·서비스 인증·동의/저장·private Converter·refine 정책·자산 보호 검사를 실행한다. PR CI에서 동일 검사를 다시 수행한다.

## 실제 승격 순서

1. 네 PR의 검사를 통과시키고 main에 병합해 새 inference/BFF 이미지를 빌드한다. Converter는 staging에서 실제 검증한 `fd2212e123ddc07bb53e8abb10967d96cd7d0273` 이미지를 infra가 고정한다.
2. 최신 main의 infra를 적용한다. 새 production body/preview/FBX 자산 pin, private Converter credential, explicit replay 저장, legacy refine 정책이 여기서 설정된다. 동일 task 내 main과 initializer runtime 연결을 유지한다. private Converter는 한 replica의 snapshot 일관성을 위해 stop/start 교체를 사용한다.
3. inference/BFF/Converter의 main 배포를 재실행한다. 추가한 production parity preflight는 이전 body/preview pin이나 staging credential이 남아 있으면 task 갱신 전에 차단한다. 이미지 빌드 성공만으로 같은 수준 승격이라고 판단하지 않는다.
4. 운영 health·capability·모델·손/체형 변경·2.5.4 refine·최종 FBX/카메라·동의/저장 흐름을 확인한 뒤 새 버전 설치 파일을 별도 release workflow로 만든다.

PR 생성/갱신은 운영 배포와 다르다. 검사 시점 운영 inference v2.5.3/task 53, BFF 59, worker 25를 자동 변경하지 않았다. 원래 로컬 미커밋 작업도 사용하지 않았다.

## 전체 저장소 범위

server/BFF/client/infra 4개 승격 PR. 랜딩 develop 트리는 과거 main `cb2a74b`에 이미 포함되어 새 승격 내용이 없으며, `Standin-master-docs`, `demo-repository`에는 develop이 없다.
