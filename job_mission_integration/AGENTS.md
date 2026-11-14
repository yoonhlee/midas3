# AI 작업 규칙 (JOBSIM)

이 저장소에서 Claude Code·Codex 같은 AI 에이전트(그리고 사람)가 작업할 때 지키는 규칙이야. `CLAUDE.md`도 이 파일을 가리킨다.

## 1. 시작 전에
- 경로는 모두 `job_mission_integration/` 기준이다.
- `docs/MODEL_HANDOFF_LOG.md`의 최근 항목과 Open Items를 먼저 읽는다.
- 기능 지도(담당 묶음 A~F)의 범위를 벗어나는 변경은 하지 않는다. 다른 묶음 파일을 고쳐야 하면 PR 설명에 이유를 적는다.

## 2. 코드 구조
- 서버 진입점 `server.ts`는 설정 읽기·앱 생성·주기 작업만 한다. 라우트는 `src/server/routes/*.ts`, 기능 코드는 `src/lib/**`에 둔다.
- DB 접근은 `src/lib/db/repos.ts`의 함수로만 한다. 라우트에서 SQL을 쓰지 않는다. 스키마를 바꾸면 `src/lib/db/database.ts`에 **새 마이그레이션 버전**을 추가한다(이미 배포된 버전은 고치지 않는다).
- API 오류는 항상 `{ error: { code, message, details? } }` 형식이다(`sendApiError`, `ApiError`). 요청·응답 계약은 `src/lib/api/contracts.ts`의 zod 스키마로 검증한다.
- 새 화면은 별도 HTML 페이지 + `app/common/` 공통 모듈(`site.js`, `site.css`)로 만든다. 프론트엔드 프레임워크·번들러는 들이지 않는다.
- 채점은 서버 카탈로그의 미션으로 한다(`mission_key`). 클라이언트가 보낸 채점 기준을 믿지 않는다.

## 3. 보안·개인정보
- 인증키·비밀번호·토큰을 코드, 로그, 커밋, 테스트 고정 데이터, 브라우저 응답에 넣지 않는다. 로그에는 `maskSecrets`를 쓴다.
- 로그인이 필요한 상태 변경 API는 `requireUser` + `requireCsrf`를 붙인다. 관리자 API는 `requireAdmin`을 붙인다.
- 답변 원문은 본인만 볼 수 있다. 공유·결과 카드에는 넣지 않는다.
- 개인정보 수집 항목이나 보관 기간을 바꾸면 `app/privacy.html`과 `src/lib/auth/terms.ts`의 버전을 함께 고친다.

## 4. 검증 (커밋 전에 모두 통과)
```bash
npm run typecheck
npm run check:frontend
npm run test:unit
npm run test:e2e            # 기존 smoke
npm run test:e2e:postings   # 채용공고 지도
npm run test:e2e:features   # 탐색·로그인·기록·재도전
```
- 외부 API 없이 돌리려면 `EVAL_MODE=fake`(가짜 채점), `POSTINGS_FIXTURE=1`(가짜 공고), `AUTH_DEV_LOGIN=true`(개발용 로그인)를 쓴다. 셋 다 운영(APP_ENV=production)에서는 쓰지 않는다.
- 같은 검사가 GitHub Actions(`.github/workflows/ci.yml`)에서도 돈다.

## 5. 커밋·문서
- 커밋 메시지는 `feat(묶음): 내용`, `fix(묶음): 내용` 형식으로 쓴다.
- 코드를 고치면 `docs/MODEL_HANDOFF_LOG.md`에 날짜·이유·수정 파일·검증 결과를 남긴다.
- 사용자 화면 문구는 자연스러운 한국어 구어체(~해, ~야)로 쓴다.
- npm 스크립트에 `VAR=1 명령` 형태나 셸 glob을 쓰지 않는다(팀원이 Windows PowerShell을 쓴다).
