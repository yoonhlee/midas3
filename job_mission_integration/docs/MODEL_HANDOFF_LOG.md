# JOBSIM Model Handoff Log

기준 목적:
- 다른 모델/개발자가 바로 이어서 작업할 수 있도록 현재 상태, 변경 이력, 검증 결과를 한 곳에 유지한다.
- 코드 수정이 발생하면 이 파일도 같이 갱신한다.

갱신 규칙(필수):
1. 코드/설정/데이터 파일 수정 시 이 문서에 항목 추가
2. 각 항목에 최소 포함:
   - 날짜(YYYY-MM-DD)
   - 변경 이유
   - 수정 파일 목록
   - 검증 명령/결과
3. 완료되지 않은 작업은 `Open Items`에 남긴다.

---

## Current Snapshot (2026-05-26)

### Architecture
- Frontend: `app/**` (UI/상태/렌더)
- Backend: `server.ts`, `src/lib/**` (API/평가/추천/계약)
- Mission data: `missions/index.json`, `missions/scenarios/*.json`
- Tests/CI: `tests/**`, `.github/workflows/**`

### Main APIs
- `POST /api/evaluate`
- `POST /api/recommendations`
- `POST /api/logs`
- `GET /api/bootstrap`
- `GET /health`

### Current Scoring Notes
- 사분면 수행점수: `missionScore` 합(0~1)을 평균하여 사용
- 직무 적합도: `cosine similarity -> clamp(0..1) -> gamma(1.5) -> 0~100`

---

## Change History

### 2026-05-26 — 경계/테스트/운영 기본 정리 (기존 반영 상태)
왜:
- 프론트/백엔드/LLM 책임 분리, 회귀 감시 기본선 확보

주요 반영:
- API 계약 스키마 고정 (`src/lib/api/contracts.ts`)
- E2E/평가 안정성/파이프라인 CI 정리
- 운영 템플릿(PM2/Docker/.env 분리) 정리

관련 파일:
- `server.ts`
- `src/lib/api/contracts.ts`
- `.github/workflows/e2e.yml`
- `.github/workflows/eval-stability.yml`
- `.github/workflows/pipeline-sanity.yml`
- `docs/ARCHITECTURE_BOUNDARIES.md`
- `docs/OPERATIONS.md`

---

### 2026-05-26 — 미션 파일명 규칙 통일 + 충돌 방지
왜:
- `pilot_v1_...` 형식 제거, 시나리오 파일명 단순화
- 동일 직무코드의 복수 미션 충돌 방지 필요

반영:
- `missions/scenarios` 파일명 통일:
  - `K000000997_01.json`, `K000000997_02.json`
  - `K000001080_01.json`, `K000001080_02.json`
  - `K000001179_01.json`, `K000007519_01.json`
- `missions/index.json` 경로 동기화

중요:
- `K000000997.json` 단일 형식은 복수 미션에서 파일명 충돌 위험이 있으므로 미사용

검증:
- `npm run typecheck` 통과
- `npm run test:e2e` 통과

---

### 2026-05-26 — 사분면 수행점수 고정 버그 수정
왜:
- 수행점수가 구조적으로 낮게 고정되어 q1/q2 판별이 왜곡됨

원인:
- 미션 점수(이미 0~1)를 다시 축 개수(5)로 나눔

반영:
- `computePerformanceByJob`에서 불필요 `/5` 제거
- 범위 클램프(0~1) 적용

관련 파일:
- `src/lib/recommendation/engine.ts`

검증:
- `npm run typecheck` 통과

---

### 2026-05-26 — 직무 적합도 점수 과낙관 스케일 보정
왜:
- 기존 `((sim+1)/2)*100`은 하한이 높아 체감상 과대평가 경향

반영:
- 점수 변환을 `sim*100` 계열로 변경
- 감마 보정 적용: `score = (clamp(sim,0,1)^1.5)*100`
- 추천 카드 유사도%도 동일 스케일로 통일

관련 파일:
- `src/lib/recommendation/engine.ts`
- `app/components/resultDashboard.js`

검증:
- `npm run typecheck` 통과
- `npm run test:e2e` 통과

---

### 2026-05-26 — 동일 mission_id 충돌 방지 (self-report/log)
왜:
- 동일 `mission_id`가 2개 이상 존재해 self-report/로그가 섞일 위험

반영:
- self-report 키를 `mission_id` 단독에서 `mission.key` 우선으로 변경
- 로그에 `mission_key` 필드 추가 저장
- API 계약에 `mission_key` 허용 추가

관련 파일:
- `app/state/flowController.js`
- `app/components/missionScreens.js`
- `src/lib/api/contracts.ts`

검증:
- `npm run typecheck` 통과
- `npm run test:e2e` 통과

---

### 2026-05-26 — P1 안정화(임시결과 표시/escaping/저정보 방어)
왜:
- fallback 결과 신뢰도 혼동, XSS/레이아웃 리스크, 반복 장문 방어 부족

반영 1) fallback/임시결과 신뢰도 표기
- `evaluation.source` 도입: `llm | heuristic | unavailable | precheck`
- non-LLM 평가 시 점수 상한 1, confidence 상한 0.45
- 결과 화면에 "임시 추정 결과" 배지 노출
- non-LLM만 있을 때 근거 카드 생략

반영 2) escaping 보강
- 사전문항 textarea 값 escape 적용
- gap 섹션(`사전 예상/기대 대비`) escape 적용

반영 3) 저정보 답변 방어
- 반복 trigram/unique ratio/문자반복 기반 `isLowInformationAnswer` 추가
- 해당 케이스는 precheck 경로로 보수 처리
- golden 케이스 2개 추가(반복 장문, gibberish 장문)

관련 파일:
- `src/lib/evaluator/schema.ts`
- `src/lib/evaluator/evaluateAnswer.ts`
- `app/domain/evaluationWorkflow.js`
- `app/main.js`
- `app/components/resultDashboard.js`
- `app/components/missionScreens.js`
- `tests/golden-evaluations.json`

검증:
- `npm run typecheck` 통과
- `npm run pipeline:check` 통과
- `npm run test:e2e` 통과 (4 passed)
- `npm run eval:stability -- --runs=1 --out=reports/eval-stability-local.json --no-fail` 통과 (8 passed)

---

### 2026-05-26 — 적합도 분포 점검 스크립트 추가
왜:
- 감마값 조정을 로그 분포 기반으로 빠르게 판단하기 위해

반영:
- `scripts/analyze-compatibility.mjs` 추가
- npm 스크립트 `analyze:compat` 추가

사용:
- `npm run analyze:compat`
- `npm run analyze:compat -- --gamma=1.3`
- `npm run analyze:compat -- --gamma=1.8`

관련 파일:
- `scripts/analyze-compatibility.mjs`
- `package.json`

---

### 2026-05-26 — 문자 깨짐(혼합 스크립트) 정정
왜:
- 일부 한국어 텍스트에서 `분석`의 `석`이 한자로 치환되어 표시되는 문제 수정

반영:
- 한자 혼입 형태를 모두 `분석`으로 정규화
- 관련 파이프라인 설명/라벨 텍스트 일괄 정정

관련 파일:
- `pipeline/03_factor_analysis.py`
- `pipeline/tune_temperature.py`

검증:
- 소스 범위(`app/src/pipeline/tests/docs/missions/scripts`)에서
  한자 혼입/비의도 스크립트 패턴 재검색 시 미검출
- `npm run pipeline:check` 통과

---

### 2026-05-26 — 감사 P1 우선항목 1차 반영
왜:
- 운영 즉시 위험(P1) 항목부터 선반영해 비용/가용성/집계 정확도 리스크를 줄이기 위해

반영 1) `/api/evaluate` 보호 강화
- `answer` 길이 상한 적용 (`max 3000`)
- `/api/evaluate` IP 기준 레이트리밋 추가 (기본 분당 10회)
- 선택형 API 토큰 인증 추가 (`API_SHARED_TOKEN` 설정 시 `x-api-token`/Bearer 필수)

반영 2) 로그 운영성 개선
- 평가 로그를 일자별 파일로 분리 저장:
  `reports/evaluation-logs-YYYY-MM-DD.jsonl`
- 로그 보관일 기반 정리(기본 14일)
- `docker-compose.yml`에 `./reports:/app/reports` 볼륨 추가
- `analyze:compat`가 일자별 로그 파일들을 자동 집계하도록 수정

반영 3) 결과 정확도/식별자 개선
- 추천엔진 이중 정규화 제거 (`similarityProfile` 재정규화 제거)
- `mission_id`를 배치 suffix 포함 값으로 전부 유니크화
  (중복 집계/매칭 충돌 방지)
- non-LLM cap 정책 조정:
  - `heuristic`: score cap 2 / confidence cap 0.55
  - `precheck`, `unavailable`: score cap 1 / confidence cap 0.45

반영 4) 실패 로그 누락 방지
- 미션 채점 Promise reject 시에도 unavailable 평가 로그와 0점 mission_score를 저장
- 재시작 시 로컬 평가 로그 캐시(`jobsim:evaluation_logs:v1`) 삭제

반영 5) 모델 검증 보조
- `ops:model-check` 스크립트 추가 (`OPENAI_EVAL_MODEL` 실제 사용 가능 여부 확인)
- `openai` 의존성 버전을 `latest`에서 `^6.39.0`으로 고정

관련 파일:
- `server.ts`
- `src/lib/api/contracts.ts`
- `src/lib/evaluator/evaluateAnswer.ts`
- `src/lib/recommendation/engine.ts`
- `app/state/flowController.js`
- `app/api-client/jobsimApi.js`
- `missions/index.json`
- `missions/scenarios/*.json`
- `scripts/analyze-compatibility.mjs`
- `scripts/ops-model-check.mjs`
- `scripts/eval-stability.ts`
- `docker-compose.yml`
- `package.json`, `package-lock.json`
- `.env.example`, `.env.server.example`, `ecosystem.config.cjs`
- `docs/OPERATIONS.md`, `README.md`, `ANALYSIS.md`

검증:
- `npm run typecheck` 통과
- `npm run test:e2e` 통과 (4 passed)
- `npm run eval:stability -- --runs=1 --out=reports/eval-stability-local.json --no-fail` 통과 (8 passed)
- `npm run pipeline:check` 통과

---

### 2026-05-26 — prompt injection 탐지 + bootstrap cluster_id 정합화
왜:
- 감사 항목 후속으로 보안/데이터 일관성 잔여 이슈를 즉시 처리하기 위해

반영 1) prompt injection 실탐지 적용
- 답변 텍스트에 인젝션 시그널(예: `ignore previous instructions`, role 태그, 점수 강제 지시) 탐지 로직 추가
- 탐지 시 `precheck`로 전환해 `possible_prompt_injection` 플래그와 보수적 점수(축별 0~1) 적용
- LLM이 `possible_prompt_injection` 플래그를 반환한 경우에도 후처리에서 점수/신뢰도 강제 캡
- 프롬프트에 보안 지시 보강: 사용자 답변을 `UNTRUSTED` JSON 문자열로 전달

반영 2) bootstrap `cluster_id: "UNKNOWN"` 제거
- 서버 bootstrap에서 `data/processed/job_weights.json`을 로드해 `job_code -> cluster_id` 매핑 적용
- `allMissions`, `jobDefs` 모두 실제 cluster_id 채움
- 정적 fallback 로더(`app/domain/missionsCatalog.js`)도 동일하게 cluster_id를 로드해 일관성 유지

반영 3) 회귀 테스트 강화
- golden 테스트에 `prompt_injection_attempt` 케이스 추가
- `allowFlags` 검증 로직을 eval-stability 스크립트에 반영해 필수 플래그 누락도 실패 처리

관련 파일:
- `src/lib/evaluator/evaluateAnswer.ts`
- `src/lib/evaluator/prompts.ts`
- `src/lib/bootstrap/missionBootstrap.ts`
- `app/domain/missionsCatalog.js`
- `tests/golden-evaluations.json`
- `scripts/eval-stability.ts`

검증:
- `npm run typecheck` 통과
- `npm run eval:stability -- --runs=1 --out=reports/eval-stability-local.json --no-fail` 통과 (9 passed)
- `npm run test:e2e` 통과 (4 passed)
- `npm run pipeline:check` 통과

---

### 2026-05-27 — 분석용 시뮬레이션 보고서 추가 (코드 변경 없음)
왜:
- 사용자 요청에 따라 코드 수정 없이 통계 시뮬레이션을 확장 실행하고 보고서 형태로 정리하기 위해

반영:
- `k=2~10` 확장 KMeans 안정성 실험
- GMM(`k=2~10`, covariance 4종) 비교
- PCA+HDBSCAN 그리드 실험(UMAP 대안)
- 3요인 내재화 시 기존 AX1~AX5 매핑(절대 로딩 기여율 기반) 산출

산출물:
- `reports/simulation_report_2026-05-27.md`
- `reports/simulation_report_2026-05-27.json`

참고:
- 본 단계는 분석 산출물 생성만 수행했으며 앱/서버 로직 코드는 수정하지 않음

---

### 2026-05-27 — LLM 채점 실패(Structured Output) 복구
왜:
- `/api/evaluate`에서 OpenAI parse가 스키마 제약에 걸려 LLM 경로가 실패하고 heuristic fallback으로 강등되는 이슈를 복구하기 위해

원인:
- `EvaluationSchema`의 `source`가 optional(`.optional()`)이라 Structured Output parse 제약과 충돌

반영:
- LLM parse 전용 스키마 `LlmEvaluationSchema` 추가 (`source` 제외)
- OpenAI parse는 `LlmEvaluationSchema`로 수행
- parse 성공 후 서버에서 `source: "llm"`을 주입해 기존 평가 타입/계약 유지

관련 파일:
- `src/lib/evaluator/schema.ts`
- `src/lib/evaluator/evaluateAnswer.ts`

검증:
- `npm run typecheck` 통과

---

### 2026-05-27 — 5축 결과 화면 표기 개선(절대 수준 vs 상대 비중 분리)
왜:
- 결과 카드의 퍼센트 표기가 절대점수와 상대비중을 혼용해 해석 혼동이 발생하기 때문

반영:
- 축 카드의 메인 수치 표기를 `점수/4.0` 형태로 변경
- 보조 라인 분리:
  - `절대 수준 x.x/4.0 (yy%)`
  - `상대 비중(5축 내) zz%`
- 레이더 섹션 상단에 해석 안내 문구 추가:
  - 절대 수준(축별 점수)과 상대 비중(합 100 환산) 구분

