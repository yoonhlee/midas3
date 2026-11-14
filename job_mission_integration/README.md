# JOBSIM Mission Integration

직무 기반 미션을 생성하고, 사용자가 미션을 수행한 뒤 AI 평가 결과를 확인하는 웹 애플리케이션입니다.

프로젝트는 크게 두 흐름으로 나뉩니다.

1. 관리자 화면에서 직무와 난이도를 선택해 미션을 생성합니다.
2. 일반 사용자 화면에서 생성된 미션을 수행하고 결과를 분석합니다.

## 준비물

### 필수 프로그램

- Node.js 20 이상
- npm
- Python 3.11 이상
- OpenAI API key

미션 생성 파이프라인은 Python 표준 라이브러리 중심으로 동작합니다. 일반적인 관리자 미션 생성 기능만 사용할 때는 별도 Python 패키지 설치가 필요하지 않습니다.

### 필수 파일과 폴더

```text
data/api_raw/
data/additional_search/
missions/index.json
missions/scenarios/
.env
```

각 폴더의 역할은 다음과 같습니다.

| 경로 | 역할 |
| --- | --- |
| `data/api_raw/{jobCode}/` | 직무 원천 XML 데이터입니다. 관리자 화면의 직무 목록은 이 폴더를 기준으로 표시됩니다. |
| `data/additional_search/{jobCode}.md` | 미션 생성에 사용할 직무별 추가 조사 자료입니다. 이 파일이 있어야 해당 직무가 `생성가능` 상태가 됩니다. |
| `missions/index.json` | 일반 사용자 화면에 노출할 미션 목록입니다. |
| `missions/scenarios/*.json` | 실제 사용자 화면에서 읽는 미션 시나리오 파일입니다. |
| `outputs/` | 관리자 미션 생성 중 생기는 임시 산출물입니다. |
| `reports/` | 사용자 답변 평가 로그가 저장되는 폴더입니다. |

`data/api_raw`는 용량이 커질 수 있는 원천 데이터이므로, 필요에 따라 로컬에만 두고 커밋하지 않아도 됩니다.

## 환경 설정

처음 실행할 때 `.env.example`을 복사해 `.env`를 만듭니다.

Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

macOS 또는 Linux:

```bash
cp .env.example .env
```

`.env`에는 아래 값을 설정합니다.

```env
OPENAI_API_KEY=sk-...
OPENAI_GENERATION_MODEL=gpt-5.4-nano
OPENAI_EVAL_MODEL=gpt-5-nano
ADMIN_PASSWORD=admin-password
ADMIN_DEMO_UNLOCK=false
COMPATIBILITY_SCORE_GAMMA=1.5
PORT=8080
```

선택 값:

```env
PYTHON_BIN=python
EVALUATION_LOG_RETENTION_DAYS=30
EVALUATE_RATE_LIMIT_WINDOW_MS=60000
EVALUATE_RATE_LIMIT_MAX=30
```

