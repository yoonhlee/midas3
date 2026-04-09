"""자신감 보조 음성 지표 계산 모듈."""
from typing import Any, Dict, List, Optional

import numpy as np
import structlog

logger = structlog.get_logger(__name__)

CONFIDENT_ENDINGS = [
    "ㅂ니다", "습니다", "했습니다", "됩니다", "입니다",
    "했다", "이다", "한다", "된다", "겠습니다",
    "드립니다", "합니다",
]
UNCERTAIN_ENDINGS = [
    "것 같습니다", "것 같아요", "것 같은데", "것 같고",
    "수도 있습니다", "수도 있을 것", "아닐까", "모르겠",
    "글쎄", "거든요", "잖아요", "이지 않을까",
    "인 것 같", "할 것 같",
]


class ConfidenceMetricsCalculator:
    """자신감 관련 음성/텍스트 지표 계산."""

    def calculate(
        self,
        audio_features: Dict[str, Any],
        transcript_data: Dict[str, Any],
        kiwi_sentences: List[str],
    ) -> Dict[str, Any]:
        """
        자신감 지표 종합 계산.

        Returns:
            {
                "end_of_sentence_rms_drop": float,
                "pitch_stability": float,
                "volume_consistency": float,
                "confident_ending_ratio": float,
                "uncertain_ending_ratio": float,
                "ending_details": [{"sentence", "ending_type", "ending_form"}]
            }
        """
        rms_drop = self._calc_rms_drop(audio_features, transcript_data)
        pitch_stability = self._calc_pitch_stability(audio_features)
        volume_consistency = self._calc_volume_consistency(audio_features)
        ending_result = self._analyze_endings(kiwi_sentences)

        return {
            "end_of_sentence_rms_drop": round(rms_drop, 4),
            "pitch_stability": round(pitch_stability, 4),
            "volume_consistency": round(volume_consistency, 4),
            "confident_ending_ratio": round(ending_result["confident_ratio"], 4),
            "uncertain_ending_ratio": round(ending_result["uncertain_ratio"], 4),
            "ending_details": ending_result["details"],
        }

    def _calc_rms_drop(
        self, audio_features: Dict[str, Any], transcript_data: Dict[str, Any]
    ) -> float:
        """말끝 흐림 비율 계산 — 문장 말미 RMS 하락 정도."""
        rms = audio_features.get("rms")
        rms_times = audio_features.get("rms_times")
        segments = transcript_data.get("segments", [])

        if rms is None or rms_times is None or not segments:
            return 0.2  # 기본값

        try:
            drop_ratios: List[float] = []
            for seg in segments:
                start, end = seg["start"], seg["end"]
                mask = (rms_times >= start) & (rms_times <= end)
                seg_rms = rms[mask]
                if len(seg_rms) < 4:
                    continue
                total_mean = float(np.mean(seg_rms))
                if total_mean < 1e-6:
                    continue
                last_20pct = seg_rms[int(len(seg_rms) * 0.8):]
                last_mean = float(np.mean(last_20pct))
                drop = 1.0 - (last_mean / total_mean)
                drop_ratios.append(max(0.0, drop))

            return float(np.mean(drop_ratios)) if drop_ratios else 0.2
        except Exception as e:
            logger.warning("RMS drop calc failed", error=str(e))
            return 0.2

    def _calc_pitch_stability(self, audio_features: Dict[str, Any]) -> float:
        """피치 안정성 — 유성음 구간 F0 변동계수 (낮을수록 안정)."""
        f0 = audio_features.get("f0")
        voiced_flag = audio_features.get("voiced_flag")
        if f0 is None or voiced_flag is None:
            return 0.3
        try:
            voiced_f0 = f0[voiced_flag == True]  # noqa: E712
            voiced_f0 = voiced_f0[~np.isnan(voiced_f0)]
            if len(voiced_f0) < 10:
                return 0.3
            cv = float(np.std(voiced_f0) / np.mean(voiced_f0)) if np.mean(voiced_f0) > 0 else 0.3
            return round(min(cv, 1.0), 4)
        except Exception:
            return 0.3

    def _calc_volume_consistency(self, audio_features: Dict[str, Any]) -> float:
        """성량 일관성 — RMS 변동계수 (낮을수록 일관)."""
        rms = audio_features.get("rms")
        if rms is None or len(rms) == 0:
            return 0.3
        try:
            mean_rms = float(np.mean(rms))
            if mean_rms < 1e-6:
                return 0.5
            cv = float(np.std(rms) / mean_rms)
            return round(min(cv, 1.0), 4)
        except Exception:
            return 0.3

    def _analyze_endings(self, sentences: List[str]) -> Dict[str, Any]:
        """종결어미 분석 — 확신형/불확신형 비율."""
        if not sentences:
            return {"confident_ratio": 0.5, "uncertain_ratio": 0.1, "details": []}

        details: List[Dict[str, str]] = []
        confident_count = 0
        uncertain_count = 0

        for sent in sentences:
            sent_stripped = sent.strip()
            if not sent_stripped:
                continue

            ending_type = "neutral"
            ending_form = ""

            for pattern in UNCERTAIN_ENDINGS:
                if pattern in sent_stripped:
                    ending_type = "uncertain"
                    ending_form = pattern
                    uncertain_count += 1
                    break

            if ending_type == "neutral":
                for pattern in CONFIDENT_ENDINGS:
                    if sent_stripped.endswith(pattern) or sent_stripped.endswith(pattern + "."):
                        ending_type = "confident"
                        ending_form = pattern
                        confident_count += 1
                        break

            details.append({
                "sentence": sent_stripped[:100],  # 길이 제한
                "ending_type": ending_type,
                "ending_form": ending_form,
            })

        total = len(details)
        confident_ratio = confident_count / total if total > 0 else 0.5
        uncertain_ratio = uncertain_count / total if total > 0 else 0.1

        return {
            "confident_ratio": confident_ratio,
            "uncertain_ratio": uncertain_ratio,
            "details": details,
        }
