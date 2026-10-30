import { createHash } from "node:crypto";
import { AXES, type Evaluation } from "./schema.js";

// 가짜 채점(EVAL_MODE=fake): OpenAI 없이 테스트·시연할 때 쓴다.
// 같은 답변이면 언제나 같은 점수가 나오고, 답변 문장을 근거로 인용해서 근거 강조 화면도 확인할 수 있다.
export const FAKE_PROMPT_VERSION = "fake-eval-v1";

const MARKERS: Record<(typeof AXES)[number], string[]> = {
  AX1: ["데이터", "수치", "비율", "비교", "분석", "지표", "%", "평균", "추이", "근거", "차트", "표"],
  AX2: ["확인", "관찰", "점검", "파악", "발견", "이상", "패턴", "변화", "추적", "검토"],
  AX3: ["우선", "먼저", "전략", "판단", "결정", "선택", "제안", "계획", "목표", "가설"],
  AX4: ["팀", "공유", "보고", "역할", "협업", "부서", "조율", "리더", "회의"],
  AX5: ["고객", "사용자", "공감", "소통", "배려", "응대", "불만", "만족", "안내"]
};

export function splitSentences(text: string) {
  return String(text ?? "")
    .split(/(?<=[.!?。])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= 4);
}

function hashUnit(text: string) {
  const digest = createHash("sha256").update(text).digest();
  return digest[0] / 255;
}

export function fakeEvaluation(
  mission: { mission_id: string; axis_signals?: Partial<Record<(typeof AXES)[number], number>> },
  answer: string
): Evaluation {
  const sentences = splitSentences(answer);
  const length = answer.replace(/\s+/g, "").length;
  const lengthBonus = length >= 200 ? 1 : length >= 90 ? 0.5 : 0;
  const axes = Object.fromEntries(AXES.map((axis) => {
    const signal = Number(mission.axis_signals?.[axis] ?? 0);
    const matched = sentences.filter((sentence) => MARKERS[axis].some((marker) => sentence.includes(marker)));
    const raw = matched.length * 0.9 + signal * 2 + lengthBonus + hashUnit(`${axis}:${answer}`) * 0.6;
    const score = Math.max(0, Math.min(4, Math.round(raw)));
    const evidence = score > 0
      ? matched.slice(0, 2).map((quote) => ({
          quote,
          behavior: "가짜 채점: 이 축의 표시어가 들어간 문장",
          level: Math.max(1, Math.min(4, score)),
          primary_axis: axis,
          secondary_axes: [],
          rationale: "가짜 채점 모드라 실제 판단이 아니야."
        }))
      : [];
    return [axis, {
      score,
      confidence: score ? 0.5 : 0.1,
      evidence,
      reason: `가짜 채점 모드: 표시어 문장 ${matched.length}개, 미션 신호 ${signal.toFixed(2)}`
    }];
  })) as unknown as Evaluation["axes"];
  return {
    mission_id: mission.mission_id,
    axes,
    flags: ["low_confidence"],
    source: "fake",
    prompt_version: FAKE_PROMPT_VERSION
  };
}
