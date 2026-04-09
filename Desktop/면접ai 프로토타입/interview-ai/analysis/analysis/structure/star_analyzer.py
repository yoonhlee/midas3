"""STAR 구조 분석 — LLM 기반."""
import json
from typing import Any, Dict

import structlog

logger = structlog.get_logger(__name__)

STAR_PROMPT = """\
당신은 한국어 면접 답변의 STAR 구조를 분석하는 전문가입니다.
아래 면접 질문과 답변을 분석하여 STAR 구조를 평가해주세요.

[면접 질문]
{question}

[면접 답변]
{answer}

다음 JSON 형식으로만 응답하세요. 다른 텍스트는 절대 포함하지 마세요:
{{
    "has_situation": true/false,
    "has_task": true/false,
    "has_action": true/false,
    "has_result": true/false,
    "element_sufficiency": {{"S": 1~5, "T": 1~5, "A": 1~5, "R": 1~5}},
    "order_appropriate": true/false,
    "causal_connection": 0.0~1.0,
    "tagged_sentences": [
        {{"sentence": "문장 텍스트", "role": "S|T|A|R|other"}}
    ],
    "overall_star_score": 0.0~100.0,
    "reasoning": "판단 근거 한 줄"
}}

평가 기준:
- S(Situation): 상황/배경 설명 여부
- T(Task): 해결해야 할 과제/역할 설명 여부
- A(Action): 본인이 취한 구체적 행동 설명 여부
- R(Result): 결과/성과/배운 점 설명 여부
- causal_connection: Action → Result 인과 관계의 명확성 (0=없음, 1=매우 명확)
"""

LLM_ANALYSIS_PROMPT = """\
당신은 한국어 면접 답변을 평가하는 전문가입니다.
아래 면접 질문과 답변을 분석하여 JSON으로만 응답하세요.

[면접 질문]
{question}

[면접 답변]
{answer}

다음 JSON 형식으로만 응답하세요:
{{
    "relevance": 0.0~1.0,
    "conclusion_first": true/false,
    "flow_score": 0.0~1.0,
    "connector_count": 정수,
    "experience_based": 0.0~1.0,
    "number_count": 정수,
    "abstract_ratio": 0.0~1.0,
    "job_relevance": 0.0~1.0,
    "competency_connection": 0.0~1.0
}}

각 필드 설명:
- relevance: 질문 의도에 맞는 답변인가 (0=전혀 아님, 1=완벽)
- conclusion_first: 첫 2문장 내에 핵심 결론을 먼저 제시했는가
- flow_score: 논리 흐름이 자연스러운가 (0~1)
- connector_count: "따라서", "그래서", "결과적으로" 등 논리 연결 표현 횟수
- experience_based: 실제 경험을 기반으로 서술했는가 (0~1)
- number_count: 구체적 수치(숫자, %, 기간 등) 표현 개수
- abstract_ratio: 추상적·모호한 표현의 비율 (0=구체적, 1=매우 추상적)
- job_relevance: 지원 직무와 관련된 경험/역량인가 (0~1)
- competency_connection: 직무 역량과 답변이 연결되는가 (0~1)
"""


class STARAnalyzer:
    """LLM 기반 STAR 구조 및 논리성 분석."""

    def __init__(self):
        self._client = None

    def _get_client(self):
        import os
        provider = os.environ.get("LLM_PROVIDER", "openai")
        if provider == "anthropic":
            import anthropic
            return "anthropic", anthropic.Anthropic(api_key=os.environ.get("ANTHROPIC_API_KEY"))
        else:
            import openai
            return "openai", openai.OpenAI(api_key=os.environ.get("OPENAI_API_KEY"))

    def _call_llm(self, prompt: str) -> str:
        """LLM API 호출 및 텍스트 반환."""
        import os
        provider, client = self._get_client()
        model = os.environ.get("OPENAI_MODEL", "gpt-4o")

        if provider == "anthropic":
            response = client.messages.create(
                model="claude-sonnet-4-6",
                max_tokens=1024,
                messages=[{"role": "user", "content": prompt}],
            )
            return response.content[0].text
        else:
            response = client.chat.completions.create(
                model=model,
                messages=[{"role": "user", "content": prompt}],
                temperature=0,
                response_format={"type": "json_object"},
            )
            return response.choices[0].message.content

    def analyze_star(self, question: str, answer_text: str) -> Dict[str, Any]:
        """STAR 구조 분석."""
        try:
            prompt = STAR_PROMPT.format(question=question, answer=answer_text)
            raw = self._call_llm(prompt)
            result = json.loads(raw)
            # 필수 필드 기본값 보장
            result.setdefault("has_situation", False)
            result.setdefault("has_task", False)
            result.setdefault("has_action", False)
            result.setdefault("has_result", False)
            result.setdefault("order_appropriate", False)
            result.setdefault("causal_connection", 0.5)
            result.setdefault("overall_star_score", 0.0)
            result.setdefault("tagged_sentences", [])
            return result
        except Exception as e:
            logger.error("STAR analysis failed", error=str(e))
            return self._fallback_star()

    def analyze_llm_scores(self, question: str, answer_text: str) -> Dict[str, Any]:
        """논리성/구체성/직무적합성 LLM 판단 점수 산출."""
        try:
            prompt = LLM_ANALYSIS_PROMPT.format(question=question, answer=answer_text)
            raw = self._call_llm(prompt)
            result = json.loads(raw)
            return result
        except Exception as e:
            logger.error("LLM scoring failed", error=str(e))
            return self._fallback_llm_scores()

    def _fallback_star(self) -> Dict[str, Any]:
        """LLM 실패 시 폴백 STAR 결과."""
        return {
            "has_situation": True,
            "has_task": False,
            "has_action": True,
            "has_result": True,
            "element_sufficiency": {"S": 3, "T": 2, "A": 3, "R": 2},
            "order_appropriate": True,
            "causal_connection": 0.5,
            "tagged_sentences": [],
            "overall_star_score": 62.5,
        }

    def _fallback_llm_scores(self) -> Dict[str, Any]:
        return {
            "relevance": 0.7,
            "conclusion_first": False,
            "flow_score": 0.65,
            "connector_count": 2,
            "experience_based": 0.7,
            "number_count": 1,
            "abstract_ratio": 0.3,
            "job_relevance": 0.65,
            "competency_connection": 0.65,
        }


star_analyzer = STARAnalyzer()