관련 파일:
- `app/components/resultDashboard.js`
- `app/index.html`

검증:
- `npm run typecheck` 통과

---

### 2026-05-27 — 직무 단일 선택 + 하루 일과 예시 문구 개선
왜:
- 첫 화면에서 다중 선택보다 단일 선택 UX가 요구됨
- 결과 화면의 `하루 일과 예시`가 직무별 차이가 없는 고정형 문구로 보여 정보성이 낮음

반영 1) 직무 선택 단일화
- 직무 선택을 토글형 다중 선택에서 단일 선택으로 변경
- 같은 카드를 다시 누르면 선택 해제, 다른 카드를 누르면 기존 선택 교체
- 첫 화면 안내 문구를 `직무를 1개 선택하세요.`로 변경

반영 2) 하루 일과 예시 생성 로직 개선
- `jobInfo.daily`를 고정 문장에서 직무/미션 기반 동적 문장으로 변경
- 반영 요소:
  - 직무 도메인(`mission_facts.domain`)
  - 대표 미션 제목(최대 2개)
  - 과제 expected_action / instruction 기반 업무 흐름(예: 현황 점검 → 원인 진단 → 개선안 제안)
  - 미션 평균 소요시간
- 서버 bootstrap 경로와 프론트 정적 fallback 경로 모두 동일 로직으로 반영

관련 파일:
- `app/state/flowController.js`
- `app/components/missionScreens.js`
- `app/domain/missionsCatalog.js`
- `src/lib/bootstrap/missionBootstrap.ts`

검증:
- `npm run typecheck` 통과

---

### 2026-05-27 — 결과 화면 `하루 일과 예시` 섹션 제거
왜:
- 결과 카드에서 `하루 일과 예시` 블록이 핵심 해석 대비 효용이 낮아 UI 단순화 요구가 있었기 때문

반영:
- 직무 소개 카드에서 `📅 하루 일과 예시` 블록 제거
- 직무 요약/업무 목록/필요 능력 목록은 유지

관련 파일:
- `app/components/resultDashboard.js`

검증:
- `npm run typecheck` 통과

---

### 2026-05-27 — 레이더 5축을 절대값(축별 0~100) 기준으로 전환
왜:
- 상대비중(합 100) 방식은 일반 사용자에게 해석 난도가 높아, 축별 절대 퍼센트 표시 요구가 있었기 때문

반영:
- 레이더 차트의 내 폴리곤 값을 `evaluationLogs`의 축 점수 평균(0~4)을 0~100으로 환산한 절대값으로 변경
- 축 라벨 퍼센트도 절대값 기준으로 표시
- 카드 문구를 절대값 기준으로 정렬하고, 상대비중 문구 제거
- 기준 직업 점선 폴리곤/증감 화살표는 스케일 혼동 방지를 위해 제거
- 안내 문구를 `각 축 독립 절대값` 설명으로 교체

관련 파일:
- `app/components/resultDashboard.js`

검증:
- `npm run typecheck` 통과

---

### 2026-05-27 — AX4/AX5 미측정 축 처리 + 추천 계산 보정
왜:
- 일부 직무(예: 데이터 분석 계열)에서 AX4/AX5가 미션 설계상 거의 측정되지 않아, 0점 누적처럼 보이는 왜곡을 줄이기 위해

반영:
- 추천 응답에 축 커버리지 추가:
  - `axisCoverage`: 축별 `totalSignal / missionCount / measured`
  - `measuredAxes`: 실제 측정 축 목록
- `mission_key`/`mission_id` 기반으로 미션 `axis_signals`를 서버에서 매칭해 축별 측정 여부 계산
- 측정 축 마스크를 추천 계산에 반영:
  - 사용자 프로파일 정규화 시 미측정 축 제외
  - 코사인 유사도 계산 시 기준 직무 가중치도 동일 축으로 마스킹 후 재정규화
- 인사이트 계산(top/low axis)도 측정 축 기준으로 정렬
- 축 상세 요약에서 미측정 축은 `unmeasured_axis` 플래그로 표기
- 결과 카드에서 미측정 축을 `미측정` 상태로 노출하고 안내 문구 추가

관련 파일:
- `src/lib/recommendation/engine.ts`
- `src/lib/api/contracts.ts`
- `server.ts`
- `app/components/resultDashboard.js`
- `app/domain/evaluationWorkflow.js`
- `app/index.html`

검증:
- `npm run typecheck` 통과
- `npm run test:e2e` 통과 (4 passed)

---

### 2026-05-27 — 미션 마무리 객관식 3문항 제거
왜:
- 미션 종료 흐름 단순화 및 입력 부담 감소 요구 반영

반영:
- 미션 화면의 self-report(재미/난이도/상상) 3문항 UI 제거
- 다음 버튼 활성 조건을 `답변 길이` 기준으로 단순화
- E2E 시나리오를 self-report 없는 플로우로 갱신

관련 파일:
- `app/components/missionScreens.js`
- `app/state/flowController.js`
- `tests/e2e/jobsim-flow.spec.ts`

검증:
- `npm run typecheck` 통과
- `npm run test:e2e` 통과 (4 passed)

---

### 2026-05-27 — self-report 잔여 의존성 제거 + 몰입 추정 보정
왜:
- 미션 마무리 객관식 3문항을 제거한 뒤에도 상태/이벤트/로그에 self-report 잔여 코드가 남아 있었고
- 사분면의 `흥미` 값이 self-report 입력 유무에 따라 왜곡되거나 고정값처럼 보일 수 있어 해석 일관성이 필요했기 때문

반영:
- 프론트 상태/이벤트에서 self-report 의존 제거
  - `state.selfReport` 삭제
  - `.sr-btn` 이벤트 핸들러 삭제
  - 로그 저장 시 `self_report` 송신 제거
- 미션 화면/스타일에서 self-report 관련 잔여 코드 정리
  - self-report UI placeholder 변수 제거
  - 미사용 `.sr-*` CSS 제거
- 사분면 문구를 `흥미` → `몰입 추정`으로 변경
  - 섹션 타이틀: `잘 했나요? 얼마나 몰입했나요?`
  - 인사이트 라벨/디테일 문구도 동일 기준으로 변경
- 서버 추천 엔진의 몰입 계산 보정
  - `self_report.fun`이 있으면 기존 방식 유지
  - 없으면 답변 토큰 수/근거 수/평균 confidence/flags(source 포함) 기반 추정치 사용
- 적합도 스케일 감마를 환경변수로 노출
  - `COMPATIBILITY_SCORE_GAMMA` (기본 1.5)
  - `/health`에 현재 감마값 포함

관련 파일:
- `app/state/store.js`
- `app/state/flowController.js`
- `app/components/missionScreens.js`
- `app/components/resultSections.js`
- `app/domain/evaluationWorkflow.js`
- `app/index.html`
- `tests/e2e/jobsim-flow.spec.ts`
- `src/lib/recommendation/engine.ts`
- `src/lib/api/contracts.ts`
- `server.ts`
- `.env.example`
- `.env.server.example`
- `README.md`

검증:
- `npm run typecheck` 통과
- `npm run test:e2e` 통과 (4 passed)

---

### 2026-05-27 — 직무 소개 문구에서 시나리오 도메인 오염 제거
왜:
- 결과 화면 직무 소개가 `mission_facts.domain`(시뮬레이션 상황 도메인)을 그대로 사용해
  - 예: 투자분석가 설명에 `도심 물류용 배터리 팩 부품` 같은 비직무 문맥이 노출되는 문제가 있었기 때문

반영:
- 직무 소개 `summary` 생성 기준을 변경:
  - 시나리오 `domain` 기반 문구 제거
  - `job_code`별 직무 설명 템플릿 우선 사용
  - 미등록 직무는 `job_mdcl_nm` 기반 일반 fallback 사용
- 서버 bootstrap 경로와 프론트 fallback 경로에 동일 로직 적용

관련 파일:
- `src/lib/bootstrap/missionBootstrap.ts`
- `app/domain/missionsCatalog.js`

검증:
- `npm run typecheck` 통과
- `npm run test:e2e` 통과 (4 passed)

---

### 2026-10-26 — 채용공고 지도 "지금 이 일을 뽑는 곳" 추가
왜:
- 결과 화면에서 체험한 직업의 실제 고용24 채용공고를 근무지 기준 지도·목록으로 보여주기(명세 `docs/JOB_POSTINGS_MAP_SPEC.md`, 계획·결정 `docs/JOB_POSTINGS_MAP_PLAN.md`)
- 함께: 평가기 temperature 호환(8장), 미션 인덱스 키 중복 제거

주요 반영:
- 서버 모듈 `src/lib/postings/`(config, work24Client, parse, regions, geocoder, occupationMap, collector, store, service, scheduler)
- API: `GET /api/jobs/:jobCode/postings`(스냅샷만 읽음), `GET /api/admin/postings/status`, `POST /api/admin/postings/refresh`(둘 다 항상 ADMIN_PASSWORD), `/health.postings`
- 정적: `/vendor/leaflet/`, `/vendor/leaflet.markercluster/`(node_modules에서 제공, CDN 없음)
- 화면: `app/components/postingsSection.js`, `postingsMap.js`, `app/styles/postings.css`, `app/main.js`(render 훅·결과 섹션 뼈대), `jobsimApi.getJobPostings`
- 관리자: `app/admin.html`, `app/admin.js` 아래쪽 "채용공고 데이터" 영역(기존 미션 생성 UI와 분리)
- 스크립트: `postings:refresh`, `postings:fixture-snapshots`, `postings:discover`, `postings:sample`, `test:unit`, `test:e2e:postings`
- 데이터: `data/postings/occupation_map.json`(3개 확정 + 투자분석가·보험상품개발자 tbd), 고정 데이터 `tests/fixtures/postings/`
- 8장: `evaluateAnswer.ts` — gpt-5·o 계열은 temperature 생략, 휴리스틱 폴백 원인 console.warn / `missions/index.json` 중복 mission_keys 10개 제거

관련 파일:
- `server.ts`, `src/lib/api/contracts.ts`, `src/lib/postings/*.ts`, `src/lib/evaluator/evaluateAnswer.ts`
- `app/main.js`, `app/index.html`, `app/admin.html`, `app/admin.js`, `app/api-client/jobsimApi.js`, `app/components/postings*.js`, `app/styles/postings.css`
- `scripts/postings-refresh.ts`, `scripts/postings-discover.ts`, `scripts/postings-sample.ts`
- `tests/unit/*.test.ts`, `tests/e2e-postings/postings.spec.ts`, `tests/fixtures/postings/**`, `playwright.postings.config.ts`
- `package.json`(fast-xml-parser, leaflet 1.9.4, leaflet.markercluster 1.5.3), `tsconfig.json`(tests/unit 포함), `.env.example`(신규), `.env.server.example`, `README.md`
- `docs/JOB_POSTINGS_METHOD.md`, `docs/JOB_POSTINGS_MAP_SPEC.md`, `docs/JOB_POSTINGS_MAP_PLAN.md`, `missions/index.json`

검증:
- `npm run typecheck` 통과
- `npm run test:unit` 38 passed
- `npm run test:e2e:postings` 6 passed(데스크톱·모바일 360px). 이 컨테이너는 브라우저 버전이 달라 `PW_CHROMIUM_PATH=/opt/pw-browsers/chromium`로 실행
- `npm run test:e2e`(기존 smoke) 4 passed
- `node --check` app/main.js, app/admin.js, postingsSection.js, postingsMap.js, jobsimApi.js 통과
- 저장소 전체 `authKey=`/`KakaoAK ` 검색: 테스트용 가짜 값만 있음
- 인증키가 없어 실제 수집(`postings:refresh`)·직종 탐색(`postings:discover`)은 실행하지 못함

---

### 2026-10-30 — JOBSIM 기능 지도 전체 구현(공통 기반 + ①~⑨)
왜:
- 팀 문서 "JOBSIM 기능 지도"의 공통 기반과 U01~U25 항목을 한 번에 반영. 외부 키(카카오·고용24·OpenAI)가 없어도 가짜 채점·개발용 로그인·고정 공고로 전부 확인할 수 있게 함.

주요 반영:
- 공통 기반(커밋 1): `server.ts` 기능별 분리(`src/server/**`), API 오류 형식 통일, SQLite(`node:sqlite`, 마이그레이션 v1), 관리자 API 잠금(데모 해제는 조회만), Caddy HTTPS 프로필, CI(`.github/workflows/ci.yml`), AI 작업 규칙(`AGENTS.md`)
- ① U01 카카오 로그인(OIDC: state·nonce·PKCE, id_token 검증), 가입(약관·개인정보·만 14세), 약관·처리방침 초안, 탈퇴+카카오 연결 끊기, 닉네임, 세션(HttpOnly·SameSite·CSRF), 취소·실패 안내, 개발용 로그인(운영에서 꺼짐), 로그인 전 결과 옮기기(U01-9), 기록 개별 삭제(U01-11)
- ② U02 내 기록(`/me.html`): 결과 스냅샷을 그대로 다시 보기(`/index.html?attempt=ID`), 요약, 관심 직무→비교·체험, 계정 설정, 빈 화면, 쓰던 답안 이어 쓰기(U02-2, 로그인 시 자동 저장). 채점은 서버 카탈로그 미션(`mission_key`)으로만
- ③ U04·U05·U08·U09·U04-3·U04-4: `/jobs.html`, `/job.html`, 대표 이미지(대분류 10 + 체험 6), 비슷한 직무, 일상어 별칭(`data/jobs/aliases.json`), 최근 본 직무
- ④ U06·U07: 관심 저장+메모, 비교(최대 3, 브라우저 유지, 적합도 없음)
- ⑤ U25 공고 요구역량: 수집 때 공고 제목 + 상세 직무내용(`jobCont`, 직업당 `POSTINGS_DETAIL_LIMIT`건)을 5축 키워드 사전으로 집계해 스냅샷에 `requirements`로 저장(원문은 저장 안 함), `GET /api/jobs/:code/postings/requirements`. U24 강점 축 직무(`/api/jobs/by-axis/:axis`)
- ⑥ U18 가짜 채점(`EVAL_MODE=fake`), 품질 측정 `npm run eval:quality`(기준 답안 25개 `data/eval/reference_answers.json`, 반복 일관성·품질 순서·사람 점수 일치). U19 근거 문장 강조, U17 결과 해석(수행 수준·직무 유사도·측정 범위)
- ⑦ U21 해설 보고 재도전: 해설은 `/api/bootstrap`에서 빼고 제출한 기록이 있을 때만 `/api/missions/:key/explanation`으로 제공, `/missions` 정적 경로 제거. 2차 채점(round 2)을 1차와 레이더로 겹쳐 비교. U22 시작 전·후 흥미 질문, U20 덜 잰 축 미션 추천
- ⑧ U03 PNG 결과 카드·인쇄(캔버스, 답변 원문 제외)
- ⑨ U11 인사·교육·훈련사무원 미션 3개를 조사 시트로 직접 작성 → validator.v1 통과(신뢰도 1.0) → `scripts/build_manual_missions.py`로 카탈로그 반영. U12 미션 화면을 업무 요청서 형식(요청자·받는 사람·배경·요청 사항·회신 형식)으로 재배치
- `eval:stability` 스크립트는 파일이 없는 상태로 남아 있어 `eval:quality`로 대체

