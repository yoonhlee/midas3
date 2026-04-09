"""LLM 기반 피드백 생성 모듈.

핵심 원칙:
- 자유 생성이 아닌 평가 기준표 기반 설명형 피드백
- 점수 + 평가 이유 + 개선 방향을 반드시 함께 포함
"""
import json
from typing import Any, Dict, List

import structlog

logger = structlog.get_logger(__name__)

PER_QUESTION_PROMPT = """\
당신은 전문 면접 코치입니다. 아래 데이터를 기반으로 면접 답변 피드백을 작성하세요.

[면접 질문]
{question}

[답변 전사문]
{transcript}

[평가 점수]
- 논리성: {logic_score}점
- 구체성: {specificity_score}점
- 직무적합성: {job_relevance_score}점
- 구조(STAR): {structure_score}점
- 전달력: {delivery_score}점

[탐지된 문제점]
- 추임새 횟수: {filler_count}회 (비율: {filler_ratio})
- 반복 표현 수: {repetition_count}개
- 자기 수정 횟수: {self_correction_count}회
- 발화 속도: {speech_rate} 어절/초
- pause 비율: {pause_ratio}

[지시사항]
각 평가 항목에 대해 아래 JSON 형식으로만 응답하세요:
{{
    "logic_feedback": "논리성 피드백 (현재 수준 + 문제점 + 개선 방향, 2~3문장)",
    "specificity_feedback": "구체성 피드백",
    "job_relevance_feedback": "직무적합성 피드백",
    "structure_feedback": "STAR 구조 피드백",
    "delivery_feedback": "전달력 피드백"
}}
"""

OVERALL_PROMPT = """\
당신은 전문 면접 코치입니다. 아래 면접 전체 데이터를 기반으로 종합 피드백을 작성하세요.

[종합 점수]
{scores_summary}

[전체 분석 요약]
{analysis_summary}

[시계열 긴장도 인사이트]
{timeseries_summary}

[지시사항]
아래 JSON 형식으로만 응답하세요:
{{
    "overall_feedback": "2~3문장 종합 평가",
    "strength_points": ["강점1", "강점2", "강점3"],
    "improvement_suggestions": ["개선사항1", "개선사항2", "개선사항3"],
    "timeseries_insight": "긴장도 변화 패턴 분석 1~2문장"
}}
"""


