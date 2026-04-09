"""전달력 음성 지표 계산 모듈."""
from typing import Any, Dict, List

import numpy as np
import structlog

logger = structlog.get_logger(__name__)


def _score_in_range(value: float, lo: float, hi: float) -> float:
    """값이 [lo, hi] 범위 내이면 100점, 범위 밖이면 감점 (최저 0점)."""
    if lo <= value <= hi:
        return 100.0
    if value < lo:
        ratio = value / lo if lo > 0 else 0
        return max(0.0, ratio * 100)
    # value > hi
    ratio = hi / value if value > 0 else 0
    return max(0.0, ratio * 100)


class DeliveryMetricsCalculator:
    """음성 전달력 지표 계산."""

    OPTIMAL_DURATION = (40.0, 90.0)          # 초
    OPTIMAL_SPEECH_RATE_WPS = (3.0, 4.5)     # 어절/초
    OPTIMAL_PAUSE_RATIO = (0.15, 0.30)
    LONG_PAUSE_THRESHOLD = 1.5               # 초
    MAX_FILLER_RATIO = 0.05                  # 5% 이하 양호

    def calculate(
        self,
        transcript_data: Dict[str, Any],
        audio_features: Dict[str, Any],
        vad_segments: List[Dict[str, Any]],
        filler_data: Dict[str, Any],
        confidence_data: Dict[str, Any],
    ) -> Dict[str, Any]:
        """
        전달력 음성 지표 계산.

        Returns:
            {
                "total_duration_sec": float,
                "speech_duration_sec": float,
                "speech_rate_wps": float,
                "pause_count": int,
                "pause_ratio": float,
                "duration_score": float,
                "speech_rate_score": float,
                "pause_ratio_score": float,
                "filler_score": float,
                "sentence_end_drop_score": float,
                "audio_delivery_score": float,  # 0~100
            }
        """
        total_duration = audio_features.get("duration", 0.0)

        # 발화 시간 계산
        speech_duration = sum(
            seg["end"] - seg["start"]
            for seg in vad_segments
            if seg.get("is_speech")
        )
        if speech_duration <= 0:
            speech_duration = total_duration * 0.7  # 폴백

        # 어절 수 (공백 기준)
        full_text = transcript_data.get("full_text", "")
        word_count = len(full_text.split()) if full_text else 0

        # 발화 속도 (어절/초)
        speech_rate_wps = word_count / speech_duration if speech_duration > 0 else 0.0

        # Pause 횟수 및 비율
        pause_count = sum(
            1
            for seg in vad_segments
            if not seg.get("is_speech") and (seg["end"] - seg["start"]) >= self.LONG_PAUSE_THRESHOLD
        )
        pause_ratio = (total_duration - speech_duration) / total_duration if total_duration > 0 else 0.0

        # 점수 산출
        duration_score = _score_in_range(total_duration, *self.OPTIMAL_DURATION)
        speech_rate_score = _score_in_range(speech_rate_wps, *self.OPTIMAL_SPEECH_RATE_WPS)
        pause_ratio_score = _score_in_range(pause_ratio, *self.OPTIMAL_PAUSE_RATIO)

        # 간투어 점수
        filler_total = filler_data.get("total", 0)
        filler_ratio = filler_total / word_count if word_count > 0 else 0.0
        if filler_ratio < 0.03:
            filler_score = 100.0
        elif filler_ratio < 0.05:
            filler_score = 75.0
        elif filler_ratio < 0.10:
            filler_score = 50.0
        else:
            filler_score = max(0.0, 50.0 - (filler_ratio - 0.10) * 500)

        # 말끝 흐림 점수
        rms_drop = confidence_data.get("end_of_sentence_rms_drop", 0.0)
        if rms_drop < 0.30:
            sentence_end_drop_score = 100.0
        elif rms_drop < 0.50:
            sentence_end_drop_score = 70.0
        else:
            sentence_end_drop_score = max(0.0, 70.0 - (rms_drop - 0.50) * 200)

        # 음성 전달력 종합 점수 (가중 합산)
        audio_delivery_score = (
            duration_score * 0.20
            + speech_rate_score * 0.20
            + filler_score * 0.25
            + pause_ratio_score * 0.20
            + sentence_end_drop_score * 0.15
        )

        return {
            "total_duration_sec": round(total_duration, 2),
            "speech_duration_sec": round(speech_duration, 2),
            "speech_rate_wps": round(speech_rate_wps, 2),
            "pause_count": pause_count,
            "pause_ratio": round(pause_ratio, 4),
            "duration_score": round(duration_score, 2),
            "speech_rate_score": round(speech_rate_score, 2),
            "pause_ratio_score": round(pause_ratio_score, 2),
            "filler_score": round(filler_score, 2),
            "sentence_end_drop_score": round(sentence_end_drop_score, 2),
            "audio_delivery_score": round(audio_delivery_score, 2),
        }
