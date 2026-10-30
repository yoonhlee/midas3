/* 직업별 대표 이미지(U08): 대분류 10개 + 체험 직무 6개. 외부 이미지 없이 직접 그린 SVG라 이용 조건 문제가 없다. */

const BG = "#161718";
const LINE = "#7170ff";
const SOFT = "rgba(113,112,255,.22)";

// 그림 본문(viewBox 0 0 120 80)
const FIELD_ART = {
  "연구직 및 공학 기술직": `<path d="M48 20h14M52 20v18l-12 22a4 4 0 0 0 4 6h22a4 4 0 0 0 4-6L58 38V20" fill="${SOFT}" stroke="${LINE}" stroke-width="2.5" stroke-linejoin="round"/><circle cx="84" cy="30" r="9" fill="none" stroke="${LINE}" stroke-width="2.5"/><path d="M84 17v4M84 39v4M71 30h4M93 30h4" stroke="${LINE}" stroke-width="2.5" stroke-linecap="round"/>`,
  "설치·정비·생산직": `<path d="M40 60l26-26a12 12 0 1 1 8 8L48 68z" fill="${SOFT}" stroke="${LINE}" stroke-width="2.5" stroke-linejoin="round"/><circle cx="80" cy="28" r="4" fill="${LINE}"/>`,
  "경영·사무·금융·보험직": `<rect x="36" y="30" width="48" height="32" rx="4" fill="${SOFT}" stroke="${LINE}" stroke-width="2.5"/><path d="M50 30v-6h20v6M36 44h48" stroke="${LINE}" stroke-width="2.5"/>`,
  "예술·디자인·방송·스포츠직": `<path d="M60 16a24 22 0 1 0 6 43c4-1 3-6 0-8-3-3 0-8 5-7 9 1 14-4 14-10 0-11-11-18-25-18z" fill="${SOFT}" stroke="${LINE}" stroke-width="2.5"/><circle cx="50" cy="32" r="3" fill="${LINE}"/><circle cx="62" cy="26" r="3" fill="${LINE}"/><circle cx="74" cy="32" r="3" fill="${LINE}"/>`,
  "미용·여행·숙박·음식·경비·청소직": `<path d="M34 46l52-16-6 10-14 4 4 16-6 2-8-14-12 4-4 6-4 1 2-9z" fill="${SOFT}" stroke="${LINE}" stroke-width="2.5" stroke-linejoin="round"/>`,
  "보건·의료직": `<path d="M52 18h16v16h16v16H68v16H52V50H36V34h16z" fill="${SOFT}" stroke="${LINE}" stroke-width="2.5" stroke-linejoin="round"/>`,
  "영업·판매·운전·운송직": `<path d="M28 30h40v26H28zM68 38h14l10 10v8H68z" fill="${SOFT}" stroke="${LINE}" stroke-width="2.5" stroke-linejoin="round"/><circle cx="40" cy="60" r="5" fill="${BG}" stroke="${LINE}" stroke-width="2.5"/><circle cx="80" cy="60" r="5" fill="${BG}" stroke="${LINE}" stroke-width="2.5"/>`,
  "교육·법률·사회복지·경찰·소방직 및 군인": `<path d="M30 24c10-4 20-4 30 2 10-6 20-6 30-2v38c-10-4-20-4-30 2-10-6-20-6-30-2z" fill="${SOFT}" stroke="${LINE}" stroke-width="2.5" stroke-linejoin="round"/><path d="M60 26v38" stroke="${LINE}" stroke-width="2.5"/>`,
  "건설·채굴직": `<path d="M34 54a26 22 0 0 1 52 0z" fill="${SOFT}" stroke="${LINE}" stroke-width="2.5"/><path d="M30 58h60M56 32v-6h8v6" stroke="${LINE}" stroke-width="2.5" stroke-linecap="round"/>`,
  "농림어업직": `<path d="M60 66V36M60 46c-14 0-22-8-22-22 14 0 22 8 22 22zM60 40c12 0 20-7 20-19-12 0-20 7-20 19z" fill="${SOFT}" stroke="${LINE}" stroke-width="2.5" stroke-linejoin="round"/>`
};