| 환경 변수 | 설명 |
| --- | --- |
| `OPENAI_API_KEY` | 미션 생성과 답변 평가에 사용하는 OpenAI API key입니다. |
| `OPENAI_GENERATION_MODEL` | 관리자 미션 생성과 생성 전 OpenAI preflight에 사용하는 모델입니다. 기본값은 `gpt-5.4-nano`입니다. |
| `OPENAI_EVAL_MODEL` | 사용자 답변 평가 모델입니다. 기본값은 `gpt-5-nano`입니다. |
| `ADMIN_PASSWORD` | 관리자 페이지 접속 암호이자 보호된 API 호출 토큰입니다. |
| `ADMIN_DEMO_UNLOCK` | `true`이면 교수님 확인/시연을 위해 관리자 잠금을 일시 해제하고 안내 팝업을 표시합니다. |
| `COMPATIBILITY_SCORE_GAMMA` | 직무 추천/적합도 점수 보정값입니다. 기본값은 `1.5`입니다. |
| `PORT` | 로컬 서버 포트입니다. 기본값은 `8080`입니다. |
| `PYTHON_BIN` | 사용할 Python 실행 파일입니다. 생략하면 Windows는 `python`, 그 외 환경은 `python3`를 사용합니다. |
| `WORK24_RECRUIT_AUTH_KEY` | 고용24 Open-API "채용정보" 서비스 인증키입니다. 채용공고 지도에 씁니다. |
| `KAKAO_REST_API_KEY` | 카카오 REST API 키입니다(주소 → 좌표). 카카오맵 사용 설정을 켜야 합니다. |
| `POSTINGS_ENABLED` | 채용공고 기능 전체 켜기/끄기. 기본값 `true` |
| `POSTINGS_FIXTURE` | `1`이면 고정 데이터 모드(가짜 공고). 기본값 `0` |
| `POSTINGS_DATA_DIR` | 스냅샷·캐시 위치. 기본값 `reports/postings`(고정 데이터 모드는 `reports/postings-fixture`) |
| `POSTINGS_REG_DATE` | 고용24 등록 기간 조건. 기본값 `M-1`(한 달) |
| `POSTINGS_MAX_PAGES` | 직업당 최대 페이지(페이지당 100건). 기본값 `10` |
| `POSTINGS_REFRESH_HOURS` | 자동 갱신 주기(시간). 기본값 `24` |
| `POSTINGS_DETAIL_LIMIT` | 공고 요구역량 분석을 위해 직업마다 상세 조회할 공고 수. 기본값 `10`, `0`이면 제목만 분석 |
| `APP_ENV` | `production`이면 개발용 로그인을 강제로 끈다 |
| `PUBLIC_BASE_URL` | 서비스 주소(예: `https://jobsim.example.com`). 카카오 로그인 콜백·쿠키 Secure 판단에 쓴다. 기본값 `http://localhost:{PORT}` |
| `TRUST_PROXY` | 리버스 프록시(Caddy 등) 뒤에서 돌릴 때 `true` |
| `DATABASE_PATH` | SQLite 파일 위치. 기본값 `reports/jobsim.sqlite`, 테스트는 `:memory:` |
| `EVAL_MODE` | `fake`이면 OpenAI 없이 가짜 채점(테스트·시연용). 기본값은 실제 채점 |
| `KAKAO_LOGIN_CLIENT_ID` / `KAKAO_LOGIN_CLIENT_SECRET` | 카카오 로그인(OpenID Connect) 앱의 REST API 키와 Client Secret |
| `KAKAO_LOGIN_REDIRECT_URI` | 카카오 콘솔에 등록한 Redirect URI. 기본값 `{PUBLIC_BASE_URL}/auth/kakao/callback` |
| `KAKAO_ADMIN_KEY` | 탈퇴할 때 카카오 연결 끊기(unlink)에 쓰는 어드민 키. 없으면 연결 끊기를 건너뛰고 안내만 한다 |
| `AUTH_DEV_LOGIN` | `true`이면 카카오 없이 쓰는 개발용 로그인을 켠다(운영에서는 자동으로 꺼짐) |
| `SESSION_IDLE_DAYS` / `SESSION_MAX_DAYS` | 로그인 유지 기간. 기본값 7일(활동 없을 때) / 30일(최대) |
| `ANONYMOUS_RESULT_RETENTION_HOURS` | 로그인 전 체험 결과 보관 시간. 기본값 `24` |

## 설치와 실행

의존성을 설치합니다.

```bash
npm install
```

개발 서버를 실행합니다.

```bash
npm run dev
```

브라우저에서 아래 주소로 접속합니다.

```text
일반 사용자 화면: http://localhost:8080/
관리자 화면: http://localhost:8080/admin.html
```

관리자 화면에 들어갈 때는 `.env`의 `ADMIN_PASSWORD` 값을 입력합니다.

## 관리자 미션 생성 방법

1. `http://localhost:8080/admin.html`에 접속합니다.
2. 관리자 암호를 입력합니다.
3. 왼쪽 직무 목록에서 직무를 선택합니다.
4. 난이도를 선택합니다.
   - 쉬움
   - 보통
   - 어려움
5. `미션 생성` 버튼을 누릅니다. 서버가 먼저 OpenAI API preflight를 실행하며, 실패하면 Python 생성 프로세스를 시작하지 않습니다.
6. 생성 상태 타임라인과 원본 로그를 확인합니다.
7. 하단 미리보기에서 미션 제목, 시나리오, 수행 과제, 참고자료, 신뢰도 점수를 검토합니다.
8. 마음에 들면 `내보내기 승인`을 누릅니다.
9. 마음에 들지 않으면 `생성 결과 삭제`를 누릅니다.

