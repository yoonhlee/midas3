# JOBSIM 기능 추가 명세 v2: "지금 이 일을 뽑는 곳" — 체험한 직업의 실제 채용공고 지도

> 이 문서는 2026-10-26에 전달받은 기능 명세 원문이야. 구현 계획은 `JOB_POSTINGS_MAP_PLAN.md`, 실제 결정·결과는 `JOB_POSTINGS_METHOD.md`와 `MODEL_HANDOFF_LOG.md`를 봐.
> 경로는 모두 `job_mission_integration/` 기준이야.

---

## 0. 목표와 완료 기준

### 목표
- 기존 흐름(직업 선택 → 사전 질문 → 미션 → 결과)은 그대로 둬.
- 결과 화면 맨 아래에 **"지금 이 일을 뽑는 곳"** 섹션을 붙여.
- 이 섹션은 체험한 직업의 **지금 지원할 수 있는 고용24 채용공고**를 **근무지 기준 전국 지도**에 표시하고, 수도권/비수도권 요약과 목록을 함께 보여줘.
- 이 섹션은 판정이나 추천을 하지 않아. 공식 공고를 출처, 기준 시점, 조회 조건과 함께 그대로 보여주는 게 전부야. 그래서 데이터 처리의 모든 단계가 검증 가능해야 해(6장의 품질 지표).

### 완료 기준
1. 인증키가 없어도 고정 데이터 모드(`POSTINGS_FIXTURE=1`)에서 섹션 전체(요약, 지도, 필터, 목록)가 동작해. 단위 테스트, E2E 테스트, `npm run typecheck`도 모두 통과해.
2. 인증키가 있으면 `npm run postings:refresh`로 5개 직업의 스냅샷이 만들어지고, 결과 화면에 실제 공고가 표시돼.
3. `docs/JOB_POSTINGS_METHOD.md`에 아래 내용이 실제 값과 함께 적혀 있어. 키가 없으면 비어 있다는 사실을 적어.
   - 데이터 출처와 조회 조건
   - 직종 연결 근거
   - 지역 판정 규칙
   - 품질 지표
4. 인증키가 코드, 로그, 커밋, 스냅샷, 브라우저 응답 어디에도 노출되지 않아.
5. 기존 기능이 그대로 동작해. 결과 화면의 기존 섹션, 관리자 미션 생성, 기존 smoke 테스트 모두 해당돼.

## 1. 작업 원칙

- `aws` 브랜치(가장 최신, 2026-06-05)에서 `feature/job-postings-map` 브랜치를 새로 만들어.
- 이 문서를 `job_mission_integration/docs/JOB_POSTINGS_MAP_SPEC.md`로 저장해. 짧은 구현 계획은 `docs/JOB_POSTINGS_MAP_PLAN.md`에 적고 바로 진행해. 계획 승인을 기다릴 필요는 없어.
- 10장의 Phase 순서대로 진행해. Phase가 끝날 때마다 9장의 검증 중 해당되는 걸 돌린 뒤 커밋해. 커밋 메시지는 `feat(postings): ...` 형식이야.
- 저장소 규칙: 코드를 수정하면 `docs/MODEL_HANDOFF_LOG.md`에 항목을 추가해(날짜, 이유, 수정 파일, 검증 결과).
- 사용자 화면 문구는 자연스러운 한국어 구어체(~해, ~야)로 써.
- 서버 코드는 `src/lib/postings/` 아래 모듈로 나눠. `server.ts`에는 라우트 연결과 스케줄러 시작만 둬.
- 경로는 모두 `job_mission_integration/` 기준이야.
- 팀원이 Windows(PowerShell)를 써. 그래서 npm 스크립트에 두 가지를 쓰지 마.
  - `VAR=1 명령` 식의 환경변수 앞붙이기: 대신 CLI 옵션이나 Playwright `webServer.env`를 써.
  - 셸 glob: 테스트 파일을 명시해.
- CLI 스크립트는 `import "dotenv/config"`로 `.env`를 읽어(`server.ts`와 같은 방식).

## 2. 사전 조사로 확인된 사실

### 2.1 고용24 채용정보 목록 API

출처는 고용24 Open-API "서비스 소개 및 신청" 페이지의 채용정보 명세와 공공데이터포털 명세야.

**요청 URL**: `https://www.work24.go.kr/cm/openApi/call/wk/callOpenApiSvcInfo210L01.do`

**필수 파라미터**: `authKey`, `callTp=L`, `returnType=XML`, `startPage`(페이지 번호, 1~1000), `display`(1~100)

**이번에 쓰는 선택 파라미터**

| 파라미터 | 값 | 설명 |
|---|---|---|
| `occupation` | 직종코드 | 여러 개는 `\|`로 구분(예: `024101\|024102`). 인코딩하면 `%7C`야 |
| `regDate` | `D-0`, `D-3`, `W-1`, `W-2`, `M-1` | 등록 기간. 기본값은 `M-1`(한 달) |
| `sortOrderBy` | `DESC` | 등록일 정렬 |
| `coTp` | `01`, `03`, `04`, `05`, `09` | 기업형태: 대기업, 벤처, 공공기관, 외국계, 청년친화강소기업. 다중 검색 여부가 명세에 없으니 하나씩 호출해 |
| `keyword` | 문자열(UTF-8) | 키워드 검색. 직종코드를 못 정한 직업에서만 써 |

값이 빈 파라미터는 아예 보내지 마. 고용24는 "전체" 조건을 파라미터를 빼는 것으로 표현해.

**응답 구조** (필드명은 명세 기준, 값은 예시)

