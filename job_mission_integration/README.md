# JOBSIM Mission Integration

직무 기반 미션을 생성하고, 사용자가 미션을 수행한 뒤 AI 평가 결과를 확인하는 웹 애플리케이션입니다.

프로젝트는 크게 두 흐름으로 나뉩니다.

1. 관리자 화면에서 직업 → 하는 일 문장 → 난이도를 골라 미션을 생성하고, 근거와 검수 결과를 본 뒤 카탈로그에 추가합니다.
2. 일반 사용자 화면에서 생성된 미션을 수행하고 결과를 분석합니다.

## 준비물

### 필수 프로그램

- Node.js 20 이상
- npm
- Python 3.11 이상
- OpenAI API key(사용자 답변 평가)
- Claude API key(관리자 미션 생성)

관리자 미션 생성은 Python 패키지 `anthropic`이 필요합니다. 처음 한 번 설치합니다.

```bash
python -m pip install -r requirements.txt
```

서버는 `PYTHON_BIN`에 적은 Python(비우면 Windows는 `python`, 그 외 환경은 `python3`)으로 미션 생성기를 실행하므로, 그 Python에 패키지를 설치합니다. 가상환경에 설치했다면 `PYTHON_BIN`에 가상환경의 Python 경로를 적습니다.

### 필수 파일과 폴더

```text
data/api_raw/
data/ncs/jobs/
missions/index.json
missions/scenarios/
.env
```

각 폴더의 역할은 다음과 같습니다.