생성 중에는 동시에 하나의 run만 실행할 수 있습니다. 이미 생성 중인 run이 있으면 추가 생성 요청은 거부됩니다.

## 직무를 생성 가능 상태로 만드는 방법

관리자 화면에는 `data/api_raw`에 있는 모든 직무가 표시됩니다. 다만 실제로 미션을 생성하려면 같은 직무 코드의 추가 조사 자료가 필요합니다.

예를 들어 `K000000997` 직무를 생성 가능하게 하려면 아래 두 경로가 준비되어야 합니다.

```text
data/api_raw/K000000997/
data/additional_search/K000000997.md
```

`data/additional_search/{jobCode}.md`에는 해당 직무의 실제 업무 맥락, 주요 과업, 필요한 판단 요소, 참고할 수 있는 자료 형태 등을 적습니다. 이 파일은 미션 생성기의 배경 자료로 사용됩니다.

새 직무를 추가한 뒤에는 관리자 페이지를 새로고침하면 직무 상태가 갱신됩니다.

## 생성 결과가 저장되는 위치

관리자에서 `미션 생성`을 누르면 임시 산출물이 아래 위치에 저장됩니다.

```text
outputs/pilot/v1/runs/{runId}/
```

주요 파일은 다음과 같습니다.

| 파일 | 설명 |
| --- | --- |
| `pilot_summary.json` | 생성 run 요약입니다. |
| `artifact_index.json` | 생성된 미션 산출물 목록입니다. |
| `jobs/{jobCode}/{difficulty}/mission_output.json` | 생성된 미션 원본입니다. |
| `_failed/failure_index.json` | 실패한 항목이 있을 때 실패 정보가 저장됩니다. |

`내보내기 승인`을 누르면 임시 산출물이 사용자 화면용 파일로 변환됩니다.

```text
missions/scenarios/*.json
missions/index.json
```

내보내기 성공 후 서버의 bootstrap 캐시가 갱신되므로 서버를 재시작하지 않아도 일반 사용자 화면에서 새 미션을 볼 수 있습니다.

## 일반 사용자 미션 수행 방법

1. `http://localhost:8080/`에 접속합니다.
2. 표시된 미션 중 하나를 선택합니다.
3. 시나리오와 참고자료를 읽습니다.
4. 답변을 작성하고 제출합니다.
5. AI 평가 결과와 피드백을 확인합니다.

사용자 답변 평가는 `OPENAI_API_KEY`와 `OPENAI_EVAL_MODEL`을 사용합니다.

## CLI로 미션 생성하기

관리자 화면 대신 명령어로도 미션을 생성할 수 있습니다.

```bash
python -u -m src.mission_generation.pilot_runner --jobs K000000997 --difficulties normal --concurrency 1
```

By default, CLI mission generation also requires a working OpenAI API call. If `OPENAI_API_KEY` is missing, the run records a failure instead of saving a mock mission. Use `--allow-mock-fallback` only when you intentionally want local mock output for missing-key dry runs, or `--mock` when you want to force mock output even if a key is configured.

```bash
python -u -m src.mission_generation.pilot_runner --jobs K000000997 --difficulties normal --concurrency 1 --allow-mock-fallback
```

생성 결과를 사용자 화면용 파일로 내보내려면 run 폴더를 지정합니다.

```bash
python scripts/export_missions.py --outputs outputs/pilot/v1/runs/{runId}
```

index만 다시 만들고 싶을 때는 다음 명령을 사용합니다.

```bash
python scripts/export_missions.py --rebuild-index
```

## 기능 지도로 추가된 화면과 기능

| 화면 | 주소 | 내용 |
| --- | --- | --- |
| 직무 탐색 | `/jobs.html` | KNOW 537개 직무, 이름·일상어 검색, 분야·체험 가능 필터, 최근 본 직무 |
| 직무 상세 | `/job.html?code=K…` | 하는 일·역량·환경·임금·전망(출처·조사연도), 비슷한 직무, 관심 저장·메모, 비교 담기 |
| 직무 비교 | `/compare.html` | 최대 3개, 브라우저에 유지, 적합도 점수는 넣지 않음 |
| 로그인 | `/login.html` | 카카오 로그인, 가입(약관·개인정보·만 14세 확인), 개발용 로그인 |
| 내 기록 | `/me.html` | 완료한 체험 다시 보기·지우기, 쓰던 답안 이어 쓰기, 관심 직무, 닉네임·로그아웃·탈퇴 |
| 약관 | `/terms.html`, `/privacy.html` | 초안. 배포 전에 연락처 자리(`[배포 전에 …]`)를 채워야 함 |