```xml
<?xml version='1.0' encoding='UTF-8'?>
<wantedRoot>
  <total>2</total><startPage>1</startPage><display>100</display>
  <wanted>
    <wantedAuthNo>K000000000000001</wantedAuthNo>
    <company>가상데이터(주)</company><busino></busino><indTpNm></indTpNm>
    <title>데이터 분석가 채용</title>
    <salTpNm>연봉</salTpNm><sal>3000만원 ~ 3500만원</sal><minSal></minSal><maxSal></maxSal>
    <region>서울 강남구</region>
    <holidayTpNm></holidayTpNm><minEdubg></minEdubg><maxEdubg></maxEdubg><career></career>
    <regDt>26-09-28</regDt>
    <closeDt>채용시까지  26-10-30</closeDt>
    <infoSvc>VALIDATION</infoSvc>
    <wantedInfoUrl>https://...</wantedInfoUrl><wantedMobileInfoUrl>https://...</wantedMobileInfoUrl>
    <zipCd></zipCd><strtnmCd>116804166040</strtnmCd>
    <basicAddr>서울특별시 강남구 가상로 1</basicAddr><detailAddr>3층</detailAddr>
    <empTpCd>10</empTpCd><jobsCd>135200</jobsCd><smodifyDtm></smodifyDtm>
  </wanted>
</wantedRoot>
```

- `infoSvc` 값은 `VALIDATION`(고용24 인증), `SCRAP`(스크랩), `JOBROBOT`(잡로봇) 중 하나야.
- **오류 응답** 형태: `<GO24><error>신청하신 OpenApi 서비스가 존재하지 않습니다</error></GO24>`. 최상위 요소 아래에 `error`가 있으면 실패로 처리하고 메시지만 기록해.

**함정** (실제 운영 중인 수집 코드에서 관찰된 것 포함)
- `wanted`가 1건이면 배열이 아니라 객체로 파싱돼. 항상 배열로 정규화해.
- 코드값은 앞자리가 0일 수 있어(`024101`). `fast-xml-parser`는 **`parseTagValue: false`가 필수**야. 기본 설정이면 `024101`이 `24101`로 바뀌는 걸 직접 확인했어.
- 날짜 형식
  - `regDt`는 `yy-MM-dd`야.
  - `closeDt`는 `26-10-31`, `채용시까지  26-10-30`(공백 2칸), `채용시까지`(날짜 없음) 같은 형태로 와.
- 일부 `wanted`는 회사명이나 주소 필드가 비어 있어.
- 고용24가 조건을 조용히 무시한 운영 사례가 있어. 급여형태 조건(`salTp`)이 무시됐고, 일용직(`empTpGb=2`)은 이 API로 조회되지 않았어. 그래서 **보낸 조건이 실제로 적용됐는지 응답으로 검증**해(4.4).
- 인증키는 신청한 서비스마다 따로 발급돼. 채용정보 키로 공통코드 같은 다른 서비스는 못 불러.
- 응답은 UTF-8로 직접 디코딩해. 헤더에 charset이 빠지는 경우를 대비하는 거야.
- 인증키가 URL에 들어가. 그래서 요청 URL이나 오류 메시지를 로그에 남길 때는 반드시 키를 `****`로 가려.
- 일일 호출 한도는 명세에 없어. 보수적으로 써: 순차 호출, 호출 사이 300ms 간격, 직업당 최대 10페이지.

**상세 API** (직종명을 확인할 때만 사용)
- 요청: `.../wk/callOpenApiSvcInfo210D01.do?callTp=D&returnType=XML&infoSvc=VALIDATION&wantedAuthNo=...`
- 응답의 `wantedDtl > wantedInfo > jobsNm`이 직종명, `wantedTitle`이 공고 제목이야.
- 상세는 `infoSvc=VALIDATION`인 공고에만 있어.

참고 구현: 공개 저장소 `github.com/Let-s-intern/ogonggo-be`의 `ingestion/work24` 패키지야. `Work24Client`, `Work24JobRoles`, `Work24Collector` 같은 클래스가 있어.

### 2.2 직종 연결: KNOW 코드와 고용24 코드는 분류 버전이 달라

- KNOW `dtlGb_3.xml`의 `kecoList/kecoCd`는 4자리 고용직업분류(KECO)야. 데이터분석가는 `1341 데이터 전문가`야.
- 그런데 고용24 `jobsCd`는 **6자리 세분류**이고 분류 버전도 달라. 고용24에서 `134100`은 "네트워크 시스템 개발자"이고, 데이터 분석가는 `135200`이야.
- 그래서 **KNOW 코드 앞자리로 고용24 코드를 추정하면 엉뚱한 공고가 들어와.** 직업별 고용24 직종코드는 검증된 매핑 파일 `data/postings/occupation_map.json`으로 관리해.
- 이미 확인된 값이야. 2026-10 기준으로 운영 중인 고용24 수집 코드의 직종표(참고 구현의 `Work24JobRoles.kt`)에서 확인했어.

| KNOW 직업 | KNOW KECO | 고용24 직종코드(jobsCd) |
|---|---|---|
| K000000872 광고·홍보·마케팅전문가 | 0241 광고·홍보 전문가 | `024101` 광고·홍보 전문가, `024102` 마케팅 전문가 |
| K000000997 상품기획자 | 0243 상품 기획자 | `024301` 상품 기획자 (`024302` 머천다이저는 다른 직업이라 제외) |
| K000001080 데이터분석가 | 1341 데이터 전문가 | `135200` 데이터 분석가(빅데이터 분석가) |
| K000001179 투자분석가 | 0311 투자·신용 분석가 | **확인 필요** |
| K000007519 보험상품개발자 | 0313 보험·금융상품 개발자 | **확인 필요** |

- 확인이 필요한 두 직업은 4.2의 탐색 절차로 정해.

### 2.3 지역 판정