const JOB_ART = {
  // 광고·홍보·마케팅전문가: 확성기
  K000000872: `<path d="M34 36h10l30-14v36L44 44H34z" fill="${SOFT}" stroke="${LINE}" stroke-width="2.5" stroke-linejoin="round"/><path d="M44 44l4 14h8l-3-12M82 32c4 2 4 10 0 12M88 26c8 5 8 19 0 24" stroke="${LINE}" stroke-width="2.5" stroke-linecap="round" fill="none"/>`,
  // 상품기획자: 꼬리표 달린 상자
  K000000997: `<path d="M34 34l26-10 26 10v24L60 68 34 58z" fill="${SOFT}" stroke="${LINE}" stroke-width="2.5" stroke-linejoin="round"/><path d="M34 34l26 10 26-10M60 44v24" stroke="${LINE}" stroke-width="2.5"/><circle cx="84" cy="22" r="6" fill="${BG}" stroke="${LINE}" stroke-width="2.5"/>`,
  // 데이터분석가: 막대 그래프와 돋보기
  K000001080: `<path d="M30 62h48" stroke="${LINE}" stroke-width="2.5" stroke-linecap="round"/><rect x="34" y="44" width="8" height="18" fill="${SOFT}" stroke="${LINE}" stroke-width="2"/><rect x="48" y="34" width="8" height="28" fill="${SOFT}" stroke="${LINE}" stroke-width="2"/><rect x="62" y="24" width="8" height="38" fill="${SOFT}" stroke="${LINE}" stroke-width="2"/><circle cx="84" cy="36" r="9" fill="${BG}" stroke="${LINE}" stroke-width="2.5"/><path d="M91 43l7 7" stroke="${LINE}" stroke-width="3" stroke-linecap="round"/>`,
  // 투자분석가: 오르는 선과 동전
  K000001179: `<path d="M28 58l16-14 12 8 22-24" fill="none" stroke="${LINE}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M70 28h8v8" fill="none" stroke="${LINE}" stroke-width="2.5" stroke-linecap="round"/><circle cx="88" cy="54" r="10" fill="${SOFT}" stroke="${LINE}" stroke-width="2.5"/><path d="M88 49v10" stroke="${LINE}" stroke-width="2.5" stroke-linecap="round"/>`,
  // 인사·교육·훈련사무원: 두 사람과 연결선
  K000001196: `<circle cx="44" cy="30" r="9" fill="${SOFT}" stroke="${LINE}" stroke-width="2.5"/><circle cx="76" cy="30" r="9" fill="${SOFT}" stroke="${LINE}" stroke-width="2.5"/><path d="M28 62c0-9 7-15 16-15s16 6 16 15M60 62c0-9 7-15 16-15s16 6 16 15" fill="none" stroke="${LINE}" stroke-width="2.5" stroke-linecap="round"/><path d="M53 30h14" stroke="${LINE}" stroke-width="2.5" stroke-dasharray="3 3"/>`,
  // 보험상품개발자: 방패
  K000007519: `<path d="M60 16l24 8v16c0 14-10 24-24 28-14-4-24-14-24-28V24z" fill="${SOFT}" stroke="${LINE}" stroke-width="2.5" stroke-linejoin="round"/><path d="M50 42l7 7 14-14" fill="none" stroke="${LINE}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>`
};

const FALLBACK = `<circle cx="60" cy="40" r="18" fill="${SOFT}" stroke="${LINE}" stroke-width="2.5"/>`;

export function jobImage(job, { height = 72, label = false } = {}) {
  const art = JOB_ART[job?.code] || FIELD_ART[job?.lrcl] || FALLBACK;
  const width = Math.round(height * 1.5);
  const aria = label ? `role="img" aria-label="${String(job?.lrcl || "직업").replace(/"/g, "")} 그림"` : `aria-hidden="true"`;
  return `<svg class="job-img" ${aria} width="${width}" height="${height}" viewBox="0 0 120 80"><rect width="120" height="80" rx="10" fill="${BG}"/>${art}</svg>`;
}

export const FIELD_NAMES = Object.keys(FIELD_ART);
