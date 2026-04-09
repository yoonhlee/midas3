"""평가 기준표 — 가중치 및 세부 기준 상수 정의."""

# =============================================
# 5대 평가 항목 가중치 (합 = 1.0)
# =============================================
EVALUATION_WEIGHTS: dict[str, float] = {
    "logic": 0.25,           # 논리성 25%
    "specificity": 0.20,     # 구체성 20%
    "job_relevance": 0.15,   # 직무 적합성 15%
    "structure": 0.20,       # 구조 완성도 (STAR) 20%
    "delivery": 0.20,        # 전달력 (텍스트+음성) 20%
}

# =============================================
# 논리성 세부 가중치
# =============================================
LOGIC_WEIGHTS: dict[str, float] = {
    "relevance": 0.40,          # 질문-답변 적합성
    "conclusion_first": 0.30,   # 결론 선행 여부
    "flow": 0.30,               # 내용 흐름 자연스러움
}

# =============================================
# 구체성 세부 가중치
# =============================================
SPECIFICITY_WEIGHTS: dict[str, float] = {
    "experience_based": 0.40,   # 경험 기반 서술 여부
    "numbers": 0.35,            # 수치/기간/결과 포함
    "abstract_ratio": 0.25,     # 추상 표현 비율 (낮을수록 좋음)
}

# =============================================
# 직무 적합성 세부 가중치
# =============================================
JOB_RELEVANCE_WEIGHTS: dict[str, float] = {
    "job_experience": 0.40,     # 직무 관련 경험 포함
    "keyword_match": 0.30,      # 직무 키워드 사용
    "competency_link": 0.30,    # 역량 연결성
}

# =============================================
# 구조 완성도 (STAR) 세부 가중치
# =============================================
STRUCTURE_WEIGHTS: dict[str, float] = {
    "elements": 0.50,           # S/T/A/R 각 요소 포함 (각 12.5%)
    "order": 0.25,              # 구조 순서 적절성
    "connection": 0.25,         # 요소 간 논리적 연결
}

# =============================================
# 전달력 세부 가중치
# =============================================
DELIVERY_WEIGHTS: dict[str, float] = {
    "text": 0.50,   # 텍스트 전달력
    "audio": 0.50,  # 음성 전달력
}
TEXT_DELIVERY_WEIGHTS: dict[str, float] = {
    "sentence_conciseness": 0.50,   # 문장 간결성
    "repetition": 0.50,             # 반복 표현
}
AUDIO_DELIVERY_WEIGHTS: dict[str, float] = {
    "duration": 0.20,
    "speech_rate": 0.20,
    "filler": 0.25,
    "pause_ratio": 0.20,
    "sentence_end_drop": 0.15,
}

# =============================================
# 음성 적정 범위
# =============================================
OPTIMAL_DURATION_SEC = (40.0, 90.0)
OPTIMAL_SPEECH_RATE_WPS = (3.0, 4.5)
OPTIMAL_PAUSE_RATIO = (0.15, 0.30)
LONG_PAUSE_THRESHOLD_SEC = 1.5
FILLER_RATIO_EXCELLENT = 0.03
FILLER_RATIO_GOOD = 0.05
SENTENCE_END_DROP_THRESHOLD = 0.30

# =============================================
# 등급 매핑
# =============================================
def score_to_grade(score: float) -> str:
    """총점을 등급 문자열로 변환."""
    if score >= 90:
        return "A+"
    elif score >= 85:
        return "A"
    elif score >= 80:
        return "B+"
    elif score >= 75:
        return "B"
    elif score >= 70:
        return "C+"
    elif score >= 65:
        return "C"
    elif score >= 60:
        return "D+"
    else:
        return "D"