- `strtnmCd`는 12자리 도로명코드야. 앞 5자리가 시군구 코드, 앞 2자리가 시도 코드야. 예를 들어 `11680…`은 서울 강남구야.
- **시도 코드 정규화** (통합·개편 반영)
  - 그대로 쓰는 코드: 11 서울, 26 부산, 27 대구, 28 인천, 30 대전, 31 울산, 36 세종, 41 경기, 43 충북, 44 충남, 47 경북, 48 경남, 50 제주
  - 42(옛 강원도) → 51 강원
  - 45(옛 전라북도) → 52 전북
  - 29(옛 광주광역시), 46(옛 전라남도) → **전남광주**
- 2026-07-01에 광주광역시와 전라남도가 **전남광주통합특별시**(약칭 광주특별시)로 통합됐어. 주소 표기도 "전남광주통합특별시 동구"처럼 바뀌었어.
  - 통합 후 새 시도 코드는 **확인 필요**야. 참고 구현은 `12`로 쓰고 있어.
  - 29, 46, 12는 모두 전남광주로 처리해.
- **주소 문자열 정규화**: 코드가 없을 때 `region`, `basicAddr`, 카카오 응답에 적용해. 전체 대응표를 코드 상수로 만들어. 예시:
  - 서울 / 서울특별시 / 서울시 → 서울
  - 광주 / 광주광역시 / 광주특별시 / 전남 / 전라남도 / 전남광주 / 전남광주통합특별시 → 전남광주
  - 강원도 / 강원특별자치도 → 강원
  - 전라북도 / 전북특별자치도 → 전북
  - 세종특별자치시 → 세종
  - 제주특별자치도 → 제주
- **판정 우선순위**: `strtnmCd` → `region` 텍스트 → `basicAddr` 텍스트 → 카카오 지오코딩의 `region_1depth_name`
- **수도권** = 서울, 인천, 경기. 나머지는 비수도권이야. 판정할 수 없으면 `null`(미분류)로 두고 요약에서 따로 세.
- **시도 표시 이름** 16개: 서울, 부산, 대구, 인천, 전남광주, 대전, 울산, 세종, 경기, 강원, 충북, 충남, 전북, 경북, 경남, 제주

### 2.4 카카오 로컬 API (주소 → 좌표)

- 요청: `GET https://dapi.kakao.com/v2/local/search/address.json?query={주소}`, 헤더 `Authorization: KakaoAK {REST_API_KEY}`
- 응답 `documents[0]`의 필드
  - `x`: 경도(문자열)
  - `y`: 위도(문자열)
  - `address_type`: `REGION`, `ROAD`, `REGION_ADDR`, `ROAD_ADDR` 중 하나
  - `address.region_1depth_name`, `address.region_2depth_name`(지번 주소), `road_address`(도로명 주소)
- 2024-12-01부터는 앱 설정에서 **카카오맵 사용 설정을 켜야** 해. 안 켜면 `App(...) disabled OPEN_MAP_AND_LOCAL service.` 오류가 나. 이 메시지를 받으면 "카카오 개발자 앱 설정에서 카카오맵 사용 설정을 켜야 해"라는 안내 오류로 바꿔서 기록해.
- 무료 쿼터: 주소→좌표 변환이 하루 100,000건이야. 개발자 계정에서 처음 활성화한 앱에만 무료로 줘. 캐시를 쓰면 하루 수백 건 이하라 충분해.
- 지도 SDK는 쓰지 않아. REST API만 서버에서 호출하고, 키는 브라우저로 절대 보내지 마.

### 2.5 지도 라이브러리

- npm **dependencies**로 설치해: `leaflet@1.9.4`, `leaflet.markercluster@1.5.3`
- Express로 직접 제공하고 CDN은 쓰지 마. 발표장 네트워크에서 CDN이 막혀도 동작해야 해.
  - `/vendor/leaflet/` → `node_modules/leaflet/dist/` (`leaflet.js`, `leaflet.css`, `images/`)
  - `/vendor/leaflet.markercluster/` → `node_modules/leaflet.markercluster/dist/` (`leaflet.markercluster.js`, `MarkerCluster.css`, `MarkerCluster.Default.css`)
- 두 스크립트 모두 UMD 방식이야. `leaflet.js`를 먼저 로드해서 `window.L`이 생긴 다음에 markercluster를 로드해.
- **타일**: OpenStreetMap `https://tile.openstreetmap.org/{z}/{x}/{y}.png`
  - 출처 표기 `&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors`는 필수야.
  - OSM 타일 정책상 대량 사용은 안 돼. 졸업작품·데모 규모는 괜찮지만, README에 "정식 서비스로 확장하면 타일 제공자를 바꿔야 해"라고 적어.
- 페이지가 어두운 테마라서 타일 레이어에만 CSS 필터 `invert(1) hue-rotate(180deg) brightness(.9) contrast(.9)`를 적용해. 마커와 팝업에는 적용하지 마.

### 2.6 기존 코드 연결 지점 (aws 브랜치)

- **결과 화면**: `app/main.js`의 `rResult()`가 HTML 문자열을 반환해. 마지막이 `<hr/><button ... id="btn-restart">`야. 그 바로 앞에 새 섹션의 뼈대를 넣어.
- **렌더링**: `render()`가 `APP.innerHTML`을 바꾼 뒤 `bindEvents()`를 불러.
  - 지도는 DOM이 생긴 뒤에 만들어야 해. 그래서 `render()` 끝에 "결과 화면이면 섹션 마운트" 훅을 추가해.
  - 다시 렌더링할 때는 기존 Leaflet 인스턴스를 `map.remove()`로 정리해. 안 하면 "Map container is already initialized" 오류가 나.