관련 파일(커밋 2):
- `app/index.html`, `app/main.js`, `app/state/{store,flowController}.js`, `app/components/{missionScreens,resultExtras,radar,resultCard}.js`, `app/styles/results.css`
- `app/{jobs,job,compare,login,me}.{html,js}`, `app/{terms,privacy}.html`, `app/common/{site.css,site.js,compareTray.js,recent.js,jobImages.js,jobSearch.js}`, `app/api-client/jobsimApi.js`, `app/domain/evaluationWorkflow.js`, `app/admin.js`
- `src/server/{app,missionStore}.ts`, `src/server/routes/{missions,jobs}.ts`, `src/lib/postings/{requirements,collector,config,service,work24Client}.ts`
- `scripts/eval-quality.ts`, `scripts/build_manual_missions.py`, `data/eval/reference_answers.json`, `missions/manual/*.draft.json`, `missions/scenarios/K000001196_0{1,2,3}.json`, `missions/index.json`, `data/postings/occupation_map.json`
- `tests/unit/features.test.ts`, `tests/unit/{postings,server}.test.ts`, `tests/e2e-features/features.spec.ts`, `playwright.features.config.ts`, `playwright.config.ts`, `tests/fixtures/postings/work24/{routes.json,detail_F108000000000{1,2,3}.xml}`
- `.github/workflows/ci.yml`, `README.md`, `.env.example`, `.env.server.example`

검증:
- `npm run typecheck` 통과, `npm run check:frontend` 26/26
- `npm run test:unit` 58/58 통과
- `npm run test:e2e` 4/4, `npm run test:e2e:postings` 6/6(데스크톱·모바일), `npm run test:e2e:features` 6/6 (이 컨테이너는 `PW_CHROMIUM_PATH=/opt/pw-browsers/chromium`)
- `python3 scripts/build_manual_missions.py K000001196 --check` 3개 통과(신뢰도 1.0)
- `EVAL_MODE=fake npm run eval:quality -- --runs=2` 품질 순서 0.889, 키 없는 휴리스틱 0.9(반복 일관성은 실제 AI 채점에서 측정 필요)

---

### 2026-11-10 — 팀원 오류 보고(11/1) 10건 재현·수정
왜:
- 지은·영민·현서가 보고한 오류를 직접 재현해 원인을 확인하고 고침.

재현 결과와 수정:
- 결과 카드·재도전 1차 점수가 결과 화면과 다름: 결과 화면은 미션이 재지 않은 축을 '미측정'(0)으로 숨기는데, 카드·재도전 표·강점 직무·요구역량 비교는 그 축의 원시 점수(예: 대인서비스 1점)를 그대로 씀 → `radar.js`의 `maskUnmeasured`로 같은 기준 적용, 카드는 화면처럼 %·'미측정' 표기
- 적합도가 수행·몰입과 무관하게 높음(측정 축이 1개면 항상 100%): 축 비중 모양 유사도만 계산했음 → `engine.ts`에서 모양 유사도 × 수행·몰입 반영 계수(`compatibilityLevelFactor`: 수행 70% + 몰입 30%, 수준 0.75 이상이면 1, 최저 0.3). 보고 사례(수행 25%·몰입 30%)는 96 → 약 53. `selectedJobMeta`에 `shapeSimilarityPct`·`levelFactor`를 함께 내려 결과 해석에 표시
- 결과 카드 첫 인쇄가 빈 페이지: 이미지 로드 전에 `window.print()` → 로드·디코드 뒤 인쇄
- U01 관심 직무 비교가 앞 3개로 고정 → 내 기록에서 체크박스로 최대 3개 선택
- U02·U03 탐색 목록에 관심 여부·메모가 안 보임 → 탐색 카드에 '관심 저장됨'·메모, 비교표에 '내 메모' 행
- U04 긴 메모가 칸 밖으로 밀림 → 여러 줄 입력칸
- U05 비교 담기 뒤 메모가 예전 값으로 돌아감 → 메모 저장 시 화면 상태도 갱신
- U06 답변 한도를 미리 알 수 없음 → `n / 3,000자` 표시와 `maxlength=3000`(미션·재도전)

수정 파일:
- `app/components/{radar,resultExtras,resultCard,missionScreens}.js`, `app/main.js`, `app/state/flowController.js`, `app/{me,jobs,job,compare}.js`, `app/common/site.css`
- `src/lib/recommendation/engine.ts`, `src/lib/api/contracts.ts`
- `tests/unit/features.test.ts`, `tests/e2e-features/features.spec.ts`

검증:
- typecheck 통과, check:frontend 26/26, test:unit 60/60, test:e2e 4/4, test:e2e:postings 6/6, test:e2e:features 8/8(회귀 테스트 2개 추가)
- DSD 6장의 적합도 식(코사인 유사도 → γ=1.5)은 이번 변경으로 달라짐. 문서를 다시 낼 일이 있으면 반영 필요

### 2026-11-14 — 미션 카탈로그 교체(직업 50개 · 미션 150개)와 새 미션에 필요한 수정
왜:
- KNOW 직업의 수행직무 문장과 NCS 능력단위에 연결해 만든 미션 가운데 검수를 거쳐 고른 직업 50개(직업마다 쉬움·보통·어려움 하나씩, 150개)를 서비스에 넣음. 예전 미션 18개(직업 6개)는 뺌.
- 새 미션을 화면에서 돌려 보며 찾은 문제 가운데 미션이 돌아가는 데 필요한 세 가지를 함께 고침.

바뀐 것:
- 카탈로그: `missions/scenarios/` 150개, `missions/index.json`(직업 50개, 직업코드 순, 직업마다 쉬움 → 보통 → 어려움). 키는 `jobsim_service_v1__mission_<직업코드>_<난이도>_001`. 예전 직업 6개 가운데 광고·홍보·마케팅전문가, 데이터분석가, 보험상품개발자, 인사·교육·훈련사무원은 새 미션으로 바뀌고, 상품기획자·투자분석가는 카탈로그에서 빠짐. `missions/manual/`의 초안은 그대로 둠.
- 넣은 방법: `scripts/export_missions.py --outputs <미션 폴더>`를 미션마다 한 번씩 실행함. 한 번에 여러 미션을 넘기면 `index.json`의 `jobs[].mission_keys`에 같은 키가 겹쳐 들어가고 직업 안의 순서가 쉬움·어려움·보통이 됨. `--rebuild-index`는 키를 바꾸므로 쓰지 않음.
- 기준 답안: `data/eval/reference_answers.json` 25개를 새 쉬움 미션 5개(광고·홍보·마케팅전문가, 데이터분석가, 보험상품개발자, 인사·교육·훈련사무원, 정보보안전문가)에 맞춰 다시 씀. `human_scores`는 비어 있음.
- 기록 자료 스타일: `app/index.html`의 `.mat-log` → `pre.mat-log`. 기록 자료의 바깥 상자에도 같은 클래스가 붙어 자료 전체가 고정폭 글꼴로 나오던 것을 막음.
- 꺾은선 차트: 점마다 값을 숫자로 적음(`missionScreens.js`). 꺾은선 차트를 쓰는 미션 4개는 값을 읽어야 풀리는데 세로축의 가장 큰 값만 보였음. 계열이 둘 이상이면 같은 자리의 가장 작은 값은 점 아래에 적어 숫자가 겹치지 않게 함.
- 적합도: `job_weights.json`에서 `is_simulation_target`이 거짓인 직업도 체험한 직업 자신의 적합도는 계산함(`engine.ts`의 `buildJobWeightCatalog`가 5축 비중이 있는 직업을 모두 담고 `simulationTarget`으로 표시). 카탈로그 50개 가운데 8개(정보보안전문가, 정보시스템운영자, 정보통신컨설턴트 및 감리원, 네트워크관리자, 3D프린팅모델러, 건축구조기술자, 조사전문가, 사서)가 여기에 들고, 고치기 전에는 결과 화면에 "0점 · 분석 기준 데이터 없음"으로 나왔음. 비슷한 직업 추천의 후보는 지금처럼 `is_simulation_target`이 참인 직업뿐이라 이 8개 직업에는 추천 직업이 나오지 않음.
- 저장된 결과 다시 보기: 결과의 직무가 지금 카탈로그에 없어도(미션이 빠진 직무) 이름과 기본 아이콘으로 결과 화면을 그림(`resultExtras.js`의 `jobDefsForResult`, `main.js`). 고치기 전에는 "미션을 불러오는 중…"에서 멈췄음.

수정 파일:
- `missions/index.json`, `missions/scenarios/*.json`(새 미션 150개, 예전 18개는 교체·삭제), `data/eval/reference_answers.json`
- `app/index.html`, `app/main.js`, `app/components/{missionScreens,resultExtras}.js`
- `src/lib/recommendation/engine.ts`
- `tests/unit/{server,features}.test.ts`, `tests/e2e-features/features.spec.ts`

검증:
- typecheck 통과, check:frontend 26/26, test:unit 65/65(새 테스트 5개), test:e2e 4/4, test:e2e:postings 6/6, test:e2e:features 9/9(회귀 테스트 1개 추가), `build_manual_missions.py K000001196 --check` 통과
- 카탈로그 검증(`MissionStore.validateAndRefresh`) 통과: 직업 50개, 미션 150개
- 가짜 채점으로 표본 미션(일곱 자료 형태, 과제가 2개인 어려움 미션 포함)을 화면에서 결과까지 확인. 실제 채점으로는 아직 확인하지 않음

### 2026-11-14 — 일정표 자료의 기간 겹침 수정
왜:
- 미션 150개를 화면에서 전부 돌려 보다가, 일정표 자료에서 긴 기간이 내용 글자와 겹치는 것을 찾아 고침.

바뀐 것:
- 일정표 자료(`app/index.html`의 `.schedule-item`, `.sched-period`): 기간 칸이 56px로 고정돼 있어 "11/2(월)~11/13(금)" 같은 긴 기간이 옆의 내용 글자 위에 겹쳐 찍혔음(어려움 미션 8개, 19곳). 기간 칸이 줄 너비의 30%까지 쓰고 더 길면 줄을 바꾸게 함.

수정 파일:
- `app/index.html`

검증:
- 미션 150개를 브라우저로 하나씩 열어 미션 파일과 견줌(가짜 채점, 저장소 밖의 검사 스크립트): 모두 통과. 글자가 칸을 넘치는 자료가 고치기 전 미션 8개 → 고친 뒤 0개. 데스크톱과 휴대폰 너비에서 캡처로 확인
- typecheck 통과, check:frontend 26/26, test:unit 65/65, test:e2e 4/4, test:e2e:postings 6/6, test:e2e:features 9/9

### 2026-11-14 — 미션 생성기 추가: 두 단계 생성, 내용 검수, 한 건 생성용 명령
왜:
- 관리자 페이지의 미션 생성을 새 방식(하는 일 문장 ↔ NCS 능력단위 연결 → 설계서 → 미션, 근거 기록, 내용 검수)으로 바꾸는 일의 첫 부분. 이 항목은 명령줄에서 한 건을 만들고 검수할 수 있게 하는 데까지다. 관리자 화면과 서버 경로는 아직 예전 방식 그대로 돈다.

바뀐 것:
- 두 단계 생성(`pilot_runner --ncs-background --two-stage-basis --ncs-targets <대상 파일> --ncs-root data/ncs/jobs`): 근거 자료 묶음 → 설계서 → 코드 검사(걸리면 한 번 다시) → 미션 작성 → 검증·근거 검사(걸리면 한 번 고침) → 근거 기록(`generation_basis.json`)과 근거 카드(`basis_cards/`). 실행 폴더는 `outputs/` 아래에 생긴다.
- 미션 내용 검수(`mission_reviewer --run-dir <실행 폴더>`): 기대 답을 가리고 풀어 보기 → 판정. 통과·의심·문제·검수 실패 가운데 하나를 `review/`에 남긴다. 미션은 고치지 않는다.
- 생성 준비 확인(`python -m src.mission_generation.preflight`): 패키지 → key → 모델 조회 순서로 보고 실패한 데서 멈춘다. 글을 만들지 않는다. JSON 한 줄, 준비가 됐으면 종료 코드 0, 아니면 1. 설정 값이 틀려도 같은 모양으로 알린다.
- 한 건짜리 대상 파일(`python -m src.mission_generation.admin_target --job … --exec … --unit … --difficulty … (--out <파일> | --print)`): 직접 또는 간접(분야 한정) 연결만 받고, 그 밖의 연결이나 없는 연결은 오류 코드를 내며 파일을 쓰지 않는다. 자료 형태는 낱말 규칙(`material_planner`)이 좁혀서 붙인다. `--no-narrow`면 붙이지 않는다(일곱 형태를 모두 연다).
- 빠른 모드 설정: 켜면 요청에 속도 값을 넣고, 요청 한도에 걸리면 보통 속도로 한 번 내려온 뒤 보통의 재시도 규칙을 따른다. 호출 결과에 실제로 쓴 속도를 남긴다.
- LLM 제공자와 모델은 설정으로 고른다. 설정 이름과 기본값은 `.env.example` 참고. 관리자 화면의 생성 경로(`adminGeneration.ts`의 `pythonSpawnEnv`)는 예전 제공자로 고정해 두어 전처럼 돈다.
- 자료: `data/ncs/jobs/`에 직업별 NCS 파일 76개(문장 ↔ 능력단위 연결과 그 능력단위의 상세). 연결 811개 가운데 고를 수 있는 것은 직접 361개와 분야 한정 187개(직업 74개, 문장 399개)다. `data/ncs/ncs_keco_link_20230407.csv`는 NCS–KECO 연계표다.
- 근거 기록 3단계(문장 → 능력단위)의 "정한 주체"는 "연결 판단 · 기준 …"으로 채운다.
- Python 패키지는 `requirements.txt`에 있다. 실제 호출 때만 필요하고, mock 실행과 테스트는 표준 라이브러리만으로 돈다. 가상환경 `.venv/`는 Git에서 뺐다.