체험 화면(`/`)에는 업무 요청서 형식의 미션, 시작 전·후 흥미 질문, 결과 해석(수행 수준·직무 유사도·측정 범위), 근거 문장 강조, 해설 보고 재도전(1차·2차 레이더), 덜 잰 역량의 다음 미션, 공고 요구역량 비교, 강점 역량 직무, PNG 결과 카드·인쇄가 붙었습니다. 해설(기대 답안·채점 기준)은 `/api/bootstrap`에서 빠졌고, 미션을 제출한 뒤에만 `/api/missions/:key/explanation`으로 받을 수 있습니다.

외부 키 없이 전부 확인하려면:

```bash
npm run postings:fixture-snapshots
# PowerShell: $env:EVAL_MODE="fake"; $env:AUTH_DEV_LOGIN="true"; $env:POSTINGS_FIXTURE="1"; npm run dev
# bash:       EVAL_MODE=fake AUTH_DEV_LOGIN=true POSTINGS_FIXTURE=1 npm run dev
```

카카오 로그인을 켜려면 카카오 개발자 콘솔에서 앱을 만들고 카카오 로그인·OpenID Connect를 활성화한 뒤, 동의항목에 닉네임을 넣고 Redirect URI(`{PUBLIC_BASE_URL}/auth/kakao/callback`)를 등록합니다. 그다음 `.env`에 `KAKAO_LOGIN_CLIENT_ID`, `KAKAO_LOGIN_CLIENT_SECRET`, `KAKAO_ADMIN_KEY`, `PUBLIC_BASE_URL`을 넣습니다. 운영 도메인에서 HTTPS로 띄우는 방법은 `deploy/Caddyfile`과 `docker compose --profile https up -d`를 참고합니다.

### 채점 품질 측정(U18)

```bash
npm run eval:quality -- --runs=3                 # 기준 답안 25개 × 3회 채점 → reports/eval-quality-YYYYMMDD.json
npm run eval:quality -- --runs=3 --fail          # 기준 미달이면 실패 코드로 끝냄
```

기준 답안은 `data/eval/reference_answers.json`(쉬운 미션 5개 × 품질 5단계)에 있습니다. 팀원이 채점 기준을 보고 `human_scores`에 축별 점수(0~4, 재지 않는 축은 `null`)를 채우면 사람 점수와의 일치(±1점 비율, 평균 오차)도 함께 계산합니다. 반복 일관성은 실제 AI 채점(`OPENAI_API_KEY`)으로 돌릴 때 의미가 있습니다.

### 사람이 쓴 미션 넣기(U11)

```bash
python3 scripts/build_manual_missions.py K000001196 --check   # 검증만
python3 scripts/build_manual_missions.py K000001196           # 검증 통과 시 missions/scenarios와 index.json에 반영
```

`missions/manual/{직업코드}_{easy|normal|hard}.draft.json`을 생성 미션과 같은 validator.v1로 검사하고 같은 형식으로 저장합니다. 인사·교육·훈련사무원 미션 3개가 이 방법으로 들어갔습니다(조사 시트 `data/additional_search/K000001196.md` 기반).

## 채용공고 지도 (지금 이 일을 뽑는 곳)

결과 화면 맨 아래에 체험한 직업의 고용24 채용공고를 근무지 기준 전국 지도와 목록으로 보여줍니다.
데이터 처리 방법과 품질 지표는 [`docs/JOB_POSTINGS_METHOD.md`](docs/JOB_POSTINGS_METHOD.md)에 있습니다.

1. `.env`에 `WORK24_RECRUIT_AUTH_KEY`, `KAKAO_REST_API_KEY`를 넣습니다. 키가 없으면 섹션에 "채용공고 연동이 아직 설정되지 않았어"가 표시됩니다.
2. 스냅샷을 만듭니다. 서버가 켜져 있으면 시작 30초 뒤와 이후 1시간마다 오래된 스냅샷을 자동으로 갱신합니다.