- **체험한 직업 코드**: `state.selectedJobs[0]`(예: `K000001080`). 직업은 하나만 선택돼.
- **기존 스타일**: `.rs`(섹션), `.rs-title`(섹션 제목), CSS 변수 `--bg`, `--t1`~`--t4`, `--a`, `--success`, `--warn`, `--dng`, `--b0`
- **E2E 선택자**
  - 직업 카드: `.jc[data-jc="K..."]`
  - 진행 버튼: `#btn-start`, `#btn-pnext`
  - 미션 카드: `.mc`, 미션 시작: `#btn-ml-start`
  - 답변 입력: `#m-ans`(10자 넘게 입력해야 다음으로 진행돼), 제출: `#btn-mnext`
  - 다시 하기: `#btn-restart`
- **관리자 인증**: aws 브랜치의 `requireApiToken`은 `ADMIN_DEMO_UNLOCK=true`이면 그냥 통과시켜. 이번에 만드는 관리자 API는 이 설정과 상관없이 **항상** `ADMIN_PASSWORD`를 요구하는 별도 미들웨어를 써.
- **배포**: Docker 이미지에서는 `data/api_raw/`와 `missions/`가 빠지고(.dockerignore), 실행할 때 볼륨으로 붙어. `reports/`는 쓰기 가능한 볼륨이야. 그래서 이렇게 해.
  - 매핑 파일(`data/postings/occupation_map.json`)은 저장소에 커밋해서 이미지에 들어가게 해.
  - 스냅샷과 지오코딩 캐시는 `reports/postings/` 아래에 저장해.
- **서버 런타임**: `tsx`로 실행되는 ESM TypeScript야(NodeNext, import 경로에 `.js` 확장자 사용).
  - HTTP 호출은 Node 22 내장 `fetch`를 써. 새 HTTP 라이브러리는 추가하지 마.
  - XML 파서로 `fast-xml-parser@^5`만 추가해.
  - `tsconfig.json`의 `include`에 `tests/unit/**/*.ts`를 추가해서 타입 검사에 포함시켜.

## 3. 데이터 설계

### 3.1 `data/postings/occupation_map.json` (커밋)

```json
{
  "schema_version": "occupation_map.v1",
  "updated_at": "2026-10-26",
  "jobs": {
    "K000001080": {
      "job_name": "데이터분석가(빅데이터분석가)",
      "know_keco": "1341 데이터 전문가",
      "mode": "code",
      "work24_codes": [{ "code": "135200", "name": "데이터 분석가(빅데이터 분석가)" }],
      "keyword": null,
      "title_include": [],
      "title_exclude": [],
      "relevance_keywords": ["데이터", "분석", "BI", "빅데이터"],
      "evidence": "고용24 직종표에서 확인(2026-10). KNOW 1341과 고용24 1341xx는 다른 직종이라 쓰지 않음."
    }
  }
}
```

- `mode`
  - `code`: 직종코드로 조회
  - `keyword`: 직종코드를 못 정해서 키워드로 조회
  - `tbd`: 미정이라 수집하지 않음
- `title_include` / `title_exclude`: 제목 기반 추가 필터야(기본은 빈 목록). 필터로 뺀 건수는 스냅샷에 기록해.
- `relevance_keywords`: 품질 지표(제목 키워드 일치율)를 계산할 때만 써. 필터에는 쓰지 마.
- zod 스키마로 검증해.
- 시작할 때는 2.2 표에서 확인된 3개 직업을 채워 넣고, 나머지 2개는 `tbd`로 둬. 그 2개는 4.2로 확정해.

### 3.2 스냅샷 `reports/postings/snapshots/{jobCode}.json`

```json
{
  "schema_version": "job_postings_snapshot.v1",
  "job_code": "K000001080",
  "job_name": "데이터분석가(빅데이터분석가)",
  "fetched_at": "2026-10-26T05:00:00+09:00",
  "source": "고용24 채용정보 Open API",
  "query": { "mode": "code", "occupation": ["135200"], "keyword": null, "regDate": "M-1", "sortOrderBy": "DESC", "pages_fetched": 2 },
  "checks": {
    "occupation_filter_applied": true,
    "regdate_filter_applied": true,
    "company_type_filter_applied": { "01": true, "04": true, "05": true }
  },
  "counts": {
    "api_total": 132, "received": 132, "duplicates_removed": 0, "expired_removed": 9, "title_filtered_out": 0, "kept": 123,
    "geo_address": 101, "geo_region": 15, "geo_none": 7,
    "metro": 92, "nonmetro": 28, "region_unknown": 3,
    "by_sido": { "서울": 70, "경기": 18, "대구": 6 },
    "company_type": { "large": 5, "public": 3, "foreign": 1 },
    "relevance_keyword_hit_rate": 0.87,
    "sido_cross_check": { "compared": 101, "agreed": 99 }
  },
  "items": [],
  "errors": []
}
```

- 직업별 갱신이 실패하면 이전 스냅샷은 그대로 두고, 실패 정보만 상태 파일 `reports/postings/status.json`에 남겨.
- 스냅샷은 임시 파일에 쓴 다음 rename으로 교체해.

### 3.3 항목(item)

```json
{
  "id": "K000000000000001",
  "company": "가상데이터(주)",
  "title": "데이터 분석가 채용",
  "jobs_cd": "135200",
  "sido": "서울", "sigungu": "강남구", "is_metro": true,
  "address": "서울특별시 강남구 가상로 1",
  "lat": 37.5, "lng": 127.03, "geo_precision": "address",
  "reg_date": "2026-09-28",
  "close_date": "2026-10-30", "close_type": "until_filled",
  "salary_text": "연봉 3000만원 ~ 3500만원",
  "company_type": "large",
  "info_svc": "VALIDATION",
  "url": "https://...", "mobile_url": "https://..."
}
```