수정 파일:
- `src/mission_generation/` 새 파일: `admin_target.py`, `preflight.py`, `basis_card_exporter.py`, `basis_source_pack.py`, `blueprint_checker.py`, `blueprint_designer.py`, `generation_basis.py`, `material_planner.py`, `mission_reviewer.py`, `ncs_background_loader.py`
- `src/mission_generation/` 고친 파일: `config.py`, `llm_runtime.py`, `pilot_runner.py`, `draft_generator.py`, `repair_manager.py`, `decision_selector.py`, `schema_constraints_builder.py`, `ui_exporter.py`
- `src/server/routes/adminGeneration.ts`, `tests/unit/server.test.ts`
- `tests/python/`(새 폴더, 파일 23개), `requirements.txt`, `.env.example`, `.gitignore`
- `data/ncs/jobs/*.json`(76개), `data/ncs/ncs_keco_link_20230407.csv`

검증:
- Python 테스트(`python -X utf8 -m unittest discover -s tests/python`, API를 부르지 않음): 385개 통과. Windows에서는 `python3`가 아니라 `python`을 쓴다
- typecheck 통과, check:frontend 26/26, test:unit 66/66(새 테스트 1개), test:e2e 4/4, test:e2e:postings 6/6, test:e2e:features 9/9

### 2026-11-14 — 관리자 미션 생성 서버 경로를 새 방식으로: 생성 · 검수 · 생성 기록 · 카탈로그 추가와 삭제
왜:
- 관리자 페이지의 미션 생성을 새 방식으로 바꾸는 일의 둘째 부분. 화면 없이 서버 경로만으로 "직업 · 하는 일 문장 · 능력단위 · 난이도" 한 건을 만들고, 검수하고, 생성 기록에 남기고, 서비스 카탈로그에 넣고 뺄 수 있게 했다.

바뀐 것:
- 경로(모두 `/api/admin/mission-generation` 아래, `requireAdmin(allowDemoRead)`. 읽기는 조회 전용 열기에서도 열리고 바꾸기는 늘 암호가 필요하다):
  - `GET /status`(모드, 시작 전 확인 결과(60초 다시 씀), 오늘 건수와 한도, 형태 좁히기 여부, 도는 실행, 예상 시간과 비용), `GET /jobs`, `GET /jobs/:jobCode/sentences`, `GET /material-types?jobCode=&execJobId=&unitKey=&difficulty=`
  - `POST /runs`(본문 `{ jobCode, execJobId, unitKey, difficulty, review }`, 모르는 칸은 400), `GET /runs`, `GET /runs/:runId`, `POST /runs/:runId/review`(검수만 다시), `POST /runs/:runId/catalog`(카탈로그에 추가), `DELETE /runs/:runId`(기록과 실행 폴더를 지우고, 추가돼 있으면 서비스에서도 뺌)
  - `GET /catalog`, `DELETE /catalog/:missionKey`(관리자 페이지에서 추가한 미션만 서비스에서 뺌, 기록은 검토 대기로)
  - 오류는 `{ error: { code, message, details? } }`. 코드 목록은 `src/lib/adminGeneration/service.ts`와 `src/server/routes/adminGeneration.ts`에 있다
- 일은 `src/lib/adminGeneration/`이 맡는다: `commands.ts`(Python을 부르는 자리 하나. 제공자를 `MISSION_LLM_PROVIDER=anthropic`으로 못박음, 진행 줄을 바이트 경계와 상관없이 줄로 나눔, 시간 제한), `ncsCatalog.ts`(고를 수 있는 연결 = 직접, 간접 가운데 분야 한정), `progress.ts`(진행 메시지 → 단계), `runFiles.ts`, `fakeCommands.ts`, `catalogFile.ts`, `service.ts`(한 번에 하나, 하루 한도, 추가 · 삭제는 차례로)
- 실행 폴더는 생성기가 처음 찍는 `run started - run_id=…` 줄에서 읽는다(예전의 "가장 최근에 바뀐 폴더" 찾기를 없앰)
- 새 표 둘(마이그레이션 버전 2): `admin_generation_runs`(생성 기록), `admin_generation_daily`(한국 시간 날짜별 시작 건수. 기록을 지워도 줄지 않음)
- 서버를 다시 켜면 돌던 실행은 "중단됨"이 된다. 다만 미션을 저장하고 검수하던 실행은 "검토 대기 + 검수 실패"로 돌아와 카탈로그 추가와 검수 다시 돌리기가 된다
- 카탈로그 추가 · 삭제가 기다리거나 도는 실행, 이미 도는 실행에는 검수 다시 돌리기를 받지 않는다(409 `GENERATION_STILL_RUNNING`)
- 조회 전용 열기(암호 없이 읽기)로 `GET /runs/:runId`를 보면 미션의 기대 답 · 채점 기준(`evaluation`)과 검수에서 풀어 본 답을 빼고 준다. 암호가 있으면 그대로 준다
- 관리자 페이지로 추가한 미션의 키: `jobsim_admin_v1__mission_<직업코드>_<난이도>_<번호>`(날짜 없음). 이름이 고정된 폴더 `outputs/admin_export/runs/jobsim_admin_v1/…`에 미션 하나만 두고 `scripts/export_missions.py --outputs … --missions-dir …`를 부른다. 같은 미션 번호가 이미 있으면 끝 번호가 올라간다. 키가 `jobsim_admin_v1__`로 시작하는 미션만 지울 수 있다
- 추가가 중간에 실패하면(내보내기 실패, 키가 예상과 다름, 검증 실패) `missions/`의 색인과 파일을 되돌린다. 바꾸기 전 모습을 읽지 못하면 카탈로그를 건드리지 않고 500 `CATALOG_UPDATE_FAILED`를 준다. 카탈로그에서 뺄 때 색인은 숫자 글자(1.0 등)를 그대로 두고 다시 쓴다
- 새 설정 넷(`.env.example`): `ADMIN_GENERATION_DAILY_LIMIT`(기본 20), `ADMIN_GENERATION_NARROW`(기본 좁힘), `ADMIN_GENERATION_MODE`(`fake`면 생성 · 검수 없이 `tests/fixtures/admin_generation/run_sample`을 고른 직업 · 난이도에 맞춰 복사. 운영(`APP_ENV=production`)에서는 켜지지 않음. 카탈로그 추가는 가짜 모드에서도 실제 `missions/`를 바꾼다), `PYTHON_BIN`
- 옛 관리자 생성 코드(OpenAI 시작 전 확인, 조사 자료 기준 직업 목록, `findLatestRunDir`, 미리보기 만들기)를 지웠다

수정 파일:
- 새 파일: `src/lib/adminGeneration/`(`commands.ts`, `ncsCatalog.ts`, `progress.ts`, `runFiles.ts`, `fakeCommands.ts`, `catalogFile.ts`, `service.ts`), `tests/unit/adminGeneration.test.ts`, `tests/unit/adminGenerationService.test.ts`, `tests/unit/helpers/adminGenerationFixture.ts`, `tests/fixtures/admin_generation/`(직업 NCS 고정 데이터 2개, 고정 실행 결과 4개), `tests/python/test_export_staging_key.py`
- 고친 파일: `src/server/routes/adminGeneration.ts`(다시 씀), `src/server/app.ts`, `src/server/config.ts`, `src/lib/db/database.ts`, `src/lib/db/repos.ts`, `src/lib/api/contracts.ts`, `tests/unit/helpers/testServer.ts`, `tests/unit/server.test.ts`(기존 테스트 둘을 새 계약에 맞춤), `package.json`(`test:unit`에 새 테스트 파일 둘), `.env.example`

검증:
- typecheck 통과, check:frontend 26/26, test:unit 92/92(새 테스트 26개, 외부 API를 부르지 않음), test:e2e 4/4, test:e2e:postings 6/6, test:e2e:features 9/9
- Python 테스트 386개 통과(패키지가 있는 Python과 없는 Python 둘 다, 새 테스트 1개)
- 가짜 모드(`ADMIN_GENERATION_MODE=fake`)로 띄운 서버에서 경로만으로 직업 목록(74개) → 문장 목록 → 생성 → 카탈로그에 추가 → 카탈로그에서 삭제 → 생성 기록에서 삭제를 확인했다. 추가한 미션의 키는 `jobsim_admin_v1__mission_K000000832_easy_002`(미리 넣은 `_001`이 있어 번호가 올라감)였고, 끝난 뒤 `missions/`에 변화가 없었다. 서버를 다시 켜도 지우지 않은 생성 기록이 남았다
- 실제 Python으로 `GET /status`(시작 전 확인 통과)와 `GET /material-types`(데이터분석가 문장 5, 보통 → 메모 · 차트)를 확인했다(비용 없음)
- 실제 호출 한 건(정보보안전문가 문장 7, 분야 한정 능력단위, 쉬움, 검수 포함, 사용자 승인): 경로로 시작해 설계(27초) → 설계 검사 → 미션 작성(33초) → 미션 검사 → 내용 검수(22초) 순서로 넘어갔고, 생성과 검수에 1분 22초, 다시 쓴 횟수 0, 판정 통과. 자료 형태는 규칙대로 기록(log) 하나였다. 카탈로그에 넣었다가 빼고 생성 기록에서 지웠다

---

### 2026-11-14 — 관리자 화면을 새 미션 만들기 · 생성 기록 · 미션 카탈로그로, README를 새 흐름에 맞춤
왜:
- 관리자 페이지의 미션 생성을 새 방식으로 바꾸는 일의 셋째 · 넷째 부분. 앞에서 만든 서버 경로를 브라우저에서 쓸 수 있게 관리자 화면을 새로 만들고, README의 관리자 미션 생성 설명을 새 흐름에 맞췄다

바뀐 것:
- `app/admin.html`은 틀만 남기고 화면은 `app/admin/`의 모듈이 그린다. 주소의 `#/…`로 화면을 바꾼다: `#/new`(새 미션 만들기), `#/runs`(생성 기록), `#/runs/<실행 번호>`(실행 하나: 생성 중 → 결과와 근거 · 검수), `#/catalog`(미션 카탈로그). 서버와는 `/api/admin/mission-generation` 아래의 경로 열둘로만 이야기한다
- 모듈: `main.js`(시작, 주소 따라 화면 바꾸기), `api.js`(암호 보관, 요청), `shell.js`(사이드바, 위 띠, 용어 안내, 암호 화면, 확인 창, 알림, 여러 화면이 같이 쓰는 표시), `labels.js`(화면의 말), `basis.js`(미리보기의 한 부분 → 근거 기록에서 보여 줄 것), `screenNew.js`, `screenRun.js`, `screenHistory.js`, `screenCatalog.js`, `admin.css`
- 새 미션 만들기: 직업(이름 검색) → 하는 일 문장(고를 수 없는 문장은 접어 두고 까닭을 보인다) → 생성 설정(능력단위, 난이도, 자료 형태(자동), 내용 검수 포함, 예상 소요와 비용) → `미션 생성`. 도는 실행이 있으면 버튼 자리에 "지금 만들고 있는 미션 보기"가 보인다
- 실행 화면: 도는 중에는 서버가 주는 단계 여섯을 1.5초마다 다시 받아 그대로 그린다. 끝나면 탭 둘(`미리보기와 근거`, `검수`). 미리보기의 과제 · 자료 · 채점 기준과 "하는 일 문장 → 능력단위 → 수행준거 → 미션" 네 칸을 누르면 근거 기록의 글을 그대로 보여 준다(글 안의 조각 번호만 "수행준거 2.2" 같은 이름으로 바꾼다). 근거 기록에 없는 부분은 "이 부분의 근거 기록이 없습니다."를 보인다. 버튼은 `카탈로그에 추가`, `삭제`, 검수 탭의 `검수 돌리기` · `검수 다시 돌리기`
- 검수 판정: 통과 · 문제 · 검수 실패 · 검수 안 함은 표시로, 의심은 작은 글 "확인할 점 N건"으로 보인다. 문제면 카탈로그에 추가할 수 없다
- 생성 기록: 줄을 누르면 그 실행으로 간다. 줄마다 `삭제`가 있고, 서비스에 추가된 미션이면 서비스에서도 빠진다고 알리고 묻는다. 미션 카탈로그: 직업별 난이도 개수, 펼치면 미션과 `열기`(사용자 화면에서 그 미션을 연다), 관리자 페이지에서 추가한 미션에만 `삭제`(서비스에서만 뺀다)
- 조회 전용 열기(`ADMIN_DEMO_UNLOCK=true`)에서는 둘러볼 수 있고 생성 · 추가 · 삭제 버튼은 눌리지 않는다. 암호를 넣는 버튼이 위 띠 아래와 사이드바에 있다. 이때는 GET이 암호와 상관없이 열리므로, 넣은 암호가 맞는지는 `POST /runs/-/review`(없는 실행)의 응답으로 확인한다
- 좁은 창: 1180px 아래에서 사이드바가 아이콘만 남는다. 생성 기록의 표는 560px보다 좁아지면 칸 안에서 옆으로 움직이고 삭제 칸이 오른쪽에 붙는다. "삭제", 난이도, 상태 같은 짧은 칸은 줄이 바뀌지 않는다
- 관리자 화면의 채용공고 칸을 없앴다(`app/admin.js` 삭제). 서버의 관리자용 채용공고 경로(`/api/admin/postings/*`)와 사용자 쪽 채용공고 기능은 그대로다
- 자료(표, 체크리스트 등)의 스타일을 `app/index.html`에서 `app/styles/materials.css`로 떼어 사용자 화면과 관리자 미리보기가 같이 쓴다. `renderMaterial`을 내보낸다(`app/components/missionScreens.js`)
- 새 설정 `MISSIONS_DIR`(`.env.example`, `src/server/config.ts`): 미션 폴더를 바꾼다(비우면 `missions`). 관리자 화면 E2E가 복사한 미션 폴더(`test-results/admin-missions`)를 쓰는 데 쓴다
- 새 E2E `npm run test:e2e:admin`(`playwright.admin.config.ts`, 포트 8093, 가짜 생성 모드, `scripts/prepare-admin-e2e.mjs`가 미션 폴더를 복사한다): 고르기 → 생성 → 근거 → 카탈로그에 추가 → 삭제로 이어지는 흐름 하나와, 암호가 틀리면 들어가지 못하는 것. CI(`.github/workflows/ci.yml`)에 단계를 더했다
- README: 맨 위 소개, 준비물(Python 패키지 `anthropic`, `data/ncs/jobs/`), 환경 설정 표(Claude 설정, 하루 한도, 형태 좁히기, 가짜 모드, `MISSIONS_DIR`), "관리자 미션 생성 방법", "고를 수 있는 직업과 문장", "생성 결과가 저장되는 위치", "CLI로 미션 생성하기"(새 방식의 명령 셋과 예전 방식), 검증 명령, 문제 해결을 새 흐름에 맞췄다