| 경로 | 역할 |
| --- | --- |
| `data/api_raw/{jobCode}/` | 직업정보(KNOW) 원천 XML 데이터입니다. 미션 생성기가 직업의 하는 일, 지식, 능력 같은 정보를 이 폴더에서 읽습니다. |
| `data/ncs/jobs/{jobCode}.json` | 직업별 NCS 자료입니다. 하는 일 문장과 NCS 능력단위의 연결, 그 능력단위의 수행준거 · 서류 · 고려사항이 들어 있습니다. 관리자 화면의 직업 목록과 문장 목록은 이 폴더를 기준으로 표시됩니다. |
| `data/additional_search/{jobCode}.md` | 직무별 조사 자료입니다. 명령줄의 예전 생성 방식에서만 쓰고, 관리자 화면의 생성에는 쓰지 않습니다. |
| `missions/index.json` | 일반 사용자 화면에 노출할 미션 목록입니다. |
| `missions/scenarios/*.json` | 실제 사용자 화면에서 읽는 미션 시나리오 파일입니다. |
| `outputs/` | 미션 생성기의 실행 폴더가 생기는 곳입니다(아래 "생성 결과가 저장되는 위치" 참고). |
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
OPENAI_EVAL_MODEL=gpt-5-nano
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_GENERATION_MODEL=claude-opus-5-5
ANTHROPIC_GENERATION_EFFORT=medium
ADMIN_PASSWORD=admin-password
ADMIN_DEMO_UNLOCK=false
COMPATIBILITY_SCORE_GAMMA=1.5
PORT=8080
```

선택 값:

```env
PYTHON_BIN=python
ANTHROPIC_GENERATION_SPEED=
ADMIN_GENERATION_DAILY_LIMIT=20
ADMIN_GENERATION_NARROW=true
ADMIN_GENERATION_MODE=
EVALUATION_LOG_RETENTION_DAYS=30
EVALUATE_RATE_LIMIT_WINDOW_MS=60000
EVALUATE_RATE_LIMIT_MAX=30
```

| 환경 변수 | 설명 |
| --- | --- |
| `OPENAI_API_KEY` | 사용자 답변 평가에 사용하는 OpenAI API key입니다. |
| `OPENAI_EVAL_MODEL` | 사용자 답변 평가 모델입니다. 기본값은 `gpt-5-nano`입니다. |
| `ANTHROPIC_API_KEY` | 관리자 미션 생성(생성과 내용 검수)에 사용하는 Claude API key입니다. |
| `ANTHROPIC_GENERATION_MODEL` | 미션 생성과 내용 검수에 사용하는 Claude 모델입니다. 기본값은 `claude-opus-5-5`입니다. |
| `ANTHROPIC_GENERATION_EFFORT` | 미션 생성과 내용 검수의 추론 강도입니다. 기본값은 `medium`입니다. |
| `ANTHROPIC_GENERATION_SPEED` | 비우면 보통 속도, `fast`면 빠른 모드입니다. 빠른 모드는 비용이 2배입니다. |
| `ANTHROPIC_GENERATION_FALLBACKS` | 요청이 거절될 때 다른 Claude 모델이 이어받게 하는 설정입니다. 비우면 켜져 있고, 이 설정 때문에 요청이 400으로 실패하면 `false`로 끕니다. |
| `ADMIN_GENERATION_DAILY_LIMIT` | 관리자 화면에서 하루(한국 시간)에 시작할 수 있는 미션 생성 건수입니다. 기본값은 `20`입니다. |
| `ADMIN_GENERATION_NARROW` | 자료 형태를 문장 · 능력단위 · 난이도에 맞게 좁힐지 정합니다. 기본값은 좁힘이고, `false`면 일곱 형태를 모두 엽니다. |
| `ADMIN_GENERATION_MODE` | `fake`이면 Claude API를 부르지 않고 저장소의 고정 결과로 생성과 검수를 대신합니다. 키 없이 관리자 화면을 볼 때 씁니다. `APP_ENV=production`에서는 켜지지 않습니다. |
| `MISSION_LLM_PROVIDER` / `OPENAI_GENERATION_MODEL` | 명령줄 생성기의 제공자와 그때의 OpenAI 모델입니다. 제공자는 비우면 `anthropic`이고, `openai`로 바꾸면 `OPENAI_GENERATION_MODEL`(기본값 `gpt-5.4-nano`)을 씁니다. 관리자 화면의 생성은 늘 `anthropic`으로 실행됩니다. |
| `ADMIN_PASSWORD` | 관리자 페이지 접속 암호이자 보호된 API 호출 토큰입니다. |
| `ADMIN_DEMO_UNLOCK` | `true`이면 암호 없이 관리자 화면을 조회만 할 수 있게 엽니다. 생성 · 추가 · 삭제는 그래도 `ADMIN_PASSWORD`가 필요합니다. |
| `COMPATIBILITY_SCORE_GAMMA` | 직무 추천/적합도 점수 보정값입니다. 기본값은 `1.5`입니다. |
| `PORT` | 로컬 서버 포트입니다. 기본값은 `8080`입니다. |
| `PYTHON_BIN` | 사용할 Python 실행 파일입니다. 비우면 Windows는 `python`, 그 외 환경은 `python3`를 사용합니다. 관리자 미션 생성기도 이 Python으로 실행하므로 `anthropic` 패키지가 설치돼 있어야 합니다. |
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

관리자 화면에는 메뉴가 셋 있습니다: `새 미션 만들기`, `생성 기록`, `미션 카탈로그`. 화면 맨 위의 용어 안내에서 하는 일 문장, 능력단위, 수행준거, 직접 · 분야 한정의 뜻을 볼 수 있고, 위 띠의 `용어 안내` 버튼으로 여닫습니다. 왼쪽 사이드바 아래에는 `오늘 생성 n / 한도`, API 상태 한 줄, `사용자 화면`, `로그아웃`이 있습니다.

### 미션 하나 만들기

1. `http://localhost:8080/admin.html`에 접속해 관리자 암호(`ADMIN_PASSWORD`)를 입력합니다.
2. `새 미션 만들기`에서 직업을 고릅니다. 위의 검색 칸으로 직업 이름을 찾을 수 있습니다.
3. 그 직업의 하는 일 문장을 고릅니다. 고를 수 없는 문장은 접혀 있고, 펼치면 문장마다 고를 수 없는 이유가 보입니다.
4. 생성 설정을 확인합니다.
   - 능력단위: 고른 문장에 이어진 NCS 능력단위입니다. 둘 이상이면 고를 수 있고, 연결한 이유도 볼 수 있습니다.
   - 난이도: 쉬움(자료 1개 · 과제 1개 · 약 10분 분량), 보통(자료 2개 · 과제 1개 · 약 15분 분량), 어려움(자료 3개 · 과제 2개 · 약 20분 분량) 가운데 하나입니다. 처음 값은 보통입니다.
   - 자료 형태(자동): 문장 · 능력단위 · 난이도에 맞춰 표, 차트, 기록, 메모, 체크리스트, 이메일, 일정표 가운데 쓸 형태를 정해 보여 줍니다. `ADMIN_GENERATION_NARROW=false`이면 일곱 형태를 모두 엽니다.
   - 내용 검수 포함: 켜 두면 생성이 끝난 뒤 기대 답을 가린 채 미션을 풀어 보고, 기대 답과 견주어 판정합니다. 처음 값은 켬입니다.
   - 예상 소요 · 예상 비용: 난이도와 내용 검수 포함 여부에 따라 바뀝니다.