- `geo_precision`
  - `address`: 도로명이나 지번 주소의 좌표
  - `region`: 시군구 중심 같은 대략 위치
  - `none`: 좌표 없음. 목록에만 표시해
- `close_type`
  - `date`: 마감일이 있음
  - `until_filled`: 채용시까지. 날짜가 있으면 `close_date`도 채워
  - `unknown`: 알 수 없음
- **마감 판정**: 한국 시간 기준 오늘보다 `close_date`가 이르면 제외해. 날짜 없는 `until_filled`는 남겨둬.
- 주소는 `basicAddr`만 보여줘. `detailAddr`(층·호수)는 표시하지 말고 지오코딩에도 쓰지 마.
- `company_type`은 `large` | `public` | `foreign` | `null`이야. 4.1의 coTp 조회로만 정해.

### 3.4 지오코딩 캐시 `reports/postings/geocode-cache.json`

- 키는 정규화한 주소 문자열이야. 값은 성공하면 `{ lat, lng, precision, sido, sigungu, cached_at }`, 실패하면 `{ failed: true, cached_at }`이야.
- 실패 캐시는 7일 뒤에 다시 시도해.
- 좌표가 한국 범위(위도 33~39, 경도 124~132)를 벗어나면 버려.

## 4. 서버 구현 (`src/lib/postings/`)

### 4.1 모듈

- `config.ts`: 환경변수와 기본값(12장)
- `work24Client.ts`: 고용24 목록·상세 호출
  - 파라미터 조립: 빈 값은 빼고, `|`가 들어간 값도 올바르게 인코딩해.
  - UTF-8로 디코딩해.
  - `fast-xml-parser` 설정: `ignoreAttributes: true`, `parseTagValue: false`, `trimValues: true`, `isArray: name => name === "wanted"`
  - `error` 응답을 처리해.
  - 타임아웃은 15초(`AbortSignal.timeout`)야. 네트워크 오류와 5xx만 1회 재시도해.
  - 로그에 남길 때는 키를 가려.
- `parse.ts`: `wanted`를 항목으로 변환해. 날짜(`yy-MM-dd` → `20yy-MM-dd`), `closeDt` 해석, 급여 문자열(`salTpNm` + `sal`)을 처리해.
- `regions.ts`: 2.3의 코드·문자열 정규화와 수도권 판정
- `geocoder.ts`: 카카오 호출, 캐시, `address_type`으로 정밀도 판정, 고정 데이터 모드
  - `ROAD_ADDR`와 `REGION_ADDR`는 `address`, `ROAD`와 `REGION`은 `region`으로 판정해.
  - 주소가 비면 `region` 텍스트(예: "서울 강남구")로 시도하고, 정밀도는 `region`으로 둬.
- `occupationMap.ts`: 매핑 파일 로드와 zod 검증
- `collector.ts`: 직업 하나를 수집해. 순서는 이래.
  1. 기본 조회(`regDate=M-1`, `sortOrderBy=DESC`, `display=100`)를 받은 건수가 `total`에 닿거나 한 페이지가 100건보다 적을 때까지 반복해. 최대 10페이지야.
  2. 같은 조건에 `coTp=01`, `04`, `05`를 각각 붙여 조회하고, `wantedAuthNo` 집합으로 기업형태를 표시해.
  3. `wantedAuthNo` 기준으로 중복을 제거하고, 마감된 공고와 제목 필터에 걸린 공고를 빼.
  4. 지역 판정과 지오코딩을 해.
  5. 4.4 검증과 품질 지표를 계산한 뒤 스냅샷을 저장해.
- `scheduler.ts`: 서버 시작 30초 뒤에 한 번 확인하고, 이후 1시간마다 확인해. 스냅샷이 `POSTINGS_REFRESH_HOURS`보다 오래됐거나 없으면 갱신해.
  - 동시 실행을 막는 잠금을 둬.
  - 서버 시작을 막지 마.
  - 고정 데이터 모드에서는 스케줄러를 끄고 스크립트로만 만들어.
- `store.ts`: 스냅샷 읽기(메모리 캐시 + 파일)와 상태 파일 관리

### 4.2 직종코드 탐색 (`tbd` 직업 확정)

- 스크립트: `npm run postings:discover -- --job K000001179` (`--job`이 없으면 모든 `tbd` 직업)
- 절차
  1. 직업별 후보 키워드로 목록을 조회해(`regDate=M-1`).
     - 투자분석가: `["투자분석", "애널리스트", "신용분석"]`
     - 보험상품개발자: `["보험상품", "상품개발"]`
  2. 응답의 `jobsCd`별 빈도와 대표 제목 5개를 모아.
  3. 빈도 상위 코드마다 `infoSvc=VALIDATION`인 공고 1건의 상세를 불러 직종명(`jobsNm`)을 얻어.
  4. 직종명이 KNOW 직업과 같은 일을 가리키는 코드만 골라 `mode: "code"`로 저장하고, 근거를 `evidence`에 적어. 깔끔한 코드가 없으면 `mode: "keyword"`로 두고 키워드와 제목 필터를 설정해.
  5. 결과를 `docs/postings_occupation_discovery.md`에 표로 남겨: 코드, 직종명, 빈도, 대표 제목, 결정.
- 로컬에 `data/api_raw`가 있으면 해당 직업의 KNOW KECO도 같이 출력해.
- 키가 없으면 이 단계는 건너뛰고 두 직업은 `tbd`로 둬. 화면에는 "이 직업은 공고 연결을 준비 중이야"가 떠.

### 4.3 API