수정 파일:
- 새 파일: `app/admin/`(`main.js`, `api.js`, `shell.js`, `labels.js`, `basis.js`, `screenNew.js`, `screenRun.js`, `screenHistory.js`, `screenCatalog.js`, `admin.css`), `app/styles/materials.css`, `scripts/prepare-admin-e2e.mjs`, `playwright.admin.config.ts`, `tests/e2e-admin/admin.spec.ts`, `tests/unit/adminScreens.test.ts`
- 고친 파일: `app/admin.html`(다시 씀), `app/index.html`, `app/components/missionScreens.js`, `src/server/config.ts`, `package.json`, `.env.example`, `README.md`, `AGENTS.md`, `.github/workflows/ci.yml`
- 지운 파일: `app/admin.js`

검증:
- typecheck 통과, check:frontend 34/34, test:unit 95/95(새 테스트 3개), test:e2e 4/4, test:e2e:postings 6/6, test:e2e:features 9/9, test:e2e:admin 2/2, Python 테스트 386개 통과
- 자료 스타일을 떼어 내기 전과 뒤에, 사용자 화면의 미션 수행 화면에서 자료 칸 안 모든 요소의 계산된 스타일과 크기를 견주었다(이메일 · 기록 · 체크리스트 · 표 · 메모 · 차트 · 일정표 자료가 든 미션 셋, 375px과 1280px). 모두 같았다
- 가짜 모드(`ADMIN_GENERATION_MODE=fake`, 복사한 미션 폴더)로 띄운 서버에서 브라우저로 여섯 화면을 확인했다: 암호(틀린 값, 맞는 값), 메뉴와 새로고침, 용어 안내 여닫기, 직업 74개와 검색, 문장 · 능력단위 · 난이도 · 검수 스위치에 따라 바뀌는 생성 설정, 생성 → 결과 → 근거 칸 → 검수 탭 → 카탈로그에 추가 → 사용자 화면에서 열기 → 카탈로그에서 삭제(생성 기록의 상태가 검토 대기로 돌아옴), 생성 기록의 삭제 확인 창 두 가지, 검수 없이 만든 실행의 `검수 돌리기`, 없는 실행 번호, 조회 전용 열기. 730px과 490px에서 "삭제"가 한 줄로 보였다
- 도는 중 · 실패 · 중단 화면은 응답을 바꿔 끼워 그려서 확인했다(가짜 모드의 생성은 1초쯤에 끝난다)
- 실제 Python과 Claude 설정으로 띄운 서버에서 사이드바의 "Claude API 연결됨"과 자료 형태 줄(정보보안전문가의 분야 한정 문장, 보통 → 메모 · 기록)을 확인했다(비용 없음)
- 검사 뒤 `git status --short -- missions` 변화 없음

---

### 2026-11-14 — 사용자 답변 채점을 Claude로(OpenAI는 설정으로 선택)
왜:
- 결과 분석(답변 채점)에 ChatGPT 대신 Claude를 쓰기로 함. 미션 생성은 이미 Claude다.

바뀐 것:
- `src/lib/evaluator/evaluateAnswer.ts`: 채점 AI를 고르는 `getEvalProvider()`(설정 `EVAL_LLM_PROVIDER` → Claude 키 → OpenAI 키 순). Claude 경로는 공식 SDK(`@anthropic-ai/sdk`)의 `client.beta.messages.parse` + `betaZodOutputFormat`(구조화 출력), 기본 모델 `claude-opus-5-5`, effort `medium`(`ANTHROPIC_EVAL_EFFORT`로 바꿈). 안전 분류기 거절 대비로 서버 쪽 대체(`fallbacks: "default"`, beta `server-side-fallback-2026-07-01`)를 켬(대체를 받는 모델일 때만). 거절·토큰 한도·빈 응답은 실패로 보고 기존처럼 휴리스틱 폴백. 응답은 서버 스키마(zod v3)로 한 번 더 검증
- `src/lib/evaluator/claudeSchema.ts`: SDK 도우미가 zod v4를 받아 같은 채점 스키마를 `zod/v4`로 적음. 두 스키마가 같은지 테스트가 확인
- `/health`에 `eval_provider`, `has_anthropic_key`. `.env.example`·`.env.server.example`에 `EVAL_LLM_PROVIDER`, `ANTHROPIC_EVAL_MODEL`, `ANTHROPIC_EVAL_EFFORT`. README·`eval:quality` 안내 문구
- 의존성: `@anthropic-ai/sdk` 추가

검증:
- typecheck 통과, check:frontend 34/34, test:unit 98/98(새 테스트 3개: 스키마 일치, 채점 AI 고르기, 가짜 API 서버로 실제 SDK 요청 모양·응답 해석 확인), test:e2e 4/4, postings 6/6, features 9/9, admin 2/2
- 실제 Claude 호출로는 아직 확인하지 않음(키 없음)

---

### 2026-11-15 — 배포 이미지에 미션 생성용 Python 패키지 추가, 배포 문서를 지금 흐름에 맞춤
왜:
- Docker 이미지에 Python은 있었지만 미션 생성기가 쓰는 패키지(`anthropic`)가 없어, 이미지로 띄운 서버에서는 관리자 화면의 미션 생성이 시작 전 확인에서 막혔다. 배포 문서는 예전 브랜치와 예전 관리자 흐름을 가리키고 있었다

바뀐 것:
- `Dockerfile`: `py3-pip`를 깔고 `requirements.txt`를 설치한다. 서버는 `PYTHON_BIN`이 비어 있으면 `python3`를 띄우므로 서버 설정에 더할 것은 없다
- `.env.server.example`: "관리자 화면의 미션 생성" 묶음(`ANTHROPIC_GENERATION_MODEL`, `ANTHROPIC_GENERATION_EFFORT`, `ANTHROPIC_GENERATION_FALLBACKS`, `ANTHROPIC_GENERATION_SPEED`, `ADMIN_GENERATION_DAILY_LIMIT`, `ADMIN_GENERATION_NARROW`). 이름과 기본값은 `.env.example`과 같다
- `docs/AWS_EC2_DOCKER_DEPLOY.md`: 받을 브랜치를 `aws`로, 최소 설정을 `ANTHROPIC_API_KEY`와 `ADMIN_PASSWORD`로(답변 채점을 OpenAI로 돌리는 설정은 선택), 데모 흐름을 지금 관리자 화면(새 미션 만들기 → 미션 생성 → 미리보기와 근거 · 검수 → 카탈로그에 추가)으로
- `docs/OPERATIONS.md`: 필수 설정을 `ANTHROPIC_API_KEY`로, `OPENAI_API_KEY`는 선택으로
- `README.md`: 준비물에 "Docker 이미지에는 이 패키지가 들어 있습니다" 한 줄

수정 파일:
- `Dockerfile`, `.env.server.example`, `docs/AWS_EC2_DOCKER_DEPLOY.md`, `docs/OPERATIONS.md`, `README.md`

검증:
- `docker build` 통과(linux/amd64). 이미지 안에서 `anthropic` 1.17.0을 불러왔고, 키를 넘기지 않은 시작 전 확인(`python3 -m src.mission_generation.preflight`)이 패키지 통과 뒤 `LLM_API_KEY_MISSING`에서 멈췄다. 이미지 안의 `.env*` 파일은 `.env.server.example`뿐이다
- 가짜 모드(`ADMIN_GENERATION_MODE=fake`, 복사한 미션 폴더를 연결)로 띄운 컨테이너에서 경로만으로 직업 목록(74개) → 문장 목록 → 생성 → 카탈로그에 추가를 확인했다. 추가한 미션의 키는 `jobsim_admin_v1__mission_K000000832_easy_002`였고 연결한 폴더의 `missions/index.json`에 들어갔다. 컨테이너를 지우고 새로 띄워도 생성 기록(추가됨)과 추가한 미션이 남았다. 카탈로그에서 삭제 · 생성 기록에서 삭제는 200을 주었고 미션 수가 150으로 돌아왔다
- 같은 컨테이너의 `/admin.html`을 브라우저로 열어 암호 화면과 새 미션 만들기 화면(직업 74개)을 확인했다
- `docker compose up -d --build`로 띄운 컨테이너가 healthcheck `healthy`가 됐고 `/api/bootstrap`이 직업 50개 · 미션 150개를 주었다
- 이미지 안에서 typecheck 통과, check:frontend 34/34, test:unit 98/98, Python 테스트 386개 통과

---

### 2026-11-15 — CI 실행 환경을 Ubuntu 24.04로 고정
왜:
- GitHub Actions의 `ubuntu-latest`가 Ubuntu 26.04를 가리키게 되면서 "Playwright 브라우저 설치" 단계가 실패했다(Playwright 1.60.0이 그 버전에 Chromium을 설치하지 못한다). 그 뒤의 E2E 네 단계가 돌지 못했다

바뀐 것:
- `.github/workflows/ci.yml`: `runs-on`을 `ubuntu-24.04`로

수정 파일:
- `.github/workflows/ci.yml`

검증:
- Ubuntu 24.04 컨테이너(Playwright 1.60.0 공식 이미지)에서 `npm ci`, `npx playwright install --with-deps chromium`이 통과했고, test:e2e 4/4, test:e2e:postings 6/6, test:e2e:features 9/9, test:e2e:admin 2/2

---

### 2026-11-15 — 카카오에서 닉네임을 받지 않음(본인 확인만 요청)
왜:
- 카카오에서 받는 개인정보를 회원번호 하나로 줄이기로 함. 닉네임은 서비스 안에서 쓰는 이름이라 가입 화면에서 직접 정하면 된다

바뀐 것:
- `src/lib/auth/kakao.ts`: 카카오에 요청하는 항목을 `openid profile_nickname` → `openid`로. ID 토큰에서 닉네임을 읽지 않는다(`KakaoIdentity`는 회원번호 `sub`만)
- `src/server/routes/auth.ts`: 카카오로 처음 온 사람의 가입 화면 닉네임 칸에는 임시 이름("체험자" + 숫자 4자리)이 채워진다. 그 자리에서 고칠 수 있고, 내 기록 화면에서 바꾸는 것도 그대로다
- `app/privacy.html`: 모으는 항목을 "카카오 회원번호"와 "닉네임(가입할 때 직접 정함)"으로 나누고, 카카오 닉네임과 프로필 사진을 받지 않는다고 적음
- 약관·처리방침 버전을 `2026-11-15`로(`src/lib/auth/terms.ts`, `app/terms.html`, `app/privacy.html`)
- `README.md`: 카카오 콘솔 안내에서 닉네임 동의항목 설정을 뺌
- 카카오 개발자 콘솔에서는 닉네임 동의항목을 설정하지 않아도 된다

수정 파일:
- `src/lib/auth/kakao.ts`, `src/lib/auth/session.ts`(주석), `src/lib/auth/terms.ts`, `src/server/routes/auth.ts`, `app/privacy.html`, `app/terms.html`, `README.md`, `tests/unit/server.test.ts`

검증:
- 단위 테스트를 먼저 고쳐 실패를 본 뒤(요청 항목이 `openid`인지, 가짜 카카오 응답에 닉네임이 들어 있어도 가입 화면에는 임시 이름이 나오는지) 코드를 고쳤다
- typecheck 통과, check:frontend 34/34, test:unit 98/98, test:e2e 4/4, test:e2e:postings 6/6, test:e2e:features 9/9, test:e2e:admin 2/2
- 가짜 카카오 응답을 쓰는 서버를 띄워 브라우저로 확인: "카카오로 시작하기" → 가입 화면 닉네임 칸에 "체험자6749", 약관 버전 2026-11-15, 처리방침 화면의 바뀐 표

---

### 2026-11-15 — 개인정보 처리방침과 이용약관을 정식 문서 형식으로 다시 씀
왜:
- 두 문서가 구어체 요약이라 실제 서비스의 문서처럼 읽히지 않았다. 채점에 쓰는 AI 서비스는 설정에 따라 달라지므로 문서에 특정 업체 이름을 적지 않기로 함

바뀐 것:
- `app/privacy.html`: 조항 형식(제1조~제11조)과 합니다체로 다시 씀. 처리 항목과 목적, 보유 기간, 제3자 제공, 위탁 및 국외 이전, 파기, 정보주체의 권리, 쿠키, 만 14세 미만, 안전성 확보 조치, 보호책임자와 구제 기관, 변경 안내. 항목 · 보유 기간(24시간, 14일, 7일 · 30일)은 코드의 기본값과 같다
- `app/terms.html`: 조항 형식(제1조~제8조, 부칙)과 합니다체로 다시 씀. 내용은 그대로 두고 목적, 약관의 변경, 시행일을 더함
- `app/login.js`: 로그인 · 가입 화면의 문구(안내, 동의 항목, 버튼, 오류 안내)를 합니다체로. 가입 화면 제목은 "약관 동의", 버튼은 "동의하고 가입하기"
- `src/server/routes/auth.ts`: 가입 화면에 그대로 나오는 서버 안내 4종(가입 정보 없음 · 동의 필요 · 닉네임 규칙 · 가입 시간 지남)을 합니다체로
- `app/me.js`: 내 기록 화면의 문구(빈 상태 안내, 버튼, 알림, 확인 창, 회원 탈퇴 안내)를 합니다체로. 제목은 "○○ 님의 진로 기록", 묶음 제목 "쓰던 답안 이어 하기"는 "작성 중인 답안"으로. 닉네임 "변경" 버튼이 좁은 폭에서 두 줄로 꺾이지 않게 함
- `src/server/routes/me.ts`, `src/server/routes/auth.ts`: 내 기록 화면에 나오는 서버 안내(관심 직무 · 메모 · 답안 저장 · 탈퇴 확인)를 합니다체로
- `tests/e2e-features/features.spec.ts`: 바뀐 알림 문구와 묶음 제목에 맞춤
- 약관 · 처리방침 문서와 로그인 · 가입 · 내 기록 화면은 사용자 화면 문구 규칙(구어체)의 예외다
- 채점을 받는 곳을 업체 이름 대신 "답변 채점에 이용하는 외부 AI 서비스(API) 제공 사업자"로 적음. 가입 화면의 동의 문구도 "외부 AI 서비스로 전송돼"로(`app/login.js`)
- `app/privacy.html`, `app/terms.html`의 "초안" 안내 상자를 지움. `README.md`의 화면 표에서 "초안" 표현을 뺌

