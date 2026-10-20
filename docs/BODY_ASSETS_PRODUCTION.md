# 운영·스테이징 체형 및 검색 기능

2026-10-21 운영 활성화 설정. 사용자 요청에 따라 스테이징에서 사용 중인 체형 릴리스를 운영의 별도 assets 버킷에 복사했다. manifest는 마지막에 게시하고 149개 파일(237,798,188 bytes)의 SHA256을 운영에서 다시 내려받아 검증했다.

## 고정 자산과 이미지

- 릴리스: `shape-20261017-m072-f034`
- manifest: `body-models/releases/shape-20261017-m072-f034-c481055df5cd/manifest.json`
- manifest SHA256: `c481055df5cd980c6918d32c9620795faaa8d3f5d764ea8ce5cbf52e5dc4745f`
- 남성 0.7.2·여성 0.3.4의 수치 조절 가능한 20종, 기존 등록 자산, shape source/controller, SSR runtime, PNG/GLB, 각 서비스 카탈로그.
- Converter 운영 이미지: `3f9b0993f042dd829d5f12dd87e499eae5f1cc9e`, 검증한 digest `sha256:f9ddbfde0068f95cff8c36272d71c98131116c78fc509d197e426009620154c9`.
- 초기화 이미지는 역할별 검증한 digest로 고정한다. 신규 manifest 경로 허용 목록에는 shape-bakes, sources 및 runtime을 포함한다.
- 기존 supportedPoseIds·검수·저장 권한을 유지한다. 자산 설치만으로 검수 범위를 확대하거나 저장 권한을 높이지 않는다.

각 환경의 `config/*-body-assets.json`이 manifest와 Converter FBX 매핑을 선언한다. `/app/body-staging`은 카탈로그에 고정된 컨테이너 내부 경로이며, 운영에서 스테이징 S3나 서비스를 읽는다는 뜻이 아니다. 메인 컨테이너는 읽기 전용 볼륨을 사용하고 초기화가 모든 해시를 확인한 뒤에만 시작한다.

## 배포 순서

1. 새 immutable 릴리스 경로에 자산을 먼저 게시하고 모든 파일 해시를 확인한다. 기존 자산 경로를 덮어쓰지 않는다.
2. 운영 DB·시크릿·네트워크·개인정보 설정을 보존한 후보 태스크로 Converter와 추론을 격리 실행한다.
3. Converter → 추론 → BFF 순서로 롤링 배포하고 각 단계에서 health와 실제 기능 계약을 확인한다. SQS 유휴 worker는 desiredCount=0을 유지한다.
4. BFF beta GitHub environment의 `HAND_SELECTION_ENABLED`, `SEMANTIC_SEARCH_ENABLED`도 `true`로 설정한다. 앱 배포 workflow가 이 값을 다시 주입하므로 태스크 환경변수만 바꾸면 다음 배포에 꺼진다.
5. 추론 저장소 beta 환경에도 `ROUTING_FULLBODY_ENABLED=1`, `POSE_MODEL_VARIANT=humanart-m`, `POSE_CANARY_STAGE=canary-100`, `VLM_PERSON_TAGS=1`을 지정한다. main workflow의 기본 라우팅 값은 0이므로 태스크만 바꾸면 다음 배포에서 검색이 꺼진다.
6. API 임시 설치로 models·body-preferences·body runtime/PNG·손 카탈로그/썸네일·자연어 실제 검색을 확인하고 임시 설치 데이터를 삭제한다.

운영 추론 이미지와 pose library는 운영의 최신 버전을 유지한다. `ROUTING_FULLBODY_ENABLED=1`, `ROUTING_PREPARE_ASSETS=1`, `POSE_CALIBRATION_FROM_MANIFEST=1`, `POSE_MODEL_VARIANT=humanart-m`은 함께 적용한다. 스테이징의 과거 library URI를 운영에 복사해 최신 라이브러리를 되돌리지 않는다.

