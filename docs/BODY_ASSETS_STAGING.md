# 스테이징 체형 자산 9종 원격 등록

2026-10-12 등록. 2026-10-10의 전용 이미지에 포함했던 자산을 스테이징 AssetsBucket의
`body-models/releases/staging-9-20261012-9acb2ee7ec24/`에 게시했다.
`config/staging-body-assets.json`이 manifest key, SHA-256, converter 환경변수 매핑을 고정한다.
FBX와 PNG 본체는 Git에 포함하지 않는다.

## 등록 범위

- 기본 남녀, 청소년 남녀, 아동 공용, 탄탄형 남녀, 근육형 남녀의 FBX 9개.
- 차렷 PNG 9개, 실제 포즈 변환 QA 보고서 9개, 추론/BFF/converter 카탈로그.
- 완전한 manifest/GLB 쌍 20개. GLB가 없거나 renderer revision이 달라지면 기존 PNG 렌더 경로를 사용한다.
- 9종 모두 기존 검수된 정확한 pose ID 10개만 지원한다. 전체 라이브러리 승인이 아니다.
- 70개 자산, 총 161,743,930 bytes. S3 재다운로드 후 전체 파일 해시를 검증했다.
- manifest SHA-256: `9acb2ee7ec2444706107b5d1c5b264866dc35bdfc8918a31cbec997d12fc9d72`.

## 시작 순서

staging BFF, inference, converter, 향후 analysis-worker 태스크에 `body-assets-init`을 붙인다.
초기화 컨테이너는 태스크 IAM 역할로 해당 release prefix를 읽는다. manifest와 모든 해당 서비스
파일의 크기·SHA-256을 확인한 후 종료한다. 앱은 SUCCESS dependency 뒤에 시작한다.
다운로드 실패, 누락 또는 해시 불일치에서는 앱이 시작되지 않는다.

초기화 컨테이너는 공유 `body-assets` volume에 쓰고 앱은 같은 volume을
`/app/body-staging`에 read-only로 mount한다. 기존 이미지에 포함된 동일 경로는 volume에 가려지므로
새 태스크는 원격 자산을 사용한다. Python 서비스는 기존 boto3, BFF는 기존 AWS SDK를 사용한다.
별도 공개 자산 URL이나 장기 서명 URL은 필요 없다.

GitHub 앱 배포 workflow는 현재 task definition에서 메인 container image만 교체한다.
따라서 volume·초기화 container·SUCCESS dependency·자산 환경변수는 다음 앱 배포에도 유지된다.
이 PR은 CDK로 task definition을 다시 만드는 경우에도 같은 설정을 복원한다.

설정된 BFF에는 BODY_SELECTION_ENABLED/BODY_UX_ENABLED를 켜고, inference에는 기존 Gemini 체형
감지를 켠다. converter는 10월 10일의 검증 환경과 같은 2 vCPU/4 GiB, 90초 변환 상한을 사용하며
BFF 대기 상한은 120초다. production에는 자산 초기화와 체형 flag를 추가하지 않는다.

## 배포와 비활성화

```bash
npm ci
npm run typecheck
python3 scripts/test-body-assets-init.py
node scripts/test-body-assets-init.mjs
npm run synth -- --no-lookups -o cdk.out-staging -c envName=staging -c stagingActive=true
node scripts/assert-body-assets.mjs on cdk.out-staging/StandinStagingApp.template.json
# 인프라 변경 검토 후 스테이징만 배포
npx cdk deploy StandinStagingApp -c envName=staging -c stagingActive=true
```

`-c stagingBodyAssetsEnabled=false`로 초기화와 체형 환경 설정을 생략할 수 있다.
`stagingActive` 기본값은 기존처럼 false이며, 앱 테스트 시 true를 명시한다.

원격 자산을 갱신할 때에는 새 release prefix를 사용하고 검수 범위와 파일 해시를 먼저 확인한다.
파일들을 먼저 업로드하고 manifest를 마지막에 게시한 뒤 config의 key/SHA-256을 함께 갱신한다.
같은 prefix의 파일을 덮어써서 기존 Job의 asset identity를 바꾸지 않는다.

실제 등록 시 기존 스테이징 task definition을 보존해 초기화만 추가했다. BFF와 유휴 worker에는
`BodyAssetsRead20261012` inline policy로 해당 release의 GetObject만 허용했다. CDK 적용 뒤에는
동일 권한이 CDK의 기본 policy에 들어가므로 이 수동 policy는 제거할 수 있다.

## 확인

- 초기화 CloudWatch 로그의 `body_assets_ready`, manifest SHA-256, role별 파일 수:
  BFF 10 / inference 19 / converter 50.
- Converter `/characters`와 BFF `/v1/models`에서 9개 body character ID가 available인지 확인.
- 지원 pose ID를 포함한 Job의 `/body-options`에서 9종이 selectable인지 확인.
- 차렷 PNG URL 9개가 200이고 등록한 PNG 해시와 일치하는지 확인.
- `/body-previews`와 실제 GLB/PNG의 character hash가 저장된 선택과 일치하는지 확인.
- 새로운 태스크에서도 초기화가 재실행되는지 확인. GitHub 배포 성공만으로 자산 등록 성공을 판단하지 않는다.