**`GET /api/jobs/:jobCode/postings`**
- `jobCode`는 `^K\d{9}$`로 검증해. zod 계약은 `src/lib/api/contracts.ts`에 추가해.
- 응답 필드
  - `status`: `ok` | `empty` | `stale` | `unmapped` | `unconfigured` | `error`
  - `job_code`, `job_name`, `fetched_at`, `source`
  - `query`: mode, occupation 코드와 이름, keyword, regDate
  - `counts`: 3.2의 counts 중 화면에 필요한 것
  - `checks`
  - `items`: 최대 1,000건
- 외부 API는 절대 호출하지 마. 스냅샷만 읽어.
- `stale`은 마지막 갱신이 실패했지만 이전 스냅샷이 있을 때야. 화면에 기준 시점을 강조해서 보여줘.

**관리자 API** (둘 다 항상 `ADMIN_PASSWORD` 필요)
- `POST /api/admin/postings/refresh` (body: `{ jobCode?: string }`): 즉시 202를 돌려주고 백그라운드로 갱신해.
- `GET /api/admin/postings/status`: 직업별 매핑 모드·코드, 마지막 성공·실패 시각, counts, checks, 오류

**`/health`**: `postings: { enabled, fixture, work24_key_configured, kakao_key_configured, last_success_at, jobs }`를 추가해. 키는 있는지 여부만 boolean으로 넣고 값은 절대 넣지 마.

### 4.4 조건 적용 검증 (중요)

고용24가 일부 조건을 조용히 무시한 사례가 있어. 보낸 조건이 실제로 적용됐는지 응답으로 확인해.

- **직종**: 받은 항목의 95% 이상이 요청한 `jobsCd` 중 하나여야 해. 아니면 `occupation_filter_applied: false`로 기록하고, 요청한 코드에 맞는 항목만 남겨.
- **등록 기간**: `regDt`가 오늘 기준 32일 이내인 비율이 95% 이상이어야 해. 아니면 `regdate_filter_applied: false`로 기록하고, 32일이 넘은 항목은 빼.
- **기업형태**: `coTp` 조회의 `total`이 기본 조회의 `total`과 같고 20건 이상이면 조건이 무시된 걸로 봐. 그 기업형태 표시는 끄고 기록해.
- 결과는 스냅샷의 `checks`와 방법 문서에 남겨.

## 5. 화면 (결과 화면 마지막 섹션)

### 5.1 파일

- `app/components/postingsSection.js`: 뼈대 HTML 생성, 마운트·해제, 데이터 요청, 요약·필터·목록 렌더링
- `app/components/postingsMap.js`: Leaflet 지연 로드(`ensureLeaflet()`는 한 번만 로드하는 Promise), 지도 생성·해제, 마커·클러스터
- `app/api-client/jobsimApi.js`에 `getJobPostings(jobCode)`를 추가해.
- `app/styles/postings.css`를 만들고 `index.html`의 `<head>`에서 불러.

### 5.2 구성 (위에서 아래로)

1. **제목**: "지금 이 일을 뽑는 곳"
2. **한 줄 요약**
   - 기본: "최근 한 달 고용24에 올라온 {직업명} 공고 중 지금 지원할 수 있는 건 {N}건이야. 수도권 {a}건({p}%), 비수도권 {b}건이야."
   - 비수도권이 1건 이상이면 추가: "비수도권에서는 {시도1}({n}건), {시도2}({n}건)에 많아."
   - 기업형태 표시가 켜져 있고 1건 이상이면 추가: "대기업 {x}건 · 공공기관 {y}건 · 외국계 {z}건"
3. **시도별 건수 칩**: 건수가 많은 순으로, 0건은 빼고 표시만 해(클릭 동작 없음).
4. **필터**
   - 지역: 전국 / 수도권 / 비수도권 (기본은 전국)
   - 기업형태: 전체 / 대기업 / 공공기관 / 외국계 (건수가 있는 것만 표시)
   - 필터는 지도와 목록에 함께 적용돼. 필터를 바꾸면 남은 마커에 맞춰 지도 범위를 다시 잡아.
5. **지도**
   - 처음 범위는 남한 전체(`[[33.0, 124.6], [38.7, 131.0]]`)야.
   - `scrollWheelZoom: false`로 둬. 긴 페이지에서 스크롤이 지도에 갇히지 않게 하려는 거야.
   - 마커는 클러스터로 묶어. 같은 좌표(소수 5자리)의 공고는 마커 하나로 묶고 팝업에 목록으로 보여줘.
   - `geo_precision: "region"`은 반투명 원형 마커로 구분하고, 범례에 "정확한 위치 / 구·군 단위 대략 위치"를 표시해.
   - 팝업 내용: 회사명, 공고 제목, 지역, 마감(날짜 또는 "채용시까지"), 기업형태 배지, "공고 보기" 링크
   - 좌표가 있는 항목이 0개면 지도를 그리지 말고 Leaflet도 로드하지 마.
6. **목록**
   - 정렬: 마감 임박순(날짜 있는 것 → 채용시까지 → 미상)
   - 처음 10개를 보여주고 "더 보기"로 10개씩 늘려.
   - 표시 항목: 회사명, 제목, 시도·시군구, 마감, 기업형태 배지, 링크
   - 좌표가 없는 공고도 목록에는 나와.
7. **출처·안내 한 줄**: "출처: 고용24 채용정보 Open API · {fetched_at, 한국 시간} 기준 · 근무지 주소 기준 · 직종 {코드 이름}. 지원 전에 공고 원문을 꼭 확인해."
   - `mode: "keyword"`면 직종 대신 "'{키워드}' 검색 결과"라고 밝혀.

### 5.3 상태별 문구

