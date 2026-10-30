// 공고 요구역량(U25): 공고 제목·직무내용 문장을 5개 역량 축(AX1~AX5)으로 나눠 센다.
// 사전(키워드) 방식이라 대략적인 비중이다. 원문은 저장하지 않고 집계만 남긴다.

export const REQUIREMENT_AXES = ["AX1", "AX2", "AX3", "AX4", "AX5"] as const;
export type RequirementAxis = (typeof REQUIREMENT_AXES)[number];

// 소문자로 비교한다. 너무 흔한 단어(업무, 담당 등)는 넣지 않는다.
export const AXIS_KEYWORDS: Record<RequirementAxis, string[]> = {
  AX1: ["분석", "데이터", "통계", "수치", "지표", "sql", "python", "파이썬", "엑셀", "excel", "모델링", "예측", "리서치", "정량", "bi", "대시보드", "재무", "회계", "계산", "가설", "검증", "산출", "보고서"],
  AX2: ["조사", "관찰", "모니터링", "탐색", "점검", "현장", "품질", "이상 징후", "발굴", "트렌드", "시장조사", "실사", "검수", "수집", "리스크 파악"],
  AX3: ["기획", "전략", "의사결정", "우선순위", "수립", "계획", "제안", "컨설팅", "사업", "설계", "포트폴리오", "투자", "상품", "개선안", "로드맵", "예산"],
  AX4: ["관리", "리더", "팀장", "조율", "협업", "프로젝트", "pm", "총괄", "조직", "일정", "매니저", "협의", "부서 간", "운영 관리", "교육 운영"],
  AX5: ["고객", "상담", "응대", "서비스", "영업", "소통", "cs", "민원", "마케팅", "홍보", "파트너", "강의", "코칭", "커뮤니케이션", "네트워킹"]
};

export interface RequirementSummary {
  generated_from: "title" | "title+detail";
  analyzed_postings: number;
  detail_postings: number;
  analyzed_sentences: number;
  matched_sentences: number;
  axes: Record<RequirementAxis, { count: number; share: number; keywords: string[] }>;
}

// 문장 단위로 나눈다(줄바꿈, 마침표, 글머리표, 가운뎃점·쉼표로 이어진 나열)
export function splitRequirementSentences(text: string): string[] {
  return String(text ?? "")
    .split(/\r?\n|[.!?。]\s+|[•·▶■□○●\-–]\s|\s{2,}|[,/]/)
    .map((sentence) => sentence.replace(/^[\s\d)(.\]\[:-]+/, "").trim())
    .filter((sentence) => sentence.length >= 2);
}

export function axesOfSentence(sentence: string): Array<{ axis: RequirementAxis; keyword: string }> {
  const lower = sentence.toLowerCase();
  const hits: Array<{ axis: RequirementAxis; keyword: string }> = [];
  for (const axis of REQUIREMENT_AXES) {
    const keyword = AXIS_KEYWORDS[axis].find((word) => lower.includes(word));
    if (keyword) hits.push({ axis, keyword });
  }
  return hits;
}

export function analyzeRequirementTexts(
  postings: Array<{ title: string; detail?: string | null }>
): RequirementSummary {
  const counts = Object.fromEntries(REQUIREMENT_AXES.map((axis) => [axis, 0])) as Record<RequirementAxis, number>;
  const keywordCounts = Object.fromEntries(REQUIREMENT_AXES.map((axis) => [axis, new Map<string, number>()])) as Record<RequirementAxis, Map<string, number>>;
  let analyzed = 0;
  let matched = 0;
  let detailPostings = 0;
  for (const posting of postings) {
    const sentences = [...splitRequirementSentences(posting.title)];
    if (posting.detail && posting.detail.trim()) {
      detailPostings += 1;
      sentences.push(...splitRequirementSentences(posting.detail));
    }
    for (const sentence of sentences) {
      analyzed += 1;
      const hits = axesOfSentence(sentence);
      if (hits.length) matched += 1;
      for (const { axis, keyword } of hits) {
        counts[axis] += 1;
        keywordCounts[axis].set(keyword, (keywordCounts[axis].get(keyword) ?? 0) + 1);
      }
    }
  }
  const total = REQUIREMENT_AXES.reduce((sum, axis) => sum + counts[axis], 0);
  const axes = Object.fromEntries(REQUIREMENT_AXES.map((axis) => [axis, {
    count: counts[axis],
    share: total ? Math.round((counts[axis] / total) * 1000) / 1000 : 0,
    keywords: [...keywordCounts[axis].entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([word]) => word)
  }])) as RequirementSummary["axes"];
  return {
    generated_from: detailPostings ? "title+detail" : "title",
    analyzed_postings: postings.length,
    detail_postings: detailPostings,
    analyzed_sentences: analyzed,
    matched_sentences: matched,
    axes
  };
}
