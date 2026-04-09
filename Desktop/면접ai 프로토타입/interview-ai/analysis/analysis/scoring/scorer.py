"""규칙 기반 점수 산출 엔진.

핵심 원칙:
- LLM은 "판단/분류"만 수행 (0~1 스케일 반환)
- 점수 계산은 반드시 이 파일의 규칙 기반 함수가 담당
- 같은 입력 → 같은 결과 보장
"""
from typing import Any, Dict, List, Optional

import structlog

from analysis.scoring.rubric import (
    AUDIO_DELIVERY_WEIGHTS,
    DELIVERY_WEIGHTS,
    EVALUATION_WEIGHTS,
    JOB_RELEVANCE_WEIGHTS,
    LOGIC_WEIGHTS,
    SPECIFICITY_WEIGHTS,
    STRUCTURE_WEIGHTS,
    TEXT_DELIVERY_WEIGHTS,
)

logger = structlog.get_logger(__name__)


def _clamp(value: float, lo: float = 0.0, hi: float = 100.0) -> float:
    return max(lo, min(hi, value))


class InterviewScorer:
    """5대 평가 항목 점수 산출 엔진."""

    # -------------------------
    # ① 논리성
    # -------------------------
    def score_logic(
        self,
        llm_relevance: float,          # LLM 판단: 질문-답변 적합성 (0~1)
        llm_conclusion_first: bool,    # LLM 판단: 결론 선행 여부
        llm_flow_score: float,         # LLM 판단: 흐름 자연스러움 (0~1)
        connector_count: int = 0,      # 논리 연결 표현 횟수
    ) -> Dict[str, Any]:
        relevance_score = _clamp(llm_relevance * 100)
        conclusion_score = 100.0 if llm_conclusion_first else 30.0
        flow_score = _clamp(llm_flow_score * 60 + min(connector_count * 5, 40))

        total = (
            relevance_score * LOGIC_WEIGHTS["relevance"]
            + conclusion_score * LOGIC_WEIGHTS["conclusion_first"]
            + flow_score * LOGIC_WEIGHTS["flow"]
        )
        return {
            "score": round(_clamp(total), 2),
            "details": {
                "relevance_score": round(relevance_score, 2),
                "conclusion_score": round(conclusion_score, 2),
                "flow_score": round(flow_score, 2),
            },
        }

    # -------------------------
    # ② 구체성
    # -------------------------
    def score_specificity(
        self,
        llm_experience_based: float,   # LLM 판단: 경험 기반 여부 (0~1)
        number_count: int,             # 수치 표현 개수
        abstract_ratio: float,         # 추상 표현 비율 (낮을수록 좋음, 0~1)
    ) -> Dict[str, Any]:
        experience_score = _clamp(llm_experience_based * 100)

        # 수치 표현: 3개 이상 100점, 1개당 25점 가산
        number_score = _clamp(min(number_count, 4) * 25.0)

        # 추상 표현: 비율이 낮을수록 고득점
        abstract_score = _clamp((1.0 - abstract_ratio) * 100)

        total = (
            experience_score * SPECIFICITY_WEIGHTS["experience_based"]
            + number_score * SPECIFICITY_WEIGHTS["numbers"]
            + abstract_score * SPECIFICITY_WEIGHTS["abstract_ratio"]
        )
        return {
            "score": round(_clamp(total), 2),
            "details": {
                "experience_score": round(experience_score, 2),
                "number_score": round(number_score, 2),
                "abstract_score": round(abstract_score, 2),
            },
        }

    # -------------------------
    # ③ 직무 적합성
    # -------------------------
    def score_job_relevance(
        self,
        llm_relevance: float,           # LLM 판단: 직무 관련 경험 (0~1)
        keyword_match_count: int,       # 직무 키워드 매칭 수
        total_keywords: int,            # 전체 직무 키워드 수
        llm_competency_connection: float,  # LLM 판단: 역량 연결성 (0~1)
    ) -> Dict[str, Any]:
        job_experience_score = _clamp(llm_relevance * 100)

        keyword_ratio = keyword_match_count / max(total_keywords, 1)
        keyword_score = _clamp(keyword_ratio * 100)

        competency_score = _clamp(llm_competency_connection * 100)

        total = (
            job_experience_score * JOB_RELEVANCE_WEIGHTS["job_experience"]
            + keyword_score * JOB_RELEVANCE_WEIGHTS["keyword_match"]
            + competency_score * JOB_RELEVANCE_WEIGHTS["competency_link"]
        )
        return {
            "score": round(_clamp(total), 2),
            "details": {
                "job_experience_score": round(job_experience_score, 2),
                "keyword_score": round(keyword_score, 2),
                "competency_score": round(competency_score, 2),
            },
        }

    # -------------------------
    # ④ 구조 완성도 (STAR)
    # -------------------------
    def score_structure(self, star_result: Dict[str, Any]) -> Dict[str, Any]:
        # 각 STAR 요소 포함 여부 (각 12.5점)
        element_score = (
            (25.0 if star_result.get("has_situation") else 0.0)
            + (25.0 if star_result.get("has_task") else 0.0)
            + (25.0 if star_result.get("has_action") else 0.0)
            + (25.0 if star_result.get("has_result") else 0.0)
        )
        order_score = 100.0 if star_result.get("order_appropriate") else 40.0
        connection_score = _clamp(star_result.get("causal_connection", 0.0) * 100)

        total = (
            element_score * STRUCTURE_WEIGHTS["elements"]
            + order_score * STRUCTURE_WEIGHTS["order"]
            + connection_score * STRUCTURE_WEIGHTS["connection"]
        )
        return {
            "score": round(_clamp(total), 2),
            "details": {
                "element_score": round(element_score, 2),
                "order_score": round(order_score, 2),
                "connection_score": round(connection_score, 2),
            },
        }

    # -------------------------
    # ⑤ 전달력 (텍스트 50% + 음성 50%)
    # -------------------------
    def score_delivery(
        self,
        text_metrics: Dict[str, Any],      # 텍스트 분석 결과
        audio_delivery: Dict[str, Any],    # 음성 전달력 지표
        filler_data: Dict[str, Any],
        repetition_data: Dict[str, Any],
    ) -> Dict[str, Any]:
        # 텍스트 전달력
        avg_sent_len = text_metrics.get("avg_sentence_length", 20)
        if 15 <= avg_sent_len <= 25:
            conciseness_score = 100.0
        elif avg_sent_len < 15:
            conciseness_score = max(0.0, (avg_sent_len / 15) * 100)
        else:
            conciseness_score = max(0.0, 100.0 - (avg_sent_len - 25) * 4)

        repetition_score = repetition_data.get("score", 80.0)

        text_delivery_score = (
            conciseness_score * TEXT_DELIVERY_WEIGHTS["sentence_conciseness"]
            + repetition_score * TEXT_DELIVERY_WEIGHTS["repetition"]
        )

        # 음성 전달력
        audio_delivery_score = audio_delivery.get("audio_delivery_score", 70.0)

        total = (
            text_delivery_score * DELIVERY_WEIGHTS["text"]
            + audio_delivery_score * DELIVERY_WEIGHTS["audio"]
        )
        return {
            "score": round(_clamp(total), 2),
            "details": {
                "text_delivery_score": round(text_delivery_score, 2),
                "audio_delivery_score": round(audio_delivery_score, 2),
                "conciseness_score": round(conciseness_score, 2),
                "repetition_score": round(repetition_score, 2),
            },
        }

    # -------------------------
    # 가중 합산 총점
    # -------------------------
    def calculate_weighted_total(self, scores: Dict[str, float]) -> float:
        """5개 항목 점수를 가중치 합산하여 총점 산출."""
        total = sum(
            scores.get(key, 0.0) * weight
            for key, weight in EVALUATION_WEIGHTS.items()
        )
        return round(_clamp(total), 2)

    def score_all(
        self,
        llm_scores: Dict[str, Any],
        text_metrics: Dict[str, Any],
        audio_delivery: Dict[str, Any],
        filler_data: Dict[str, Any],
        repetition_data: Dict[str, Any],
        star_result: Dict[str, Any],
        keyword_match_count: int = 0,
        total_keywords: int = 1,
    ) -> Dict[str, Any]:
        """전체 점수 한번에 산출."""
        logic = self.score_logic(
            llm_relevance=llm_scores.get("relevance", 0.7),
            llm_conclusion_first=llm_scores.get("conclusion_first", False),
            llm_flow_score=llm_scores.get("flow_score", 0.7),
            connector_count=llm_scores.get("connector_count", 0),
        )
        specificity = self.score_specificity(
            llm_experience_based=llm_scores.get("experience_based", 0.7),
            number_count=llm_scores.get("number_count", 0),
            abstract_ratio=llm_scores.get("abstract_ratio", 0.3),
        )
        job_relevance = self.score_job_relevance(
            llm_relevance=llm_scores.get("job_relevance", 0.7),
            keyword_match_count=keyword_match_count,
            total_keywords=total_keywords,
            llm_competency_connection=llm_scores.get("competency_connection", 0.7),
        )
        structure = self.score_structure(star_result)
        delivery = self.score_delivery(text_metrics, audio_delivery, filler_data, repetition_data)

        scores_map = {
            "logic": logic["score"],
            "specificity": specificity["score"],
            "job_relevance": job_relevance["score"],
            "structure": structure["score"],
            "delivery": delivery["score"],
        }
        weighted_total = self.calculate_weighted_total(scores_map)

        return {
            "logic": logic,
            "specificity": specificity,
            "job_relevance": job_relevance,
            "structure": structure,
            "delivery": delivery,
            "weighted_total": weighted_total,
        }


scorer = InterviewScorer()