| 상태 | 문구 |
|---|---|
| 불러오는 중 | 스켈레톤(회색 박스) |
| `empty` | "최근 한 달 동안 이 직종으로 올라온 공고가 없어. 공고는 매일 갱신돼." |
| `stale` | 요약 위에 "공고 갱신이 늦어지고 있어. {fetched_at} 기준이야." |
| `unmapped` | "이 직업은 공고 연결을 준비 중이야." |
| `unconfigured` | "채용공고 연동이 아직 설정되지 않았어." (개발·데모 환경용) |
| `error` 또는 네트워크 실패 | "공고를 불러오지 못했어. 잠시 후 다시 시도해줘." + [다시 시도] 버튼 |

섹션에서 어떤 오류가 나도 결과 화면의 다른 섹션이 깨지면 안 돼. try/catch로 격리해.

### 5.4 보안·접근성·모바일

- 모든 텍스트는 이스케이프해(팝업 HTML 포함).
- 링크는 `http:`와 `https:`만 허용하고 `target="_blank" rel="noopener noreferrer"`를 붙여.
- 지도 컨테이너에 `aria-label`을 붙여. 목록이 지도를 대신할 수 있게 구성해.
- 360px 폭에서 가로 스크롤이 없어야 해. 지도 높이는 모바일 320px, 768px 이상에서 420px이야. 필터 버튼 높이는 40px 이상으로 해.

## 6. 품질 지표와 방법 문서 (타당성 근거)

`docs/JOB_POSTINGS_METHOD.md`를 만들어. 발표와 보고서에 그대로 쓸 수 있게 써줘.

1. **데이터 출처와 조회 조건**: API, regDate, 정렬, 페이지 상한, 갱신 주기
2. **직종 연결**: KNOW KECO와 고용24 직종코드의 버전 차이(1341 사례), 직업별 매핑 표와 근거
3. **지역 판정 규칙**: 우선순위, 코드 정규화, 2026-07-01 전남광주 통합 반영
4. **위치 정확도 구분**: address / region / none
5. **품질 지표**: 직업별 표로 정리해. 갱신할 때마다 자동으로 계산해서 `reports/postings/quality.json`에도 저장해.
   - 공고 수: 받은 수, 중복·마감·필터로 뺀 수, 최종 수
   - 좌표 성공률: 정확 / 대략 / 실패 비율
   - 시도 판정 교차 일치율: 도로명코드로 정한 시도와 카카오 지오코딩 시도가 일치하는 비율
   - 제목 키워드 일치율: `relevance_keywords`가 제목에 들어간 비율. 직종 연결 정확도의 대략적인 지표야
   - 조건 적용 검증 결과(4.4)
6. **사람 검토용 표본**: `npm run postings:sample`로 직업별 무작위 20건(회사, 제목, 직종코드)을 `docs/postings_sample_review.md`에 내보내. 사람이 "관련 있음/없음"을 체크해서 직종 연결 정확도를 직접 잴 수 있게 해. 체크한 결과를 집계하는 방법도 문서에 적어.
7. **한계**
   - 고용24에 등록된 공고만 다뤄. 대기업 자체 채용 사이트 공고는 빠질 수 있어.
   - 한 달 단위 스냅샷이야.
   - 직종 분류에 오차가 있을 수 있어.
   - 기업형태는 고용24 분류 기준이야.

## 7. 관리자 화면

`app/admin.html`, `app/admin.js`에 "채용공고 데이터" 섹션을 추가해.
- 표시 항목: 직업별 매핑 모드와 코드, 마지막 성공·실패 시각, 최종 건수, 좌표 성공률, 수도권/비수도권, 조건 검증 결과, 오류 메시지
- 버튼: [이 직업 갱신], [전체 갱신]

기존 미션 생성 UI는 건드리지 마.

## 8. 함께 고칠 기존 문제 (작게)

- `src/lib/evaluator/evaluateAnswer.ts`: 모델 이름이 `gpt-5`나 `o`로 시작하면 `temperature`를 보내지 마. 다른 모델은 그대로 둬. 휴리스틱으로 폴백할 때는 원인을 `console.warn`으로 남겨.
- `missions/index.json`의 `jobs[].mission_keys` 중복을 제거해.

## 9. 테스트와 검증

### 9.1 고정 데이터 (`tests/fixtures/postings/`)

- 5개 직업의 목록 XML(각 5~15건, 회사명은 전부 가짜), coTp별 XML, 카카오 응답 JSON(주소 → 좌표), 상세 XML 1개를 만들어.
- 꼭 포함할 까다로운 경우
  - `wanted`가 1건(객체)인 응답, `total=0`(wanted 없음)인 응답
  - 앞자리 0 직종코드
  - `closeDt` 세 가지 형식, 이미 마감된 공고
  - 중복 `wantedAuthNo`, 회사명이나 주소가 빈 항목
  - `strtnmCd` 접두 42, 45, 29, 46
  - `region`이 "광주 북구", "전남광주통합특별시 동구", "광주특별시 서구"인 항목
  - `GO24/error` 오류 응답
  - 카카오 `REGION` 타입(대략 위치) 응답과 카카오 실패
- 고정 데이터 모드에서는 고용24와 카카오 대신 고정 데이터를 써. 켜는 방법은 `POSTINGS_FIXTURE=1` 환경변수나 스크립트의 `--fixture` 옵션이야.

### 9.2 단위 테스트

- `node:test`와 `tsx`를 써. 스크립트는 `"test:unit": "tsx --test tests/unit/postings.test.ts tests/unit/regions.test.ts"`처럼 파일을 명시해.
- 테스트 대상
  - XML 파싱: 배열 정규화, 앞자리 0, 오류 응답
  - 날짜와 마감 판정: 한국 시간 기준, 자정 경계 포함
  - 중복 제거
  - 지역 정규화 전체 표와 수도권 판정
  - 제목 필터
  - 기업형태 표시와 "무시된 조건" 감지
  - 지오코딩 캐시 재사용과 실패 캐시
  - 키 마스킹
  - API 상태 결정(ok / empty / stale / unmapped / unconfigured / error)