5. `미션 생성` 버튼을 누릅니다. 서버가 먼저 시작 전 확인(Python 패키지, API key, 모델 조회)을 하고, 통과하면 생성을 시작합니다. 시작 전 확인은 글을 만들지 않으므로 비용이 들지 않습니다.
6. 실행 화면에서 단계가 차례로 넘어갑니다: 설계 → 설계 검사 → 미션 작성 → 미션 검사 → 내용 검수 → 검토 · 승인. 검사에 걸리면 한 번 다시 쓰고 그 단계에 "다시 씀"이 표시됩니다. 내용 검수를 끄고 만들면 내용 검수 단계는 건너뜁니다. 창을 닫거나 다른 화면에 가도 생성은 계속되고, `생성 기록`에서 그 실행을 다시 열 수 있습니다.
7. 생성이 끝나면 결과 화면에 탭이 둘 보입니다.
   - `미리보기와 근거`: 미션의 상황, 과제, 자료, 채점 기준을 사용자 화면과 같은 모양으로 보여 줍니다. 과제, 자료, 채점 기준을 누르면 오른쪽 근거 칸에 왜 그렇게 만들었는지와 근거가 된 원문(NCS 수행준거 등)이 보입니다. 위쪽에는 이 미션이 만들어진 길(하는 일 문장 → 능력단위 → 수행준거 → 미션)이 있습니다.
   - `검수`: 판정과 함께 풀 수 있는 미션인지, 풀어 본 답과 기대 답이 같은지, 지적이 몇 건인지 보여 줍니다. 판정은 통과 · 확인할 점 N건 · 문제 · 검수 실패 · 검수 안 함 가운데 하나입니다. 검수를 하지 않았으면 `검수 돌리기`, 검수가 실패했으면 `검수 다시 돌리기`로 검수만 다시 실행할 수 있습니다.
8. 마음에 들면 `카탈로그에 추가`를 누릅니다. 미션이 사용자 화면용 파일로 바뀌어 서비스에 들어가고, 버튼 자리가 `추가됨`과 `카탈로그에서 보기`로 바뀝니다. 판정이 문제인 미션은 추가할 수 없습니다.
9. 마음에 들지 않으면 `삭제`를 누릅니다.

### 생성 기록과 미션 카탈로그

- `생성 기록`: 만든 실행을 새것부터 보여 줍니다(만든 때, 직업, 난이도, 미션 제목, 검수, 상태). 상태는 생성 중 · 검토 대기 · 추가됨 · 실패 · 중단됨 가운데 하나입니다. 줄을 누르면 그 실행의 화면이 열립니다. 생성 도중에 서버가 꺼지면 그 실행은 중단됨이 됩니다. 다만 미션을 저장한 뒤 검수하던 실행은 검토 대기로 돌아오고 판정은 검수 실패가 됩니다.
- `미션 카탈로그`: 서비스에 들어 있는 미션을 직업별로 보여 줍니다. 직업 줄을 펼치면 그 직업의 미션이 나오고, `열기`를 누르면 사용자 화면에서 그 미션이 열립니다. 관리자 페이지에서 추가한 미션에는 `관리자 추가`, 관리자 페이지에서 추가한 미션만 있는 직업에는 `새 직업`이 표시됩니다.

삭제는 두 가지이고, 누를 때마다 한 번 확인을 묻습니다.

| 어디서 | 하는 일 |
| --- | --- |
| `생성 기록`의 목록과 결과 화면의 `삭제` | 만든 결과(미션, 근거 기록, 검수 기록, 실행 폴더)를 완전히 지웁니다. 서비스에 추가돼 있었으면 서비스에서도 빠집니다. 되돌릴 수 없습니다. |
| `미션 카탈로그`의 `삭제` | 서비스에서만 뺍니다. 생성 기록에는 남고 상태가 검토 대기로 돌아가므로 다시 추가할 수 있습니다. 관리자 페이지에서 추가한 미션에만 있고, 미리 넣은 미션은 지울 수 없습니다. |

### 한 번에 하나, 하루 한도

