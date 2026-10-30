# "지금 이 일을 뽑는 곳" 구현 계획

명세: `docs/JOB_POSTINGS_MAP_SPEC.md` · 작성일: 2026-10-26

## 결정 기록 (명세와 다르거나 명세가 열어둔 부분)

| 항목 | 결정 | 이유 |
|---|---|---|
| 작업 브랜치 | `claude/hopeful-davinci-jfunzk` (`aws` 기준으로 재설정) | 이 작업 세션은 지정된 브랜치에만 push할 수 있어서 `feature/job-postings-map` 대신 사용. 내용은 같음 |
| 인증키 | 작업 환경에 `WORK24_RECRUIT_AUTH_KEY`, `KAKAO_REST_API_KEY` 없음 | 실제 수집·직종 탐색은 건너뛰고, 투자분석가·보험상품개발자는 `tbd` 유지 |
| 고정 데이터 모드의 데이터 위치 | `POSTINGS_DATA_DIR`가 없으면 `reports/postings-fixture` | 가짜 스냅샷이 실제 스냅샷 폴더(`reports/postings`)를 덮어쓰지 않게 |
| 고정 데이터 스냅샷 표시 | 스냅샷에 `fixture: true`를 넣고, 실제 모드 서버는 이 스냅샷을 무시 | 가짜 값이 실제 화면에 나가지 않게(11장) |
| 고정 데이터 모드의 기준 날짜 | 마감·등록기간 판정은 `2026-10-26 12:00 KST` 고정 | 고정 XML의 날짜가 시간이 지나도 같은 결과를 내도록. `fetched_at`은 실제 시각 |
| 키는 있는데 스냅샷이 아직 없을 때 | API 상태 `error`(“잠시 후 다시 시도해줘”) | 명세의 6개 상태 중 가장 맞는 문구 |
| 기능 꺼짐(`POSTINGS_ENABLED=false`) | API 상태 `unconfigured` | 같은 이유 |
| coTp 조회 자체가 실패 | `checks.company_type_filter_applied[코드] = null`, 해당 기업형태 표시 끔, `errors`에 기록 | “적용됨/무시됨”과 “확인 못 함”을 구분 |
| 키워드 모드의 직종 검증 | `occupation_filter_applied: null` | 직종코드를 보내지 않았으니 검증 대상 아님 |
| 기업형태가 여러 coTp에 동시에 걸리면 | 01(대기업) → 04(공공기관) → 05(외국계) 순으로 첫 번째 | 응답 기반 표시만 하고 추정하지 않음 |
| 지도 마커 | 정확 위치=작은 점, 대략 위치=반투명 큰 원 (둘 다 `L.divIcon`) | markercluster와 호환, 기본 아이콘 이미지 경로 문제 회피 |
| discover 스크립트의 지도 반영 | 후보와 제안만 문서로 내보내고, `--apply`일 때만 매핑 파일에 기록 | “같은 일인지”는 사람이 최종 확인 |
| 표본 집계 | `npm run postings:sample -- --tally` | 체크 결과를 직업별 정확도로 집계 |
| E2E 외부 요청 | OSM 타일·웹폰트 요청은 Playwright에서 빈 응답으로 가로챔 | 네트워크와 무관하게 “콘솔 에러 0건”을 검증하려고 |

## 모듈 구성

```
src/lib/postings/
  config.ts        환경변수 → 설정
  work24Client.ts  고용24 목록/상세 호출, XML 파싱, 키 마스킹, 고정 데이터 클라이언트
  parse.ts         wanted → 항목, 날짜/마감/급여, 중복 제거, 제목 필터
  regions.ts       시도 코드·문자열 정규화, 수도권 판정
  geocoder.ts      카카오 지오코딩, 캐시, 고정 데이터 지오코더
  occupationMap.ts 매핑 파일 zod 검증
  collector.ts     직업 하나 수집 + 조건 검증 + 품질 지표
  store.ts         스냅샷/상태/품질 파일, API 상태 결정
  service.ts       갱신 실행기(잠금), API 응답 조립
  scheduler.ts     30초 뒤 첫 확인, 1시간마다 확인
scripts/postings-refresh.ts / postings-discover.ts / postings-sample.ts
app/components/postingsSection.js, postingsMap.js, app/styles/postings.css
```

## Phase 진행

0. 브랜치·명세·계획 → 1. 클라이언트·파싱·지역 + 고정 데이터 + 단위 테스트 → 2. 매핑 파일 + discover →
3. 지오코더·수집기·저장소·스케줄러·스크립트·API → 4. 화면 → 5. 관리자·문서·8장 수정 → 6. E2E·점검·push·PR