class FeedbackGenerator:
    """LLM 기반 피드백 생성기."""

    def _call_llm(self, prompt: str) -> str:
        import os
        provider = os.environ.get("LLM_PROVIDER", "openai")
        model = os.environ.get("OPENAI_MODEL", "gpt-4o")

        if provider == "anthropic":
            import anthropic
            client = anthropic.Anthropic(api_key=os.environ.get("ANTHROPIC_API_KEY"))
            response = client.messages.create(
                model="claude-sonnet-4-6",
                max_tokens=2048,
                messages=[{"role": "user", "content": prompt}],
            )
            return response.content[0].text
        else:
            import openai
            client = openai.OpenAI(api_key=os.environ.get("OPENAI_API_KEY"))
            response = client.chat.completions.create(
                model=model,
                messages=[{"role": "user", "content": prompt}],
                temperature=0.3,
                response_format={"type": "json_object"},
            )
            return response.choices[0].message.content

    def generate_per_question(
        self,
        question: str,
        answer_text: str,
        scores: Dict[str, Any],
        analysis: Dict[str, Any],
    ) -> Dict[str, str]:
        """문항별 피드백 생성."""
        filler_data = analysis.get("filler_words", {})
        audio_delivery = analysis.get("audio_delivery", {})
        repetition_data = analysis.get("repetition_details", {})

        prompt = PER_QUESTION_PROMPT.format(
            question=question,
            transcript=answer_text[:500],
            logic_score=scores.get("logic", {}).get("score", "N/A"),
            specificity_score=scores.get("specificity", {}).get("score", "N/A"),
            job_relevance_score=scores.get("job_relevance", {}).get("score", "N/A"),
            structure_score=scores.get("structure", {}).get("score", "N/A"),
            delivery_score=scores.get("delivery", {}).get("score", "N/A"),
            filler_count=filler_data.get("total", 0),
            filler_ratio=f"{filler_data.get('ratio', 0):.1%}",
            repetition_count=len(repetition_data.get("details", [])),
            self_correction_count=analysis.get("self_correction_count", 0),
            speech_rate=audio_delivery.get("speech_rate_wps", "N/A"),
            pause_ratio=f"{audio_delivery.get('pause_ratio', 0):.1%}",
        )

        try:
            raw = self._call_llm(prompt)
            result = json.loads(raw)
            return {
                "logic_feedback": result.get("logic_feedback", ""),
                "specificity_feedback": result.get("specificity_feedback", ""),
                "job_relevance_feedback": result.get("job_relevance_feedback", ""),
                "structure_feedback": result.get("structure_feedback", ""),
                "delivery_feedback": result.get("delivery_feedback", ""),
            }
        except Exception as e:
            logger.error("Per-question feedback generation failed", error=str(e))
            return self._fallback_per_question_feedback(scores)

    def generate_overall(
        self,
        session_scores: List[Dict[str, Any]],
        session_analyses: List[Dict[str, Any]],
        timeseries_data: List[Dict[str, Any]],
    ) -> Dict[str, Any]:
        """종합 피드백 생성."""
        # 평균 점수 계산
        if session_scores:
            avg_scores = {
                "logic": sum(s.get("logic", {}).get("score", 0) for s in session_scores) / len(session_scores),
                "specificity": sum(s.get("specificity", {}).get("score", 0) for s in session_scores) / len(session_scores),
                "job_relevance": sum(s.get("job_relevance", {}).get("score", 0) for s in session_scores) / len(session_scores),
                "structure": sum(s.get("structure", {}).get("score", 0) for s in session_scores) / len(session_scores),
                "delivery": sum(s.get("delivery", {}).get("score", 0) for s in session_scores) / len(session_scores),
            }
        else:
            avg_scores = {k: 0 for k in ["logic", "specificity", "job_relevance", "structure", "delivery"]}

        scores_summary = "\n".join(f"- {k}: {v:.1f}점" for k, v in avg_scores.items())

        # 분석 요약
        total_fillers = sum(a.get("filler_words", {}).get("total", 0) for a in session_analyses)
        avg_speech_rate = sum(
            a.get("audio_delivery", {}).get("speech_rate_wps", 0) for a in session_analyses
        ) / max(len(session_analyses), 1)
        analysis_summary = f"총 추임새: {total_fillers}회, 평균 발화속도: {avg_speech_rate:.1f} 어절/초"

        # 긴장도 요약
        if timeseries_data:
            max_tension = max(t.get("tension_index", 0) for t in timeseries_data)
            max_tension_time = next(
                (t["time_sec"] for t in timeseries_data if t.get("tension_index") == max_tension), 0
            )
            timeseries_summary = f"최고 긴장도 {max_tension:.2f}가 {max_tension_time:.0f}초 시점에 발생"
        else:
            timeseries_summary = "시계열 데이터 없음"

        prompt = OVERALL_PROMPT.format(
            scores_summary=scores_summary,
            analysis_summary=analysis_summary,
            timeseries_summary=timeseries_summary,
        )

        try:
            raw = self._call_llm(prompt)
            result = json.loads(raw)
            return {
                "overall_feedback": result.get("overall_feedback", ""),
                "strength_points": result.get("strength_points", []),
                "improvement_suggestions": result.get("improvement_suggestions", []),
                "timeseries_insight": result.get("timeseries_insight", ""),
            }
        except Exception as e:
            logger.error("Overall feedback generation failed", error=str(e))
            return self._fallback_overall_feedback()

    def _fallback_per_question_feedback(self, scores: Dict[str, Any]) -> Dict[str, str]:
        return {
            "logic_feedback": "논리적 구성이 양호합니다. 결론을 먼저 제시하는 습관을 들이면 더 좋습니다.",
            "specificity_feedback": "구체적인 수치와 기간을 포함하면 더 설득력 있는 답변이 됩니다.",
            "job_relevance_feedback": "직무 관련 경험을 더 명확하게 연결하면 좋겠습니다.",
            "structure_feedback": "STAR 구조를 활용하여 답변을 체계적으로 구성해보세요.",
            "delivery_feedback": "발화 속도와 명확한 발음에 주의하면 전달력이 향상됩니다.",
        }

    def _fallback_overall_feedback(self) -> Dict[str, Any]:
        return {
            "overall_feedback": "전반적으로 무난한 면접 답변이었습니다. 구체적인 수치와 경험을 더 활용하면 좋겠습니다.",
            "strength_points": ["질문 의도를 파악하는 능력", "논리적 구성"],
            "improvement_suggestions": ["구체적 수치 사용 증가", "추임새 감소", "STAR 구조 활용"],
            "timeseries_insight": "면접 전반적으로 안정적인 긴장도를 유지했습니다.",
        }


feedback_generator = FeedbackGenerator()
