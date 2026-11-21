# v5p2/v4 검증 진행 상태 · 2026-11-22

**아직 전체 완료·운영 승인 상태가 아닙니다.** 기능·자산·정확도와 전체 API 경로는 통과했습니다. 실제 앱 대표 조건 3회 반복은 16/36회이며, Mac 화면 잠금으로 남은 20회가 대기 중입니다. main PR은 모든 필요한 검증을 마친 뒤 만들라는 작업 조건에 따라 아직 생성하지 않았습니다.

| 항목 | 확인 결과 |
| --- | --- |
| 원본 | 남성 v5p2 93,000정점 / 여성 v4 94,901정점, source·컨트롤러·리그·가중치 보존 |
| prepared | 최종 source·플랫폼 identity로 20/20, Linux/amd64 Blender 5.2 |
| SSR2 | 최종 catalog `6e35fd3b12b345915e6e2430644a22bbe9ca6349e1948ac89122f44a6aa7aa29`에서 남성 2개 seed와 여성 새 2개 seed 독립 검사 통과. 여성 이전 실패 seed6개도 회귀 통과 |
| 정확도·용량 | preset≤0.5 / few≤5 / basic≤10 / all≤20mm, 32MiB 기준 유지. 실제 client parser/evaluator 및 큰 커스텀 source 오차 확인 |
| 최종 Converter FBX | 기본형·8.3등신·큰 커스텀 × 두 스킨 12건 독립 재로드 |
| 전체 외관 조합 | 직접 파일 480/480 재로드 + 실제 BFF 전달·클라이언트 디코더·디스크 저장 480/480 |
| 기본형 BFF | 20/20 실제 다운로드 후 독립 재로드 |
| 실제 앱 기능 | 기존 baseline24개 파일 관찰/고유23개와 같은 고유23개 CSP 저장·닫기·재열기, 최종 reader로 남녀 큰 커스텀 2개 추가 검수. 합계 기능 파일 관찰26개/고유25개 |
| 역할 installer | Converter281파일, Inference70파일, BFF84파일을 해당 실제 Linux 이미지·SDK로 설치하고 모든 SHA 확인 |
| API 성능 | **36/36회·18개 old/new 쌍 완료**, 조건별 단일 관찰값. [시간표·CSV/JSON](https://github.com/04JUNG/Standin-server/blob/codex/newbody-default-staging-20261118/docs/newbody-v5p2-20261121/API-PERFORMANCE-36-20261122.md) |
| 실제 앱 성능 | **16/36회 완료**, 대표 조건 3회 반복 중 남은20회는 화면 잠금 해제가 필요 |
| 코드·리뷰 | 기존 develop Draft4개에 최종 runtime·실제 앱/CSP 파일 SHA 반영. 소스 CI 성공. main 선택 이관 코드와 핵심122파일 보존·관련 테스트 완료, 새 main PR/원격 CI는 검증 종료 후 진행 |
| 운영 | API 완료 시점 읽기 전용 조회에서도 staging0/0·production1/1, task/image/asset pin 동일. 배포·기본값 전환·main 병합·운영 앱 릴리스 없음 |

## 85초 기록의 의미

85초는 기존 모델의 로컬 source-cold QA 기록입니다. 같은 공식 API 조건의 첫 남성 기본형 관찰은 기존81.880초, 신규68.114초(file-ready)입니다. 운영 Converter는 QA와 같은2 CPU/4GiB지만 운영 BFF는1 CPU/2GiB, QA는0.5 CPU/1GiB이며 Mac/x86 실행 환경도 다릅니다. 운영의 과거40초대와 직접 대조하거나 운영 지연 시간으로 보장하지 않습니다. warm은 같은 포즈·체형·스킨의 검증된 결과를 재사용하는 조건입니다.

## 실제 실행과 화면

[남성 최종 커스텀 추적 HTML](https://github.com/04JUNG/Standin-server/blob/codex/newbody-default-staging-20261118/docs/newbody-v5p2-20261121/trace/male/native-export.html) / [JSON](https://github.com/04JUNG/Standin-server/blob/codex/newbody-default-staging-20261118/docs/newbody-v5p2-20261121/trace/male/native-export.trace.json), [여성 최종 커스텀 추적 HTML](https://github.com/04JUNG/Standin-server/blob/codex/newbody-default-staging-20261118/docs/newbody-v5p2-20261121/trace/female/native-export.html) / [JSON](https://github.com/04JUNG/Standin-server/blob/codex/newbody-default-staging-20261118/docs/newbody-v5p2-20261121/trace/female/native-export.trace.json). 실제 앱의 권위 미리보기→다운로드 파일·영수증 SHA→독립 Linux 재로드0오차→같은 파일의 CSP 저장·재열기를 연결했고 브라우저에서 표시를 확인했습니다. 이 두 사례의 기능 계측을 공정한 반복 성능 수치로 사용하지 않습니다.

동일 BVH·공개 체형값·기본 스킨·외곽선0·실제 카메라 행렬로 대조한 첫 source-cold 실제 앱 화면:

| 성별 | 기존 | 신규 |
| --- | --- | --- |
| 남성 | [권위 미리보기](https://github.com/04JUNG/Standin-server/blob/codex/newbody-default-staging-20261118/docs/newbody-v5p2-20261121/native-perf-r1-male-old-source-cold-authoritative-ready.png) | [권위 미리보기](https://github.com/04JUNG/Standin-server/blob/codex/newbody-default-staging-20261118/docs/newbody-v5p2-20261121/native-perf-r1-male-new-source-cold-authoritative-ready.png) |
| 여성 | [권위 미리보기](https://github.com/04JUNG/Standin-server/blob/codex/newbody-default-staging-20261118/docs/newbody-v5p2-20261121/native-perf-r1-female-old-source-cold-authoritative-ready.png) | [권위 미리보기](https://github.com/04JUNG/Standin-server/blob/codex/newbody-default-staging-20261118/docs/newbody-v5p2-20261121/native-perf-r1-female-new-source-cold-authoritative-ready.png) |

## 남은 작업

1. 잠금 해제 후 남은 실제 앱20회 저장, 대표 조건3회 반복 중앙값·전체 범위 확정.
2. 최종 비교·전후 화면과 provenance 보고서를 기존 PR 문서에 반영.
3. 최신 main과 기존 대응 PR 여부를 다시 확인하고 필요한 변경만 관련4개 repo의 새 Draft PR로 생성. CI·필수 타인 리뷰 상태를 기록. 병합·배포는 하지 않음.

현재 Draft: [server #244](https://github.com/04JUNG/Standin-server/pull/244), [BFF #208](https://github.com/04JUNG/Standin-app-server/pull/208), [infra #95](https://github.com/04JUNG/Standin-infra/pull/95), [client #234](https://github.com/04JUNG/Standin-client/pull/234).

새 encoding을 지원하는 client와 버전이 맞는 BFF·Converter 코드/승인된42종 스킨·역할 자산 묶음을 먼저 준비해야 합니다. 구형22종 manifest와 새 코드의 혼합 배포는 승인 검사가 실패하므로 지원하는 조합으로 간주하지 않습니다. 현재 운영의 접근 코드·운영자 설정·업데이트 feed는 바꾸지 않았습니다.

전체 원시 수치·독립 검사·화면은 위 서버 검증 문서에 연결했습니다.