수정 파일:
- `app/privacy.html`, `app/terms.html`, `app/login.js`, `app/me.js`, `src/server/routes/auth.ts`, `src/server/routes/me.ts`, `tests/e2e-features/features.spec.ts`, `README.md`

검증:
- typecheck 통과, check:frontend 34/34, test:unit 99/99, test:e2e:features 9/9
- 브라우저로 처리방침 · 이용약관 · 로그인 · 가입 화면(동의 없이 눌렀을 때의 안내, 로그인 취소 안내 포함)을 열어 확인

---

### 2026-11-15 — 카카오 돌아올 주소가 빈 값으로 나가던 문제 수정
왜:
- `.env`에 `KAKAO_LOGIN_REDIRECT_URI=`처럼 이름만 있고 값이 비어 있으면(`.env.example`의 기본 모습) 카카오로 보내는 `redirect_uri`가 빈 값이 됐다. 안내에는 "비우면 PUBLIC_BASE_URL/auth/kakao/callback"이라고 적혀 있었다

바뀐 것:
- `src/server/config.ts`: 값이 없거나 빈 칸이면 `{PUBLIC_BASE_URL}/auth/kakao/callback`을 쓴다

수정 파일:
- `src/server/config.ts`, `tests/unit/server.test.ts`

검증:
- 단위 테스트를 먼저 더해 실패를 본 뒤 고쳤다(값 없음 · 빈 값 · 공백 · 직접 지정). test:unit 99/99, typecheck 통과
- 실제 카카오 키를 넣은 로컬 서버(`http://localhost:8080`)에서 실제 카카오 계정으로 확인: "카카오로 시작하기" → `redirect_uri=http://localhost:8080/auth/kakao/callback`, `scope=openid`로 요청 → 카카오 동의 화면에 제공 항목이 회원번호 하나로 나옴 → 가입 화면(닉네임 칸에 임시 이름) → 가입 → 내 기록. DB의 `users`에 `provider=kakao`, 회원번호, 닉네임, 약관 버전 2026-11-15가 저장됐고 세션은 해시로 저장됐다
- 로그아웃 뒤 다시 로그인하면 가입 화면 없이 원래 가려던 화면(`/jobs.html`)으로 돌아왔고 회원은 한 명 그대로였다
- `KAKAO_ADMIN_KEY`를 넣고 탈퇴: `users` · `sessions`가 0건이 됐고 서버 기록에 연결 끊기 실패가 없었다. 그 뒤 다시 로그인을 누르니 카카오 동의 화면이 다시 나왔다(로그아웃 뒤 재로그인 때는 나오지 않았다). 카카오 쪽 연결이 끊긴 것이다

---

### 2026-11-15 — 사용자 화면 문구 전체를 합니다체로
왜:
- 약관 · 처리방침 · 로그인 · 가입 · 내 기록 화면만 문체가 달라져, 나머지 사용자 화면도 같은 문체로 맞추기로 함

바뀐 것:
- `AGENTS.md`: 화면 문구 규칙을 "구어체(~해, ~야)"에서 "정중한 문어체(~합니다, ~해 주세요)"로. 관리자 화면은 예외
- 화면 문구(반말과 해요체 → 합니다체): 직무 탐색(`app/jobs.html`, `app/jobs.js`), 직무 상세(`app/job.js`), 비교(`app/compare.html`, `app/compare.js`), 미션 진행(`app/main.js`, `app/components/missionScreens.js`, `app/state/flowController.js`), 결과(`app/components/resultExtras.js`, `resultDashboard.js`, `resultSections.js`, `resultCard.js`), 채용공고(`app/components/postingsSection.js`, `postingsMap.js`), 공통(`app/common/site.js`, `app/domain/missionsCatalog.js`)
- 제목도 바꿈: "어떤 일이 궁금해?" → "어떤 직무가 궁금하신가요?", "후보 직무를 나란히 봐" → "후보 직무 비교", "어떻게 준비해?" → "준비 방법", "결과를 이렇게 읽어줘" → "결과 해석 안내", "해보니 어땠어?" → "체험은 어떠셨나요?"
- 역량 표시 이름(화면 `AX_META`와 서버 `missionBootstrap.ts`): "데이터로 생각해요" 등 5개를 "데이터 기반 사고 · 세밀한 관찰 · 전략적 판단 · 팀 조율과 리더십 · 배려와 소통"으로. 축 이름(`AX_LABELS`: 정보분석·논리 등)은 그대로다
- 화면에 나오는 서버 안내: `src/server/routes/missions.ts`, `jobs.ts`, `src/server/http.ts`, `authContext.ts`, `src/lib/api/contracts.ts`, `src/lib/evaluator/fakeEvaluation.ts`, `src/lib/bootstrap/missionBootstrap.ts`
- 그대로 둔 것: 미션 본문과 미션 제목(미션 파일의 내용), 관리자 화면, 개발자용 기록(`console.warn`, 수집기 · 스케줄러 로그), AI가 쓰는 채점 문장(채점 지시문에는 말투 지정이 없다)
- 문구를 그대로 확인하던 테스트를 맞춤: `tests/unit/features.test.ts`, `tests/e2e-features/features.spec.ts`, `tests/e2e-postings/postings.spec.ts`. `README.md`, `docs/JOB_POSTINGS_METHOD.md`에 인용된 화면 문구도 맞춤

검증:
- typecheck 통과, check:frontend 34/34, test:unit 99/99, test:e2e 4/4, test:e2e:postings 6/6, test:e2e:features 9/9, test:e2e:admin 2/2
- 브라우저로 직무 탐색 · 직무 상세 · 비교 · 체험 전 질문 · 미션 목록 · 미션 수행 · 결과 화면을 열어 남은 반말 문장이 없는지 훑어봄(남은 것은 미션 제목뿐)

### 2026-11-15 — 직무 비교 기능을 뺌
왜:
- 직무 비교(후보 직무를 최대 3개까지 나란히 보는 화면)를 서비스에서 빼기로 함

바뀐 것:
- 지운 파일: `app/compare.html`, `app/compare.js`, `app/common/compareTray.js`
- 상단 메뉴와 첫 화면의 "비교" 링크를 뺌: `app/common/site.js`(메뉴, 비교 개수 배지), `app/index.html`(상단 메뉴, 아래쪽 링크)
- "비교 담기" 버튼과 비교 바를 뺌: 직무 탐색(`app/jobs.js`), 직무 상세(`app/job.js`), 내 기록(`app/me.js`). 내 기록의 "비교 선택" 체크박스와 "선택한 관심 직무 비교하기" 버튼도 뺌
- 서버: `GET /api/jobs/compare`를 뺌(`src/server/routes/jobs.ts`)
- 쓰지 않게 된 스타일을 뺌: `app/common/site.css`(`.compare-tray`, `.site-badge`, `.pick-label`)
- 안내 문구에서 비교를 뺌: 로그인 화면(`app/login.js`), 이용약관(`app/terms.html`), 개인정보 처리방침(`app/privacy.html`의 "비교함" 문구). 수집 항목과 보관 기간은 그대로라 약관 버전은 바꾸지 않음
- 테스트: 비교 E2E 1개를 지우고, 관심 직무 E2E는 메모 저장과 탐색 화면 표시만 확인하게 줄임(`tests/e2e-features/features.spec.ts`). 직무 API 단위 테스트에서 비교 확인을 뺌(`tests/unit/server.test.ts`)
- `README.md`의 화면 표와 검사 설명, `playwright.features.config.ts`의 설명을 맞춤
- 그대로 둔 것: 관심 직무 저장·메모, 결과 화면의 "공고가 요구하는 역량 vs 내 결과"(비교 화면과 다른 기능)

검증:
- typecheck 통과, check:frontend 32/32, test:unit 99/99, test:e2e 4/4, test:e2e:postings 6/6, test:e2e:features 8/8, test:e2e:admin 2/2
- 브라우저로 첫 화면 · 직무 탐색 · 직무 상세를 열어 비교 메뉴와 버튼이 없는지 확인. `/compare.html`은 404, `/api/jobs/compare`는 직업코드 오류(400)로 답함. 로그인한 내 기록 화면은 E2E로 확인

### 2026-11-15 — 체험 단계가 바뀔 때 화면이 다른 구역으로 가던 문제 수정
왜:
- 체험 영역(`#simulation`)은 긴 첫 페이지 중간에서 내용만 갈아 끼우는데, 스크롤을 맞추는 코드는 결과 화면에만 있었다. 다음 단계 화면이 더 짧으면 스크롤이 그 자리에 남아 아래 구역이 보였다
- 가장 심한 경우: 직무 선택(카드 50개) 맨 아래에서 "체험 시작"을 누르면 사전 질문 대신 맨 아래 안내 구역과 바닥 메뉴가 보였다

바뀐 것:
- `app/main.js`: `render()`가 단계(`state.screen`)가 바뀐 경우에만 체험 영역 맨 위로 스크롤을 맞춘다. 같은 단계 안에서 다시 그릴 때(직무 카드·미션 카드 선택)는 그대로 둔다. 결과 화면은 전처럼 맨 위로 간다
- `app/state/flowController.js`: 채점 대기 화면도 체험 영역으로 맞춘다(긴 미션 화면 아래에서 제출하면 대기 화면이 짧아 같은 문제가 생긴다)
- `tests/e2e-features/features.spec.ts`: 직무 선택 → 사전 질문 → 미션 목록 → 미션 수행으로 넘어갈 때 체험 영역이 화면 위쪽에 있는지 확인하는 테스트 1개 추가(고치기 전에는 실패)

검증:
- typecheck 통과, check:frontend 32/32, test:unit 99/99, test:e2e 4/4, test:e2e:postings 6/6, test:e2e:features 9/9, test:e2e:admin 2/2
- 켜 둔 서버에서 앞으로 3단계, "이전" 3단계, 채점 대기, 결과, "처음부터 다시"를 눌러 가며 체험 영역 위치를 잼(모두 화면 위쪽 64px, 결과는 맨 위). 카드 선택 때는 움직이지 않음

### 2026-11-15 — 사용 중 눈에 띄던 문제 4가지 정리
왜:
- PC와 모바일 크기로 체험·탐색·로그인·내 기록 흐름을 끝까지 눌러 보며 찾은, 화면에서 바로 보이는 문제를 고침

바뀐 것(커밋을 항목별로 나눔):
1. 결과 화면의 "함께 살펴볼 만한 직업"과 결과 카드의 "결이 비슷한 직무" 목록을 뺌
   - 미션 하나로는 5개 역량 중 2개 정도만 측정되는데, 추천은 그 비율만 비교해서 관련 없는 직업 3개가 모두 "유사도 100%"로 나왔다
   - `app/main.js`, `app/components/resultDashboard.js`(`renderRecommendationsSection` 삭제), `app/components/resultCard.js`(목록 삭제, 그래프와 요약 위치 조정), `app/components/resultExtras.js`(카드 설명 문구)
   - 서버 계산(`src/lib/recommendation/engine.ts`의 `recommendations`)은 그대로 둠. 고른 직무의 점수 계산과 같은 곳이라 건드리지 않았다
2. 직무 탐색 검색: `data/jobs/aliases.json`에 흔한 말(코딩, 프로그래밍, AI, 인공지능, 머신러닝, VR, 해킹 등)을 추가하고 `npm run jobs:build`로 `data/jobs/index.json`을 다시 만듦. `app/common/jobSearch.js`는 별칭과 똑같은 말(75점)이 이름에 포함된 경우(70점)보다 먼저 나오게 함("마케터" → 광고·홍보·마케팅전문가가 텔레마케터보다 먼저). `tests/unit/features.test.ts`에 확인 2줄 추가
3. 답을 쓰던 중 새로고침·뒤로 가기·다른 페이지 이동을 누르면 브라우저가 한 번 묻게 함(`beforeunload`): `app/main.js`
   - 묻는 경우: 로그인하지 않고 미션 답을 쓰던 중, 재도전 답을 고치던 중, 채점 대기 중. 로그인한 사용자의 미션 답은 자동 저장되므로 묻지 않는다
   - 나가면 답이 사라지는 것은 그대로다. 진행 상태를 저장해 되살리는 것은 하지 않았다
4. 좁은 화면(768px 이하): 그래프 양옆 이름이 잘리던 것을 그림 영역에 좌우 여백을 넣어 고침(`app/components/resultDashboard.js`, `app/components/radar.js`, 글자 스타일은 `app/index.html`의 `.radar-lbl` 등). 미션 화면에 답 입력 영역이 화면 밖일 때만 뜨는 "답변 쓰러 가기" 버튼 추가(`app/components/missionScreens.js`, `app/main.js`의 `bindAnswerJump`)

검증:
- typecheck 통과, check:frontend 32/32, test:unit 99/99, test:e2e 4/4, test:e2e:postings 6/6, test:e2e:features 9/9, test:e2e:admin 2/2
- 켜 둔 서버에서 PC(1280px)와 모바일(375px) 크기로 확인: 추천 구역과 "유사도 100%" 없음, 그래프 글자 잘림 없음, 결과 카드 PNG, 답 쓰던 중 새로고침 때 확인창(답이 비었거나 결과 화면이면 없음), "답변 쓰러 가기"(모바일에서만 보이고 누르면 입력칸으로), 검색 "마케터"·"코딩"·"AI"
- 직무 목록은 서버가 시작할 때 읽으므로 사전을 고친 뒤에는 서버를 다시 켜야 검색에 반영된다

### 2026-11-15 — 관리자: 미션을 만드는 중 화면의 움직임 다듬기
왜:
- 만드는 중 화면은 1.5초마다 상태를 다시 받을 때 진행 카드를 통째로 새로 그렸다. 그래서 한 바퀴 1초짜리 스피너가 1.5초마다 처음 각도로 되돌아가 끊겨 보였다
- 진행 막대는 끝난 단계 수로만 계산해 0% → 33% → 67%에 오래 멈춰 있었고(실제 생성에서는 단계 하나가 20초~1분), 끝나도 100%가 보이지 않은 채 결과 화면으로 바뀌었다. 지난 시간도 나오지 않았다
- 끝나는 순간 왼쪽 메뉴의 켜진 항목이 "새 미션 만들기"에서 "생성 기록"으로 옮겨 갔다

