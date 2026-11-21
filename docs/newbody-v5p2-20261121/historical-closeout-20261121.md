# v5p2/v4 작업 마감 기록 · 2026-11-21

**전체 완료·릴리스 승인 상태가 아니다.** 추가 실험을 종료하고 현재 통과·실패·미완료 결과를 보존했다. 기존 develop PR은 Draft를 유지한다. 필수 게이트가 미완료이므로 main PR은 만들지 않았다.

| 항목 | 확인 결과 |
| --- | --- |
| 원본 | 남성 v5p2 93,000정점, 여성 v4 94,901정점. 모델·리그·가중치·컨트롤러 변경 없음 |
| prepared | 실제 Linux/amd64 Blender 5.2.0, 최종 source·코드·플랫폼 identity로 20/20 통과 |
| 최종 Converter 파일 | 남녀 기본형·8.3등신·큰 커스텀 × 기본/살색가이드 12건 독립 재로드 통과 |
| 직접 파일 스킨·외곽선 | 20종 × 6스킨 × 굵기 0/.5/1/2 = 480/480 통과 |
| 직접 파일 CSP | 대표 22건 가져오기·저장·닫기·재열기 관찰. 앱 다운로드 검수와 구분 |
| 실제 BFF 기본형 전달 | 20/20 권위 패킷·실제 클라이언트 리더·디스크 저장·독립 재로드 통과 |
| 실제 BFF 전체 조합 | 353/480 완료. 미완료 검사는 종료하고 결과 보존 |
| 실제 네이티브 앱 | 10회 저장, 고유 파일 9개. 남성 기본형·여성 6스킨·외곽선 대표 포함 |
| 앱 다운로드 CSP | 고유 파일 9개 저장·닫기·재열기 관찰. 남녀 프리셋/큰 커스텀·다인물·기록 복귀 UI 전체 범위는 미완료 |
| 남성 SSR2 | 33,431,776 bytes. 동결한 후보 카탈로그 전체에서 seed 99·873421 독립 검사 모두 통과 |
| 여성 SSR2 | v6 33,444,528 bytes. 기존 실패 표본 재검사는 통과했지만 새 seed 99·873421 모두 정확도 기준 실패. 미승인 |
| 과거 데이터 | API에서 이전→신규→이전 카드·커스텀 ID/asset/source/control 보존 통과. 전체 복귀 UI 검수는 미완료 |
| 저장 화면 오류 | 5분 캐시 만료 후 FBX/인원/체형 정보가 바뀌는 문제 수정. 실제 앱 312초 유지 재검증 통과 |
| 앱 입력 정지 | macOS WebKit 스트림 정리 중 GC 교착을 관찰하고 일회용 reader 정리를 수정. 같은 앱 세션의 연속 저장에서 재발 미관찰 |
| 성능 | 동일 BVH·체형·스킨·고정 자원 비교 도구와 기능 점검만 완료. 공정한 cold/prepared/warm 반복 속도표는 미완료 |
| 역할 릴리스 | Converter 281파일·22 prepared identity, Inference 70파일의 로컬 S3 SDK/Linux installer 통과. 최종 BFF 역할 동결·설치 미완료 |
| AWS·운영 | 마감 읽기 전용 조회에서 staging 0/0(task147/155/58), production 1/1(task79/70/21), 이미지·자산 pin 동일 |

여성 v6의 전체 카탈로그 독립 검사 최댓값은 seed 99에서 few 14.580456856698625mm/basic 14.367747192597006mm, seed 873421에서 few 5.966923183827545mm/basic 11.527117096293308mm다. 기존 preset≤0.5/few≤5/basic≤10/all≤20mm·32MiB 기준을 유지했으며 반올림으로 승인하지 않았다. 실패한 표본은 이후에는 개발 회귀 검사로 취급해야 한다.

동결 후보 카탈로그 SHA256은 `210e9feeeffbbab84d44bdd4c34394c600c88c09e8ea4bd8114bd1b19bd9bec4`다. 남성 검사의 통과가 이 카탈로그의 여성 런타임이나 최종 서비스 릴리스 승인으로 전이되지 않는다. 새 `idw2-varying` 선택 모드와 관련 단위 검사는 별도 작업 트리 패치로 보존했으며 현재 PR 코드에는 포함하지 않았다. 현재 QA 실행 파일에도 이 실험 모드는 포함되지 않는다.

## 반영한 변경과 경계

신규 20종의 정확한 모델·UV·텍스처·geometry·가중치 pin을 추가하고 기존 22종과 기존 승인값을 보존했다. 새 승인은 검수한 posed full-body 파일 범위이며 CSP 내부 관절 편집이나 crop 승인으로 확대하지 않는다. `lod-defaults-20.v1`의 Converter 1280MiB + prepared 192MiB·최대22쌍·파일별 상한을 유지한다. 42종 스킨 계약 149,679 bytes를 위해 BFF 메타데이터 상한만 256KiB로 조정했다.

클라이언트 저장 화면의 분석·체형 쿼리는 화면이 열려 있는 동안 유지하고 완료 이벤트에는 검증한 실제 characterId를 기록한다. WebKit 교착이 관찰된 일회용 bounded response reader는 cancel 후 GC에 맡긴다. 크기 상한·취소·SHA 검증은 유지한다. 구현 커밋 `73a4e3820b264160940688776e972e518debd6a8`의 [CI](https://github.com/04JUNG/Standin-client/actions/runs/44882445502)는 frontend/Rust macOS·Windows 모두 성공했다. 마감 문서 커밋의 CI는 별도 조회한다.

검증은 localhost BFF·실제 Linux Converter·별도 QA 식별자/키체인/API에서 진행했다. 입력은 실제 BVH지만 통제된 로컬 작업 기록 fixture를 사용했으므로 이미지 분석·검색 정확도까지 검증한 결과가 아니다. 선형 스킨의 UI 굵기 step 정책과 API의 전체 굵기 검사를 구분한다. 동시 부하·조작 대기 시간이 섞인 기능 측정은 속도 개선 수치로 사용하지 않는다.

## 증거와 재개

[파일별 상태·SHA·독립 검사](closeout-status.json), [스킨 승인 근거](appearance-acceptance.json).

영구 보존: `/Users/dowon/dev/Standin-server/out/newbody-v5p2-closeout-20261121/progress`. 원본 snapshot, 최종 후보, 실패 후보, 샘플 캐시, 준비 파일, 실제 다운로드 FBX, CSP clip/화면, API receipt, 원시 성능 기능 점검, 코드 diff와 재개 지침을 보존했다. 임시 작업 위치는 `/private/tmp/standin-v5p2-closeout-20261121`다. 자격증명·환경 파일은 영구 산출물이나 PR에 넣지 않는다.

롤백 경계는 기존 운영 task/image/manifest pin이다. 이번 작업에서 서비스 활성화·운영 기본 alias 전환·main 병합·운영 앱 릴리스·업데이트 피드를 게시하지 않았으므로 운영 롤백 실행은 필요하지 않다. Apple 계약 오류는 해결된 상태이며 현재 미완료 사유가 아니다.

검토 PR: [server #244](https://github.com/04JUNG/Standin-server/pull/244), [BFF #208](https://github.com/04JUNG/Standin-app-server/pull/208), [infra #95](https://github.com/04JUNG/Standin-infra/pull/95), [client #234](https://github.com/04JUNG/Standin-client/pull/234). 모두 Draft·REVIEW_REQUIRED이며 관리자 우회나 자기 승인은 하지 않았다.