### 9.3 E2E

- `playwright.postings.config.ts`를 따로 만들어.
  - 포트는 8091이야. `webServer.env`에 `PORT=8091`, `POSTINGS_FIXTURE=1`, `POSTINGS_DATA_DIR=test-results/postings-data`를 넣어.
  - `webServer.command`는 `npm run postings:fixture-snapshots && npm run dev`야. 고정 데이터로 스냅샷을 먼저 만든 뒤 서버를 띄우는 거야.
  - 스크립트 이름은 `test:e2e:postings`로 해.
- 시나리오: 데스크톱과 모바일 뷰포트에서 각각 돌려.
  1. `.jc[data-jc="K000001080"]` → `#btn-start` → `#btn-pnext` → 첫 `.mc` → `#btn-ml-start` → `#m-ans`에 20자 이상 입력 → `#btn-mnext` → 결과 화면까지 진행
  2. "지금 이 일을 뽑는 곳" 제목, 요약 문구의 숫자, `.leaflet-container`, 마커나 클러스터가 보이는지 확인
  3. "비수도권" 필터를 누르면 목록 건수가 고정 데이터 기준 기대값으로 바뀌는지 확인
  4. 링크의 `target`과 `rel` 확인
  5. 모바일에서 `document.documentElement.scrollWidth <= document.documentElement.clientWidth`인지 확인
  6. `#btn-restart`를 누르고 다시 결과까지 가도 지도 오류가 없고 콘솔 에러가 0건인지 확인
- 기존 `npm run test:e2e`(smoke)도 계속 통과해야 해.

### 9.4 그 외

- `npm run typecheck` 통과, 수정한 프론트 JS 파일마다 `node --check` 통과
- 커밋 전에 저장소 전체에서 인증키가 들어간 문자열이 있는지 검색해: `authKey=` 뒤에 실제 값, `KakaoAK ` 뒤에 실제 값
- 키가 있으면 `npm run postings:refresh -- --verbose`를 실제로 돌려. 직업별 counts와 품질 지표를 표로 출력하고 방법 문서에 반영해. 키가 없으면 건너뛰고 보고에 적어.
- TLS 인증서 오류가 나도 `NODE_TLS_REJECT_UNAUTHORIZED=0` 같은 검증 끄기는 금지야. 원인을 보고해.

## 10. Phase 순서

- **Phase 0**: 브랜치를 만들고 명세와 계획을 저장해. 2.6의 파일을 읽어.
- **Phase 1**: `work24Client`, `parse`, `regions`, 고정 데이터, 단위 테스트. 키 없이 끝낼 수 있어.
- **Phase 2**: `occupation_map.json`(확인된 3개 + `tbd` 2개), discover 스크립트. 키가 있으면 탐색까지 실행해.
- **Phase 3**: `geocoder`, `collector`(조건 검증 포함), `store`, `scheduler`, refresh·sample·fixture-snapshots 스크립트, API 3종, `/health`
- **Phase 4**: 화면(섹션, 지도, 필터, 목록, 상태, 스타일, 모바일), vendor 정적 경로
- **Phase 5**: 관리자 섹션, 방법 문서, README와 .env 예시, 8장의 작은 수정
- **Phase 6**: E2E, 최종 점검, (키가 있으면) 실제 수집. 브랜치를 push하고, 가능하면 `aws`를 대상으로 PR을 열어.

## 11. 하지 말 것

- 고용24 화면을 크롤링하거나 다른 채용 사이트(사람인, 잡코리아 등)에서 수집하기
- 사용자 요청마다 외부 API 호출하기
- 회사(본사) 주소로 근무지를 대신하거나 `detailAddr` 쓰기
- 응답에 없는 정보를 추정하기(기업형태 추정, 좌표 임의 생성 등). 가짜 값은 고정 데이터 모드에서만 허용해.
- 인증키를 코드, 로그, 커밋, 스냅샷, 브라우저 응답에 남기기
- 기존 결과 섹션이나 관리자 미션 생성 기능 바꾸기(8장은 예외)
- 새 프론트엔드 프레임워크나 번들러 들여오기

## 12. 환경변수

| 이름 | 기본값 | 설명 |
|---|---|---|
| `WORK24_RECRUIT_AUTH_KEY` | (없음) | 고용24 "채용정보" 서비스 인증키 |
| `KAKAO_REST_API_KEY` | (없음) | 카카오 REST API 키(카카오맵 사용 설정이 켜져 있어야 해) |
| `POSTINGS_ENABLED` | `true` | 기능 전체 켜기/끄기 |
| `POSTINGS_FIXTURE` | `0` | 1이면 고정 데이터 모드 |
| `POSTINGS_DATA_DIR` | `reports/postings` | 스냅샷과 캐시 위치 |
| `POSTINGS_REG_DATE` | `M-1` | 고용24 regDate |
| `POSTINGS_MAX_PAGES` | `10` | 직업당 최대 페이지(페이지당 100건) |
| `POSTINGS_REFRESH_HOURS` | `24` | 갱신 주기 |

`.env.example`과 `.env.server.example`에 값 없이 추가해.

## 13. 마지막 보고 (한국어로, 사람한테)

1. 바뀐 것 요약과 파일 목록
2. 키를 발급받은 뒤 넣을 곳, 그리고 갱신·탐색·표본 스크립트 실행 방법
3. 직업별 결과 표(최종 건수, 좌표 성공률, 수도권/비수도권, 키워드 일치율, 조건 검증). 키가 없으면 비어 있다는 사실을 적어.
4. 투자분석가와 보험상품개발자의 직종코드 결정과 근거. 정하지 못했으면 미정 상태라고 적어.
5. 사람이 확인하면 좋은 것(표본 검토 문서 등)과 남은 이슈