- 생성은 한 번에 하나만 실행됩니다. 도는 실행이 있으면 `새 미션 만들기`의 버튼 자리에 그 실행으로 가는 버튼이 보이고, 새 생성 요청은 거부됩니다.
- 하루(한국 시간)에 시작할 수 있는 건수는 `ADMIN_GENERATION_DAILY_LIMIT`(기본값 20)입니다. 사이드바의 `오늘 생성 n / 한도`에서 확인할 수 있고, 한도를 다 쓰면 다음 날까지 생성 버튼이 막힙니다. 생성 기록을 지워도 그날의 건수는 줄지 않습니다.
- `ADMIN_DEMO_UNLOCK=true`이면 암호 없이 조회만 열립니다. 이때는 둘러볼 수 있지만 생성 · 추가 · 삭제를 하려면 암호를 입력해야 합니다.

### 키 없이 관리자 화면 보기

`ADMIN_GENERATION_MODE=fake`로 서버를 띄우면 Claude API를 부르지 않고, 저장소의 고정 결과(`tests/fixtures/admin_generation/run_sample`)를 고른 직업과 난이도에 맞춰 복사합니다. 사이드바의 API 상태는 "시험 모드(실제 생성 안 함)"로 표시됩니다.

```bash
# PowerShell: $env:ADMIN_GENERATION_MODE="fake"; npm run dev
# bash:       ADMIN_GENERATION_MODE=fake npm run dev
```

가짜 모드에서도 `카탈로그에 추가`는 실제 미션 폴더를 바꿉니다. 저장소의 `missions/`를 그대로 두려면 `node scripts/prepare-admin-e2e.mjs`로 복사본(`test-results/admin-missions`)을 만든 뒤 `MISSIONS_DIR=test-results/admin-missions`를 함께 주고 띄웁니다.

## 고를 수 있는 직업과 문장

관리자 화면의 직업 목록과 문장 목록은 `data/ncs/jobs/{jobCode}.json`을 기준으로 합니다. 이 파일에는 직업의 하는 일 문장마다 이어진 NCS 능력단위와 그 연결의 종류가 적혀 있습니다.

문장과 능력단위가 맞는 정도는 화면의 `용어 안내`와 같은 말로 나눕니다.

| 연결 | 뜻 | 고를 수 있는가 |
| --- | --- | --- |
| 직접 | 일이 그대로 같습니다. | 고를 수 있습니다. |
| 분야 한정 | 같은 일을 한 업종 안에서 다룹니다. | 고를 수 있습니다. |
| 그 밖의 연결 | 이어진 능력단위가 있지만 범위가 넓거나 수준이 다릅니다. | 고를 수 없습니다. |
| 연결 없음 | 이어진 능력단위가 없습니다. | 고를 수 없습니다. |

직접 또는 분야 한정 연결이 하나라도 있는 문장만 고를 수 있고, 그런 문장이 하나도 없는 직업은 직업 목록에 나오지 않습니다.

새 직업을 더하려면 같은 직업 코드의 두 경로가 함께 있어야 합니다.

```text
data/ncs/jobs/K000001080.json
data/api_raw/K000001080/
```

서버는 처음 목록을 읽을 때 이 폴더를 한 번 읽어 둡니다. 파일을 넣거나 바꾼 뒤에는 서버를 다시 실행합니다.

## 생성 결과가 저장되는 위치

관리자 화면에서 `미션 생성`을 누르면 미션 생성기의 실행 폴더가 아래 위치에 생깁니다.

```text
outputs/pilot/v1/runs/pilot_v1_{날짜}_{시각}/
```

주요 파일은 다음과 같습니다.

| 파일 | 설명 |
| --- | --- |
| `pilot_summary.json` | 실행 요약입니다. |
| `artifact_index.json` | 생성된 산출물 목록입니다. |
| `jobs/{jobCode}/{difficulty}/mission_output.json` | 생성된 미션 원본입니다. |
| `jobs/{jobCode}/{difficulty}/generation_basis.json` | 근거 기록입니다. 결과 화면의 근거 칸이 이 파일을 읽습니다. |
| `basis_cards/` | 근거 기록을 사람이 읽기 쉽게 정리한 HTML입니다. |
| `review/{jobCode}_{difficulty}.json` | 내용 검수 기록입니다. 결과 화면의 `검수` 탭이 이 파일을 읽습니다. |
| `_failed/failure_index.json` | 실패한 항목이 있을 때 실패 정보가 저장됩니다. |