바뀐 것:
- `app/admin/screenRun.js`
  - 도는 중에는 글(지금 단계, 경과 시간), 막대 너비, 단계 줄만 고친다. 스피너와 막대 요소는 새로 만들지 않는다
  - 막대: 오래 걸리는 세 단계(설계, 미션 작성, 내용 검수)가 예상 시간만큼 구간을 갖고, 하는 중인 단계의 구간 안에서 1초마다 조금씩 찬다. 그 단계가 끝나기 전에는 구간 끝에 닿지 않고, 도는 동안에는 97%를 넘지 않는다. 예상 시간은 `/status`의 `estimates`를 쓴다(설계 45%, 미션 작성 55%로 나눔)
  - "경과 0:42 · 예상 약 1분 30초"를 지금 단계 옆에 보인다. 시작 시각은 실행의 `createdAt`이고, 20분보다 오래됐거나 브라우저 시각보다 뒤면 화면을 연 때부터 센다
  - 잘 끝나면 막대가 끝까지 차고 "다 만들었습니다"가 0.9초 보인 뒤 결과로 넘어가며, 아래에 "미션을 만들었습니다. 내용을 확인해 주세요."가 잠깐 뜬다
  - 위 띠의 경로 앞 글은 화면을 처음 열 때 정한다. 도는 모습으로 열었으면 끝난 뒤에도 "새 미션 만들기", 끝난 실행을 열었으면 "생성 기록"이다
  - "검수 돌리기"로 검수만 다시 돌릴 때는 경과 시간을 0부터 세고 경로 글이 "검수 중"이다
- `app/admin/admin.css`: 도는 중 막대의 너비 전환(1초), 경과 시간 글, 다 만든 표시

검증:
- typecheck 통과, check:frontend 32/32, test:unit 99/99, test:e2e:admin 2/2
- 가짜 생성의 단계 사이를 설계 10초 · 작성 14초 · 검수 8초로 늘린 서버에서 확인: 한 번 도는 동안 스피너 요소가 한 번도 새로 만들어지지 않음, 막대가 0%에서 끊기지 않고 올라 끝에 100%, 경과 시간이 1초씩 오름, 끝난 뒤 경로가 "새 미션 만들기 / 미션 제목", 검수만 다시 돌리기에서 경과 0:00부터

### 2026-11-15 — 관리자: 화면을 눌러 보며 찾은 작은 문제 4가지 정리
왜:
- 관리자 화면을 처음부터 끝까지 눌러 보며 찾은, 화면에서 바로 보이는 문제를 고침

바뀐 것:
1. 카탈로그의 "열기"가 미션 수행 화면을 바로 연다
   - 안내 글은 "열기"가 그 미션을 바로 연다고 적혀 있는데, 실제로는 시작 전 질문 화면과 미션 고르기 화면을 지나야 그 미션이 나왔다
   - `app/admin/screenCatalog.js`: "열기" 주소에 `&resume=1`을 붙인다(`/index.html?mission=<키>&resume=1`). 사용자 화면이 이 값을 보면 그 미션의 수행 화면부터 시작한다(`app/main.js`의 `applyUrlParams`)
   - 이 길로 들어와 끝까지 풀면 시작 전 질문의 답이 없으므로, 결과 화면의 "처음 생각과 실제 미션" 표에서 사전 예상 두 칸이 "(입력 없음)"으로 나오고 "체험 전후 흥미 변화" 구역은 나오지 않는다. 점수 계산은 미션 답만 쓰므로 같다
2. 생성 기록: 도는 중인 줄의 검수 칸을 "—"로 둔다
   - 미션을 저장하고 검수가 도는 동안 그 줄에 "생성 중"과 함께 "검수 안 함"이 떴다
   - `app/admin/screenHistory.js`의 `verdictCell`
3. 실패한 실행의 화면 글에서 내부 코드를 뺀다
   - "검사를 통과하지 못해 저장되지 않았습니다. (VALIDATION_FAILED)"처럼 코드가 붙어 나왔고, AI 호출이 실패한 경우에도 같은 글이 나왔다
   - `app/admin/labels.js`의 `errorText`: 실패한 실행은 AI 호출 실패(코드에 LLM · ANTHROPIC이 든 것), 서버 안에서 난 문제, 그 밖(검사를 통과하지 못한 것) 셋으로 나눠 쓰고 코드는 쓰지 않는다. 코드는 전처럼 상세 로그의 "실패:" 줄에 남는다
   - `tests/unit/adminScreens.test.ts`: 실패한 실행의 글에 코드가 없는지 보는 확인 1줄
4. "카탈로그에서 보기"가 추가한 미션 줄로 간다
   - 추가한 직업은 펼쳐져 있었지만 화면은 맨 위에 머물러, 직업 50개 가운데서 스크롤해 찾아야 했다
   - `app/admin/main.js`: 주소 `#/catalog?mission=<미션 키>`를 받는다. `app/admin/screenRun.js`: "카탈로그에서 보기"가 이 주소로 간다. `app/admin/screenCatalog.js`: 그 미션의 직업을 펼치고 줄을 화면 가운데로 옮겨 옅은 바탕색으로 표시한다(처음 그릴 때 한 번). `app/admin/admin.css`: 표시 색

검증:
- typecheck 통과, check:frontend 32/32, test:unit 99/99, test:e2e:admin 2/2
- 1: 카탈로그의 "열기" 151개가 모두 새 주소인지 확인. 로그인하지 않은 채로 그 주소를 열어 미션 수행 화면이 바로 뜨고 체험 영역이 화면 위쪽에 오는 것, 답을 내고 결과 화면까지 가는 것(가짜 채점), 콘솔 오류가 없는 것을 확인
- 2~4: 단계 사이를 늘린 가짜 생성 서버에서 확인. 검수가 도는 동안 생성 기록의 검수 칸이 "—", 실패 화면 글이 코드 없이 "검사를 통과하지 못해 저장되지 않았습니다.", "카탈로그에서 보기"를 누르면 18번째 직업의 추가한 미션 줄이 화면 가운데에 표시됨

### 2026-11-15 — 관리자: 근거 칸을 간단히 하고 상태 · 오류 글을 "AI"로 통일
왜:
- 근거 칸의 접는 "자세히 보기"는 단계 종류와 내부 설정 값("정한 주체"), 가져온 낱말 같은 줄을 보여 주어, 관리자가 미션을 검토할 때 읽을 내용이 아니었다
- 상태 줄과 설정 오류 안내가 특정 서비스 이름으로 적혀 있었다. 쓰는 서비스가 바뀌어도 맞는 말로 바꾼다

바뀐 것:
- `app/admin/basis.js`: "정한 주체" 줄을 만들지 않는다(`decidedByOf` 삭제, 돌려주는 값에서 `decidedBy` 삭제). 기록 파일의 `kind`, `decided_by`는 그대로 두고 화면만 보이지 않는다
- `app/admin/screenRun.js`: 근거 칸에 접는 "자세히 보기"를 두지 않는다. 근거 칸은 "왜"와 "근거가 된 원문"만 보이고, 둘 다 없는 칸(길의 "미션" 칸)만 난이도 규칙을 그대로 보인다
- `app/admin/labels.js`: `KIND_LABELS` 삭제. 설정 오류 안내 5개를 "서버에 AI API 키가 없습니다.", "서버에 AI 호출에 쓰는 Python 패키지가 깔려 있지 않습니다.", "AI API 키가 받아들여지지 않았습니다.", "설정한 AI 모델을 찾을 수 없습니다.", "AI에 연결하지 못했습니다."로 바꿈
- `app/admin/shell.js`: 왼쪽 아래 상태 줄을 "AI 연결됨"으로 바꿈
- 상세 로그는 생성기가 찍는 줄을 그대로 보인다

검증:
- typecheck 통과, check:frontend 32/32, test:unit 99/99, test:e2e:admin 2/2
- 가짜 생성 서버의 결과 화면에서 누를 수 있는 열 군데(길의 네 칸, 과제, 자료, 채점 기준)를 모두 눌러 "자세히 보기"와 "정한 주체"가 없는 것을 확인. 실제 생성 기록 5개(48군데)를 같은 함수에 넣어 내부 설정 값이 나오지 않는 것도 확인
- 상태 응답을 브라우저에서 바꿔 끼워, 연결된 상태의 "AI 연결됨"과 설정 오류 5가지의 새 글이 상태 줄과 "미션 생성" 버튼 아래에 나오는 것을 확인

### 2026-11-15 — 관리자: 미션 생성에 빠른 모드 스위치 추가
왜:
- 미션 한 건을 만드는 데 2분쯤 걸린다(보통 난이도, 내용 검수 포함). 생성기에는 빠른 모드가 있었지만 설정 파일로만 켤 수 있어, 화면에서 필요할 때만 켜고 끌 수 없었다

바뀐 것:
- 화면(`app/admin/screenNew.js`, `app/admin/api.js`, `app/admin/admin.css`): "생성 설정"에 "빠른 모드" 스위치(안내 글 "약 2배 빠름 · 하루 한도 2건 사용"). 켜면 예상 소요가 빠른 모드 값으로 바뀐다(보통 난이도, 검수 포함: 약 2분 → 1분 이내). "예상 비용" 줄은 화면에서 뺐다. 오늘 남은 건수가 1건이면 빠른 모드로는 시작할 수 없고 버튼 아래에 이유가 나온다. 시작 요청은 스위치를 켰을 때만 `fast: true`를 싣는다
- 진행 화면(`app/admin/screenRun.js`): 빠른 모드로 만든 실행은 생성 설정 카드에 "속도: 빠른 모드"가 보이고, "예상" 시간과 진행 막대가 빠른 모드 값을 쓴다
- 서버(`src/lib/adminGeneration/service.ts`, `commands.ts`, `src/lib/api/contracts.ts`): 시작 요청의 `fast`(없으면 거짓)를 받아 실행 기록에 속도를 남기고, 생성과 내용 검수를 부를 때 환경 변수 `ANTHROPIC_GENERATION_SPEED`를 `fast` 또는 `standard`로 넘긴다. 하루 건수는 빠른 모드 2건, 보통 1건이고 남은 건수가 모자라면 시작하지 않는다(`429 GENERATION_DAILY_LIMIT`, `details.needed`). `검수 돌리기`는 그 실행의 속도로 돌고 건수에 세지 않는다. 상태 응답에 빠른 모드의 예상 시간 `estimatesFast`를 더했다
- DB(`src/lib/db/database.ts` 마이그레이션 3, `src/lib/db/repos.ts`): `admin_generation_runs.speed`(기본값 `standard`). `addGenerationStart`가 더할 건수를 받는다
- 생성기(`src/mission_generation/config.py`): `ANTHROPIC_GENERATION_SPEED=standard`를 보통 속도로 받는다. 설정 파일에 `fast`가 있어도 화면에서 끄고 만들면 보통 속도로 돈다
- 설정 값 `ANTHROPIC_GENERATION_SPEED`는 스위치의 처음 값이 된다(`fast`면 켜진 채로 나온다)
- 빠른 모드의 예상 시간(초): 쉬움 생성 24 · 검수 10, 보통 30 · 10, 어려움 50 · 20. 잰 것은 11월 14일의 보통 난이도 한 건이고, 나머지는 보통 속도 값에 같은 비율을 곱한 어림이다
- 예상 소요 표시(`app/admin/labels.js`의 `minutesText`): 30초 단위 반올림을 올림으로 바꿨다. 반올림이면 빠른 모드 보통 난이도(40초)가 "약 30초"로, 보통 속도(95초)가 "약 1분 30초"로 실제보다 짧게 나왔다. 이제 보통 속도는 "약 2분"이다(11월 15일 실제 생성은 2분 1초). 1분이 안 되는 예상은 초를 말하지 않고 "1분 이내"로 쓴다(11월 15일 빠른 모드 실제 생성은 43초)
- 문서: `README.md`(설정 값 설명, 생성 설정, 하루 한도), `.env.example`, `.env.server.example`

검증:
- typecheck 통과, check:frontend 32/32, test:unit 100/100, test:e2e:postings 6/6, test:e2e:features 9/9, test:e2e:admin 2/2, Python 테스트 387개 통과
- 단계 사이를 늘린 가짜 생성 서버에서 확인: 스위치를 켜고 끄면 예상 소요가 바뀜(보통: 약 2분 ↔ 1분 이내), "예상 비용" 없음, 빠른 모드로 만들면 "오늘 생성"이 2 늘고 진행 화면에 "빠른 모드"와 빠른 모드의 예상 시간이 보임, 남은 건수를 1건으로 맞추면 스위치를 켰을 때 버튼이 막히고 안내 글이 나옴. 속도 칸이 없던 DB(기록 10건)로 서버를 다시 켜도 기록이 보통 속도로 읽힘
- 실제 설정의 서버에서 빠른 모드로 한 건(보통 난이도, 검수 포함)을 만들어 확인: 43초(설계 15.5초, 작성 15.5초, 검수 11.7초), 호출 기록의 속도가 fast이고 보통 속도로 내려가지 않음, 오늘 건수 2 증가. 같은 조건의 보통 속도는 2분 1초였다

### 2026-11-15 — 관리자: 암호 화면에서 사용자 화면으로 나가는 링크
왜:
- 관리자 화면에서 로그아웃하면 암호 화면만 남는데, 거기에는 다른 페이지로 가는 길이 없어 주소를 직접 치거나 뒤로 가기를 눌러야 했다. 암호 없이 관리자 주소로 들어온 경우도 같았다

바뀐 것:
- `app/admin/shell.js`: 암호 화면의 "확인" 버튼 아래와, 더 갈 수 없을 때 보이는 멈춤 화면에 "사용자 화면으로 →" 링크(같은 창에서 `/index.html`)
- `app/admin/admin.css`: 링크의 자리
- `tests/e2e-admin/admin.spec.ts`: 로그아웃 뒤 암호 화면에서 그 링크로 첫 화면에 가는지 확인(고치기 전에는 실패)

검증:
- check:frontend 32/32, test:e2e:admin 2/2
- 가짜 생성 서버에서 암호 화면을 열어 링크가 버튼 아래 가운데에 보이고, 누르면 첫 화면으로 가는 것을 확인

### 2026-11-15 — 관리자: 화면에서 암호 바꾸기
왜:
- 관리자 암호는 설정 파일의 `ADMIN_PASSWORD` 한 줄이라, 바꾸려면 서버에 접속해 파일을 고치고 서버를 다시 켜야 했다