BFF는 BODY_SELECTION/UX/SHAPE_EDIT/SHAPE_BAKE 플래그를 켠다. Converter는 shape registry와 300초 shape 상한, BFF는 320초 shape 상한을 사용한다. 일반 변환 상한은 각각 90초/120초다. 운영의 선택 동의, REVIEW_WITHOUT_QUALITY_CONSENT=false, 쿼터와 저장 정책은 변경하지 않는다.

## 검증과 되돌리기

`npm run typecheck`, Python/Node installer 검증, production/staging synth, `assert-body-assets.mjs on`, 환경 분리 검사와 기능 비활성화 synth를 실행한다. API 기능 성공을 서비스 기동 성공과 구분한다. 설치 앱 UI 검증은 별도다.

이 작업은 현재 운영 task definition을 원본으로 보존하고 필요한 부분만 갱신한다. 문제가 발생하면 변경 전 task definition으로 ECS 서비스를 돌린다. GitHub의 두 기능 변수도 이전 값으로 되돌린다. 새 자산은 immutable 경로에 남겨 재현·롤백에 사용하며 기존 자산은 그대로다.

CDK 전체 배포 전에는 `cdk diff`로 현재 이미지·태스크·스케줄러 상태와 대조한다. 운영 중 다른 세션이 배포한 버전이나 유휴 worker의 상태를 과거 값으로 덮어쓰면 안 된다. `productionBodyAssetsEnabled=false` 또는 `stagingBodyAssetsEnabled=false`로 자산 초기화를 생략하고, 손·자연어는 `handSelectionEnabled=false`, `semanticSearchEnabled=false`로 별도 비활성화할 수 있다.


## 검색 후보의 저장된 참고 이미지

운영 `poseLibraryKey`는 `lib-20261020-095b99ca`의 DB·BVH를 유지한 고정 번들을 가리킨다. DB SHA256은 `4e7bec1d99cf889fd8cc90be8e3b27ab8805be0a5e41cca01479f357cf880880`이다. 기본 체형 포스터는 5,862개 포즈 × 5개 범위 = 29,310장이다. PNG 디코딩·소스 BVH·템플릿·렌더러 해시를 확인한다. 전체 번들의 SHA256은 `4786a62e2feb74e9e2f85deeb6c84d1b42130a20ca1ce1dcc303cd92f7d2e47c`이다.

`human-templates` 5개는 다섯 체형이 아니다. 기존 `standin-master-v2` 남성 참고 모델 하나의 full·half·bust·shoulder_head·head 범위별 템플릿이다. 새 남성 0.7.2·여성 0.3.4의 커스텀 체형 자산과 별개이며, 최종 FBX에 선택한 체형·손을 적용하는 계약은 변경하지 않는다. 목록에서 Converter를 실행하거나 검수·저장 권한을 올리지 않는다.

운영 버킷에 새 번들을 먼저 업로드하고 내려받은 아카이브 SHA256을 확인한 뒤 추론의 `POSE_LIBRARY_URI`만 교체한다. 기존 `pose-library/v1.tar.gz` 및 스테이징 URI는 변경하지 않는다. 현재 운영 task definition의 이미지·환경변수·볼륨·초기화 컨테이너를 그대로 보존한다. 배포 전 격리 태스크로 템플릿 5개·등록 포스터 응답 및 검색 DB 동일성을 확인하고, 문제가 있으면 직전 운영 task definition으로 되돌린다. 설치 앱 E2E와 구분해 기록한다.

새 검색 라이브러리를 발행할 때는 새 DB·BVH에 해당하는 미리보기 자산도 함께 만들고 `poseLibraryKey`를 새 고정 번들로 갱신해야 한다. 기존 v1 파일만 교체하면 이 고정 URI에 자동 반영되지 않는다. 스테이징은 `stagingPoseLibraryKey`로 별도 지정하며 미지정 시 기존 v1 경로를 유지한다.