생성 기록(실행마다 고른 직업 · 문장 · 능력단위 · 난이도, 상태, 검수 판정, 실행 폴더 이름)은 DB(`DATABASE_PATH`, 기본값 `reports/jobsim.sqlite`)의 `admin_generation_runs` 표에, 날짜별 시작 건수는 `admin_generation_daily` 표에 남습니다.

`카탈로그에 추가`를 누르면 미션이 사용자 화면용 파일로 바뀌어 아래 위치에 들어갑니다.

```text
missions/scenarios/*.json
missions/index.json
```

관리자 페이지에서 추가한 미션의 키는 `jobsim_admin_v1`로 시작합니다(`jobsim_admin_v1__mission_{jobCode}_{difficulty}_{번호}`). `미션 카탈로그`의 `삭제`는 이 키로 시작하는 미션만 지울 수 있습니다.

추가한 뒤 서버의 미션 카탈로그가 바로 갱신되므로 서버를 재시작하지 않아도 일반 사용자 화면에서 새 미션을 볼 수 있습니다.

## 일반 사용자 미션 수행 방법

1. `http://localhost:8080/`에 접속합니다.
2. 표시된 미션 중 하나를 선택합니다.
3. 시나리오와 참고자료를 읽습니다.
4. 답변을 작성하고 제출합니다.
5. AI 평가 결과와 피드백을 확인합니다.

사용자 답변 평가는 `OPENAI_API_KEY`와 `OPENAI_EVAL_MODEL`을 사용합니다.

## CLI로 미션 생성하기

관리자 화면 대신 명령어로도 미션을 생성할 수 있습니다. 아래 세 명령은 관리자 화면의 생성이 차례로 실행하는 명령과 같습니다.

1. 대상 파일을 만듭니다. 직업 코드, 하는 일 문장 번호, 능력단위(직무코드:능력단위번호), 난이도를 줍니다. 직접 또는 분야 한정 연결만 받고, 그 밖의 연결이면 파일을 쓰지 않고 오류를 냅니다.

```bash
python -m src.mission_generation.admin_target --job K000001080 --exec exec_005 --unit 20010105:09 --difficulty normal --out outputs/admin_targets/sample.json
```

`--out` 대신 `--print`를 주면 파일을 쓰지 않고 대상을 화면에 출력합니다(API를 부르지 않습니다). `--no-narrow`를 주면 자료 형태를 좁히지 않습니다.

2. 미션을 생성합니다. 설계 → 설계 검사 → 미션 작성 → 미션 검사를 거쳐 미션과 근거 기록을 `outputs/pilot/v1/runs/pilot_v1_…/`에 저장합니다.

```bash
python -u -m src.mission_generation.pilot_runner --ncs-background --two-stage-basis --ncs-targets outputs/admin_targets/sample.json --ncs-root data/ncs/jobs --concurrency 1
```

3. 내용 검수를 실행합니다. 판정은 실행 폴더의 `review/`에 남고, 미션은 고치지 않습니다.

```bash
python -u -m src.mission_generation.mission_reviewer --run-dir outputs/pilot/v1/runs/{실행 폴더}
```

2와 3은 Claude API를 부르므로 `ANTHROPIC_API_KEY`가 필요합니다.

### 예전 방식

직무별 조사 자료(`data/additional_search/{jobCode}.md`)를 배경 자료로 쓰는 방식입니다.

```bash
python -u -m src.mission_generation.pilot_runner --jobs K000000997 --difficulties normal --concurrency 1
```

명령줄 생성기는 `MISSION_LLM_PROVIDER`로 정한 제공자(비우면 `anthropic`)의 API를 실제로 부릅니다. 그 제공자의 API key가 없으면 mock 미션을 저장하지 않고 실패로 기록합니다. key 없이 로컬 mock 결과를 일부러 만들 때만 `--allow-mock-fallback`을 쓰고, key가 있어도 mock으로 만들려면 `--mock`을 씁니다.

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

채용공고 데이터의 상태 확인과 갱신 API(`GET /api/admin/postings/status`, `POST /api/admin/postings/refresh`)는 `ADMIN_DEMO_UNLOCK`과 상관없이 항상 `ADMIN_PASSWORD`가 필요합니다.

지도 타일은 OpenStreetMap 공용 타일 서버를 씁니다. 졸업작품·데모 규모는 괜찮지만, **정식 서비스로 확장하면 타일 제공자를 바꿔야 해**(OSM 타일 정책상 대량 사용 금지). Leaflet은 CDN 없이 서버의 `/vendor/`에서 제공합니다.