바뀐 것:
- `src/server/adminAuth.ts`(새 파일): 관리자 암호를 한곳에서 본다. 처음 암호는 `ADMIN_PASSWORD`이고, 화면에서 바꾸면 DB에 scrypt 해시로 남아 그 암호만 통한다(설정 파일보다 먼저). 한 번 맞은 암호의 SHA-256을 메모리에 두어 요청마다 scrypt를 돌리지 않는다
- 새 암호의 조건: 공백 없는 영문 · 숫자 · 기호(ASCII 0x21~0x7E) 4~100자, 지금 암호와 다를 것. 암호가 요청 머리(`x-api-token`)에 실려 가므로 브라우저가 머리에 실을 수 없는 글자(한글 등)는 받지 않는다
- 틀린 암호 제한: IP마다 1분에 10번(`ADMIN_PASSWORD_MAX_ATTEMPTS`, 0이면 끔). 10번째부터 1분 동안 그 IP에서는 맞는 암호도 `429 ADMIN_TOO_MANY_ATTEMPTS`를 받는다(맞는 암호만 통과시키면 틀린 암호를 끝없이 넣어 볼 수 있다). 암호 바꾸기에서 지금 암호를 틀린 것도 한 번으로 센다. 바꾸기 바로 앞의 암호로 온 요청(다른 창, 다른 사람)은 거절하되 세지 않는다
- 제한에 쓰는 IP는 `trustedClientIp`(`src/server/http.ts`, 새 함수)로 본다: `req.ip`만 쓰고 요청이 보낸 `X-Forwarded-For`를 직접 읽지 않는다(`TRUST_PROXY=true`일 때만 express가 반영한다). 직접 읽으면 값을 바꿔 가며 제한을 피하거나 남의 IP를 막을 수 있다. 틀린 횟수 표는 5,000개까지만 둔다
- 저장된 해시의 모양이 다르면(소금 16바이트, 해시 64바이트의 16진수가 아니면) 어떤 암호도 받지 않는다
- 되돌리기: `ADMIN_PASSWORD_RESET=true`로 서버를 켜면 화면에서 바꾼 암호를 지우고 처음 암호로 돌아간다. 켜져 있는 동안에는 화면에서 바꿀 수 없다(`409 ADMIN_PASSWORD_RESET_ON`)
- 경로 `POST /api/admin/password`(`src/server/routes/adminAccount.ts`, 새 파일): 본문 `{ currentPassword, newPassword }`. 조회 전용 열기와 상관없이 암호가 필요하다. 오류: `ADMIN_PASSWORD_WRONG`(403), `ADMIN_PASSWORD_INVALID` · `ADMIN_PASSWORD_SAME` · `ADMIN_PASSWORD_BAD_REQUEST`(400)
- 암호를 직접 견주던 곳을 모두 `AdminAuth`로 바꿈: `src/server/middleware.ts`의 `requireAdmin(config, auth, options)`, `src/server/routes/adminGeneration.ts`, `src/server/routes/postings.ts`, `src/server/routes/health.ts`. 연결은 `src/server/app.ts`
- DB(`src/lib/db/database.ts` 마이그레이션 4, `src/lib/db/repos.ts`): 테이블 `admin_settings(key, value, updated_at)`와 읽기 · 쓰기 · 지우기 함수. `src/server/config.ts`에 `admin.passwordReset`
- 화면(`app/admin/shell.js`, `app/admin/api.js`, `app/admin/labels.js`, `app/admin/admin.css`): 사이드바 아래 `암호 바꾸기`(조회 전용이면 없음)와 창(지금 암호, 새 암호, 새 암호 확인). 바꾸면 그 탭은 새 암호로 이어서 쓰고 "암호를 바꿨습니다."가 뜬다. 다른 창은 다음 요청에서 암호 화면으로 돌아간다
- E2E 서버의 암호를 `pw-e2e`로 바꿈(`playwright.admin.config.ts`, `tests/e2e-admin/admin.spec.ts`): 암호 바꾸기 테스트가 끝에 처음 값으로 되돌리려면 4자 이상이어야 한다
- 문서: `README.md`(설정 값, "관리자 암호 바꾸기", 문제 해결), `.env.example`, `.env.server.example`, `docs/AWS_EC2_DOCKER_DEPLOY.md`, `docs/OPERATIONS.md`

검증:
- typecheck 통과, check:frontend 32/32, test:unit 110/110, test:e2e:postings 6/6, test:e2e:features 9/9, test:e2e:admin 3/3, Python 테스트 387개 통과
- `tests/unit/adminAuth.test.ts`(새 파일, 10개): 처음 암호로 들어감, 바꾼 뒤 새 암호만 통하고 서버를 다시 켜도 유지(DB에 암호 원문 없음), 두 번 바꾸면 처음 바꾼 암호도 막힘, 거절되는 경우, 깨진 해시는 아무 암호도 받지 않음, 되돌리기 설정, 10번 틀린 뒤 1분 동안 막힘과 풀림, 바로 앞 암호는 세지 않음, 제한 끄기, `X-Forwarded-For`를 바꿔 보내도 제한을 피하지 못함, 바꾼 뒤 예전 암호가 관리자 생성 · 채용공고 경로에서 401, 조회 전용 상태에서는 바꿀 수 없음
- 가짜 생성 서버에서 창을 열어 확인: 4자 미만과 틀린 지금 암호의 안내 글, 바꾼 뒤 알림과 그 탭이 이어서 동작함, 예전 암호로 보낸 요청이 401

### 2026-11-16 — 격자 안 첫 카드만 크게 보이던 문제 수정
왜:
- 직무 탐색 목록, 직무 상세의 임금·만족도·전망과 비슷한 직무, 내 기록의 통계에서 첫 번째 카드만 10px 위에서 시작하고 10px 더 컸다
- 세로로 쌓는 카드에 주는 위 여백(`.card + .card{margin-top:10px}`)이 격자 안에서도 적용돼, 둘째 카드부터 칸 안에서 10px씩 밀렸다. 격자는 `gap`으로 이미 간격을 준다

바뀐 것:
- `app/common/site.css`: `.grid > .card + .card{margin-top:0}` 추가
- `app/me.html`: 통계 격자(`.stats`)에도 같은 규칙 추가

검증:
- 켜 둔 서버에서 직무 탐색 첫 줄, 직무 상세의 두 격자, 내 기록 통계 카드의 위치와 높이를 재서 줄마다 같은 것을 확인. 세로로 쌓인 카드 사이 간격(10px)은 그대로
- check:frontend 32/32, test:e2e:features 9/9
---

### 2026-11-15 — 시연용 로그인(test/test)
왜:
- 발표 시연 때 카카오 계정 없이 바로 로그인해 내 기록·관심 직무를 보여 주기 위해

주요 반영:
- `POST /api/auth/demo-login`: 아이디 `test`·비밀번호 `test`가 맞으면 약관 동의 화면 없이 고정 계정(provider `demo`)으로 로그인. 처음 한 번만 계정을 만들고 이후에는 같은 계정을 쓰므로 기록이 계속 남는다. 1분에 20번까지
- 운영(APP_ENV=production)에서도 켜져 있다. `DEMO_LOGIN=false`로 끈다. `/api/auth/session`의 `providers.demo`로 화면에 알린다
- 시연용 계정은 탈퇴가 막힌다(서버 403 `DEMO_ACCOUNT_LOCKED`, 내 기록 화면에서 탈퇴 칸 대신 안내). 닉네임 변경·기록 지우기·로그아웃은 된다
- 로그인 화면: 카카오 버튼 아래 작은 글자 버튼 "시연용 로그인" → 누르면 아이디·비밀번호 칸이 열린다

검증: typecheck, check:frontend, unit 101/101, features E2E 10/10

### 2026-11-16 — 내 기록: 체험한 직무·제출한 미션 수가 지운 뒤에도 남던 문제 수정
왜:
- 내 기록에서 체험 기록을 모두 지워도 "체험한 직무"가 1로 남았다
- 두 숫자가 시작만 하고 끝내지 않은 체험까지 셌다. 그 체험은 목록에 나오지 않아 지울 버튼도 없다. 로그인 전에 시작만 한 체험도 로그인할 때 계정으로 옮겨져 같은 일이 생긴다

바뀐 것:
- `src/server/routes/me.ts`: `/api/me/summary`의 `counts.jobs_tried`를 끝낸 체험(`status = completed`)의 직무만 세도록 고침
- `src/lib/db/repos.ts`: `countUserMissions`가 끝낸 체험의 미션만 세도록 고침
- `tests/unit/server.test.ts`: 끝내지 않은 체험이 있어도 두 숫자가 끝낸 체험만 세고, 기록을 지우면 0이 되는 것을 확인

검증:
- typecheck 통과, check:frontend 32/32, test:unit 112/112, test:e2e:features 10/10

### 2026-11-16 — 관리자: 용어 안내를 사용자 화면의 카드 모양으로
왜:
- 용어 안내 상자만 강조색 테두리와 그라데이션 배경을 써서, 중립색 카드로 된 사용자 화면이나 관리자 화면의 다른 카드와 모양이 달랐다

바뀐 것:
- `app/admin/admin.css`: 바깥 상자의 테두리와 배경을 없애고, 용어 네 개를 각각 중립색 카드(옅은 테두리, 8px 모서리, 올리면 조금 밝아짐)로 그림. 제목 줄은 작은 회색 글씨로 바꿈
- `app/admin/shell.js`: 제목 아이콘의 강조색을 뺌
- 글 내용, 닫기와 다시 열기 동작은 그대로

검증:
- 화면을 띄워 넓은 폭(4칸)과 좁은 폭(2칸)에서 모양 확인, 콘솔 오류 없음
- check:frontend 32/32, test:e2e:admin 3/3

## Open Items (Next)

0000. 관리자 미션 생성 후속(2026-11-14)
- Python 테스트는 CI에 걸려 있지 않다
- `pilot_runner`의 `--ncs-targets` 도움말이 이 브랜치에 없는 모듈(`target_planner`)을 가리킨다
- 문장 ↔ 능력단위 연결은 사람이 확인하지 않았다(판단 기준은 자료에 적혀 있다)

000. 미션 카탈로그 교체 후속(2026-11-14)
- 실제 채점으로 새 미션 확인(특히 과제가 2개인 어려움 미션에서 두 과제를 모두 보는지). 가짜 채점으로만 돌려 봤음
- `/api/bootstrap` 응답이 268KB → 2.44MB로 커졌고 응답 압축이 없음. 배포 환경에서 첫 화면 시간을 재 볼 것
- 직무 선택 화면: 카드 50장이 3열 17줄로 나옴. 카드 설명은 모두 "미션 기반 탐색", 아이콘은 48장이 💼, "직무당 약 15분 소요"는 고정 문구(미션은 10·15·20분). 검색이나 분야 묶음이 없음
- 추천 계산 대상이 아닌 직업 8개는 결과 화면에 비슷한 직업 추천이 나오지 않음
- 업무 요청서의 "받는 사람" 칸에 문장이 들어가는 미션이 78개, "요청자"는 항상 "○○ 팀장"으로 나옴(배경에 팀장이 나오지 않는 미션 62개)
- 메모 자료의 작성자(`author`)가 화면에 나오지 않음
- 내 기록의 쓰던 답안에서 없어진 미션은 제목 대신 미션 키가 나옴
- E2E의 답 문장(`features.spec.ts`의 `ANSWER` 등)은 예전 미션 내용 그대로임(가짜 채점이라 통과에는 영향 없음)
- 따로 쓴 소개 문구가 없는 직업이 48개(`missionBootstrap.ts`의 `JOB_SUMMARY_BY_CODE`), 대표 그림이 없는 직업이 46개(`jobImages.js`의 `JOB_ART`)

00. 기능 지도 후속(2026-10-30)
- 카카오 로그인: 로컬 주소에서는 실제 계정으로 가입·재로그인·탈퇴(연결 끊기)까지 확인함(2026-11-15). 운영 주소에서는 카카오 콘솔에 그 주소의 Redirect URI를 등록하고 `KAKAO_LOGIN_CLIENT_ID/SECRET`, `KAKAO_ADMIN_KEY`, `PUBLIC_BASE_URL`을 설정
- `app/terms.html`, `app/privacy.html`의 `[배포 전에 …]` 자리(팀 대표 연락처 등)를 채우고 팀 검토
- 고용24 상세 응답의 직무내용 필드명이 `jobCont`인지 실제 키로 확인(아니면 `parseDetailXml` 수정). 확인 전에는 요구역량이 공고 제목 위주로 계산됨
- `data/eval/reference_answers.json`의 `human_scores`를 팀원이 채운 뒤 실제 AI 채점으로 `npm run eval:quality -- --runs=3 --fail`
- 인사·교육·훈련사무원 미션 3개 사람 검토(`reliability.human_review_required=true`), 고용24 직종코드 탐색(현재 tbd). 2026-11-14: 카탈로그의 인사·교육·훈련사무원 미션은 새 미션으로 바뀜(사람이 쓴 초안은 `missions/manual/`에 있음)
- 공유 링크(U03 2단계)는 공개 범위·개인정보 설계 뒤로 미룸(기능 지도 3주차 이후)

0. 채용공고 지도 후속
- 고용24·카카오 키를 넣고 `npm run postings:refresh -- --verbose` → `docs/JOB_POSTINGS_METHOD.md` 5장 실제 표 채우기
- `npm run postings:discover`로 투자분석가·보험상품개발자 직종코드 결정(현재 tbd)
- `npm run postings:sample` 후 사람 검토로 직종 연결 정확도 측정
- 기존 레이더 차트(`resultDashboard.js`, 고정 폭 370px SVG)가 360px 화면에서 문서 가로 스크롤 6px을 만듦(새 섹션과 무관, 기존 섹션이라 수정하지 않음)
- 전남광주 통합 후 도로명코드 시도 코드(`12`) 공식 확인

1. `isLowInformationAnswer` 임계치 미세조정
- 현재 값은 보수적 기본값
- 권장: 로그 80줄+ 수집 후 재조정

2. 적합도 감마(1.5) 최종 확정
- 현재는 과낙관 완화 목적 기본값
- `analyze:compat` 결과 기반으로 확정 필요

3. 결과 분석 UX 문구 정교화
- non-LLM 결과일 때 안내 문구를 더 명확하게 다듬을 여지 있음

---

## Quick Verify Commands

```bash
npm run typecheck
npm run pipeline:check
npm run check:frontend
npm run test:unit
npm run test:e2e
npm run test:e2e:postings
npm run test:e2e:features
npm run test:e2e:admin
npm run eval:quality -- --runs=1
python3 scripts/build_manual_missions.py K000001196 --check
```
