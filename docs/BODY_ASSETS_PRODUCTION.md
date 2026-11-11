# 운영 체형·검색·미리보기 승격 계약

2026-11-12 승격안. 설정의 정본은 `config/production-body-assets.json`과 `config/production-runtime-parity.json`이다. production body release는 승인된 develop의 역할별 manifest/bytes와 같고, 각 환경의 별도 assets 버킷에서 설치한다.

| 역할 | manifest SHA256 |
|---|---|
| inference | `9acb2ee7ec2444706107b5d1c5b264866dc35bdfc8918a31cbec997d12fc9d72` |
| BFF/worker | `0897cb6c18fdef3e24b945bc2df9b09e8e7f65579130a98127e97c72264a97cc` |
| Converter | `f590cdb9f4ed0a78fb331bdde90c715c526c1314ce03d046432ac8eeaf3bf973` |

기본 체형은 `male-base-v0-8-0`, 여성 preset은 v0.4.0이다. `/app/body-staging`은 카탈로그의 고정된 로컬 경로이며 staging 서비스를 참조하지 않는다. main 컨테이너는 body/reviewed FBX 볼륨을 읽기 전용으로 사용하고 모든 initializer 검증 후 시작한다. Python initializer는 승인된 역할별 digest, Node initializer는 현재 BFF runtime과 동일한 이미지를 사용한다.

검색은 `lib-20261110-da2ead1e`와 그에 맞는 outline-3503 overlay, props-r7 preview, reviewed58 FBX를 사용한다. 세부 키/해시는 production runtime profile에 고정되어 있다. private interactive transport는 운영 전용 secret을 BFF와 Converter에만 공유한다. snapshot은 단일 Converter task의 private 임시 공간에 보관되며 restart 시 기존 handle은 폐기된다.

자산 준비는 `scripts/promote-production-assets.py`가 기본 read-only 계획을 출력하고 `--apply`에서만 빠진 새 키를 복사한다. source inventory/SHA, target identity, destination `IfNoneMatch=*`를 검사하며 기존 객체는 교체하지 않는다. 이번 준비 결과는 `docs/PRODUCTION_ASSET_PARITY_2026-11-12.json`에 있다.

실제 반영은 `docs/DEVELOP_MAIN_PROMOTION_2026-11-12.md`의 이미지 빌드 → infra 적용 → backend parity 검사/배포 → 실제 제품 확인 순서를 따른다. 기존 운영 DB·주소·인증·quota를 유지한다. New Refine RC4는 OFF, 기존 v2.5.4 aggressive/안전 selector는 ON이다. production replay는 explicit 동의와 private S3 저장을 요구한다.