## 검증 명령

프론트엔드와 TypeScript 서버 타입을 확인합니다.

```bash
npm run typecheck
```

관리자 화면(`app/admin/`)을 포함해 `app/` 아래 모든 JavaScript 문법을 확인합니다.

```bash
npm run check:frontend
```

단위 테스트와 E2E 테스트가 필요한 경우 아래 명령을 실행합니다.

```bash
npm run test:unit            # 채용공고·지역·채점기·서버(로그인·기록·직무 API)·탐색/요구역량/품질 지표·관리자 미션 생성(경로, 화면의 말) 단위 테스트
npm run test:e2e             # 기존 smoke
npm run test:e2e:postings    # 채용공고 섹션 E2E(고정 데이터, 8091 포트, 데스크톱·모바일)
npm run test:e2e:features    # 탐색·상세·비교·로그인·내 기록·재도전·결과 카드 E2E(8092 포트, 가짜 채점·개발용 로그인)
npm run test:e2e:admin       # 관리자 화면 E2E(8093 포트, 가짜 생성 모드, 복사한 미션 폴더 test-results/admin-missions)
```

미션 생성기(Python)의 테스트는 API를 부르지 않습니다.

```bash
python -X utf8 -m unittest discover -s tests/python
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

### 미션 생성이 실패할 때

관리자 화면은 생성을 시작할 수 없는 이유를 `미션 생성` 버튼 아래와 사이드바의 API 상태에, 생성이 실패한 이유를 그 실행의 화면에 보여 줍니다. 자주 보이는 글과 확인할 것은 다음과 같습니다.

| 화면의 글 | 확인할 것 |
| --- | --- |
| 서버에 Claude API 키가 없습니다. | `.env`에 `ANTHROPIC_API_KEY`를 넣고 서버를 다시 실행합니다. |
| 서버에 Python 패키지(anthropic)가 깔려 있지 않습니다. | `PYTHON_BIN`의 Python에 `python -m pip install -r requirements.txt`로 패키지를 설치합니다. |
| Claude API 키가 받아들여지지 않았습니다. / 설정한 모델을 찾을 수 없습니다. | `ANTHROPIC_API_KEY` 값과 `ANTHROPIC_GENERATION_MODEL`을 확인합니다. |
| 서버에서 Python을 실행하지 못했습니다. | Python 명령이 실행 가능한지, `PYTHON_BIN` 값이 현재 환경에 맞는지 확인합니다. |
| 오늘 만들 수 있는 건수를 모두 썼습니다. | 하루 한도(`ADMIN_GENERATION_DAILY_LIMIT`, 기본값 20)를 다 쓴 것입니다. 다음 날(한국 시간)에 다시 만들거나, 한도를 올리고 서버를 다시 실행합니다. |
| 지금 만들고 있는 미션이 있습니다. 끝난 뒤에 다시 시작해 주세요. | 생성은 한 번에 하나만 실행됩니다. `생성 기록`에서 생성 중인 실행을 열어 끝나기를 기다립니다. |
| 검사를 통과하지 못해 저장되지 않았습니다. (코드) | 생성기의 검사에 걸려 미션이 저장되지 않은 것입니다. 실행 화면의 상세 로그를 확인한 뒤 `삭제`하고 다시 만듭니다. |

### 카탈로그에 추가가 실패할 때

카탈로그에 추가할 때는 다음 항목을 검증합니다.

- `missions/index.json`에서 참조하는 파일이 실제로 존재하는지
- 미션 key 또는 id가 중복되지 않는지
- `axis_signals` 값이 유효한지
- `/api/bootstrap` 응답 스키마를 통과하는지

검증에 실패하면 `missions/`의 색인과 파일을 추가하기 전 모습으로 되돌립니다. 검증 실패 메시지를 확인한 뒤 생성 결과를 삭제하고 다시 생성하거나, 필요한 경우 `missions/scenarios`의 충돌 항목을 정리합니다.

"이 미션은 지금 카탈로그에 추가할 수 없습니다."가 보이면 검수 판정이 문제이거나, 실행이 검토 대기 상태가 아닌 것입니다.

### 포트가 이미 사용 중일 때

`.env`의 `PORT` 값을 바꾼 뒤 서버를 다시 실행합니다.

```env
PORT=8081
```

```bash
npm run dev
```