```bash
npm run postings:refresh -- --verbose            # 체험 직업 전체(직종 미정 직업은 건너뜀)
npm run postings:refresh -- --job K000001080     # 한 직업만
npm run postings:discover                        # 직종코드 미정(tbd) 직업의 후보 코드 탐색 → docs/postings_occupation_discovery.md
npm run postings:discover -- --apply             # 탐색 제안을 data/postings/occupation_map.json에 기록(검토 후 커밋)
npm run postings:sample                          # 사람 검토용 표본 → docs/postings_sample_review.md
npm run postings:sample -- --tally               # 검토 결과(O/X) 집계
```

키 없이 화면을 확인하려면 고정 데이터 모드를 씁니다(가짜 공고, 실제 스냅샷 폴더와 분리됨).

```bash
npm run postings:fixture-snapshots
# PowerShell: $env:POSTINGS_FIXTURE="1"; npm run dev
# bash:       POSTINGS_FIXTURE=1 npm run dev
```

관리자 화면 아래쪽 "채용공고 데이터"에서 상태 확인과 갱신을 할 수 있습니다. 이 API는 `ADMIN_DEMO_UNLOCK`과 상관없이 항상 `ADMIN_PASSWORD`가 필요합니다.

지도 타일은 OpenStreetMap 공용 타일 서버를 씁니다. 졸업작품·데모 규모는 괜찮지만, **정식 서비스로 확장하면 타일 제공자를 바꿔야 해**(OSM 타일 정책상 대량 사용 금지). Leaflet은 CDN 없이 서버의 `/vendor/`에서 제공합니다.

## 검증 명령

프론트엔드와 TypeScript 서버 타입을 확인합니다.

```bash
npm run typecheck
```

관리자 페이지 JavaScript 문법을 확인합니다.

```bash
node --check app/admin.js
```

E2E 테스트가 필요한 경우 Playwright 테스트를 실행합니다.

```bash
npm run check:frontend       # app/ 아래 모든 JS 문법 검사
npm run test:unit            # 채용공고·지역·채점기·서버(로그인·기록·직무 API)·탐색/요구역량/품질 지표 단위 테스트
npm run test:e2e             # 기존 smoke
npm run test:e2e:postings    # 채용공고 섹션 E2E(고정 데이터, 8091 포트, 데스크톱·모바일)
npm run test:e2e:features    # 탐색·상세·비교·로그인·내 기록·재도전·결과 카드 E2E(8092 포트, 가짜 채점·개발용 로그인)
```

설치된 Playwright 브라우저 버전이 다르면 `PW_CHROMIUM_PATH`로 Chromium 실행 파일을 지정합니다. 같은 검사가 GitHub Actions(`.github/workflows/ci.yml`)에서 돕니다.

서버 상태는 다음 주소로 확인할 수 있습니다.

```text
http://localhost:8080/health
http://localhost:8080/api/bootstrap
```

## 문제 해결

### 관리자 페이지에서 401이 나올 때

입력한 암호가 `.env`의 `ADMIN_PASSWORD`과 같은지 확인합니다. `.env`를 수정했다면 서버를 재시작합니다.

### 직무가 `추가자료 필요`로 표시될 때

해당 직무 코드의 Markdown 파일이 필요합니다.

```text
data/additional_search/{jobCode}.md
```

### 미션 생성이 실패할 때

아래 항목을 확인합니다.

- `.env`에 `OPENAI_API_KEY`가 있는지
- `OPENAI_GENERATION_MODEL` 호출 권한과 OpenAI API 상태가 정상인지
- `data/api_raw/{jobCode}/`가 있는지
- `data/additional_search/{jobCode}.md`가 있는지
- Python 명령이 실행 가능한지
- `PYTHON_BIN` 값이 현재 환경에 맞는지

### 내보내기 승인이 실패할 때

내보내기 단계에서는 다음 항목을 검증합니다.

- `missions/index.json`에서 참조하는 파일이 실제로 존재하는지
- 미션 key 또는 id가 중복되지 않는지
- `axis_signals` 값이 유효한지
- `/api/bootstrap` 응답 스키마를 통과하는지

검증 실패 메시지를 확인한 뒤 생성 결과를 삭제하고 다시 생성하거나, 필요한 경우 `missions/scenarios`의 충돌 항목을 정리합니다.

### 포트가 이미 사용 중일 때

`.env`의 `PORT` 값을 바꾼 뒤 서버를 다시 실행합니다.

```env
PORT=8081
```

```bash
npm run dev
```
