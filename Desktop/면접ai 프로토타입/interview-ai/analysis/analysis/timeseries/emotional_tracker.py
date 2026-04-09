"""시계열 정서 안정성 분석 모듈."""
from typing import Any, Dict, List

import numpy as np
import structlog

logger = structlog.get_logger(__name__)


class EmotionalTracker:
    """면접 전체 시간 흐름에 따른 긴장도/정서 분석."""

    def generate_timeseries(
        self,
        audio_features: Dict[str, Any],
        transcript_data: Dict[str, Any],
    ) -> List[Dict[str, Any]]:
        """
        1초 단위 윈도우로 시계열 데이터 생성.

        tension_index = f(pitch_deviation, rms_deviation, pause_proximity)

        Returns:
            [{"time_sec": float, "pitch": float, "rms": float, "tension_index": float}]
        """
        rms = audio_features.get("rms")
        rms_times = audio_features.get("rms_times")
        f0 = audio_features.get("f0")
        f0_times = audio_features.get("f0_times")
        duration = audio_features.get("duration", 0.0)

        if rms is None or f0 is None or duration <= 0:
            return []

        # 기준값 계산
        rms_mean = float(np.mean(rms)) if len(rms) > 0 else 1e-6
        rms_std = float(np.std(rms)) if len(rms) > 0 else 1e-6

        voiced_f0 = f0[~np.isnan(f0)] if f0 is not None else np.array([])
        f0_mean = float(np.mean(voiced_f0)) if len(voiced_f0) > 0 else 200.0
        f0_std = float(np.std(voiced_f0)) if len(voiced_f0) > 0 else 50.0

        # STT 세그먼트로 pause 위치 파악
        segments = transcript_data.get("segments", [])
        pause_positions: List[float] = []
        for i in range(len(segments) - 1):
            gap = segments[i + 1]["start"] - segments[i]["end"]
            if gap >= 1.5:
                pause_positions.append(segments[i]["end"])

        timeseries: List[Dict[str, Any]] = []
        window_size = 1.0  # 초

        t = 0.0
        while t < duration:
            t_end = t + window_size

            # 해당 윈도우 RMS 평균
            if rms_times is not None:
                mask_rms = (rms_times >= t) & (rms_times < t_end)
                window_rms_vals = rms[mask_rms]
                window_rms = float(np.mean(window_rms_vals)) if len(window_rms_vals) > 0 else rms_mean
            else:
                window_rms = rms_mean

            # 해당 윈도우 F0 평균
            if f0_times is not None:
                mask_f0 = (f0_times >= t) & (f0_times < t_end)
                window_f0_vals = f0[mask_f0]
                window_f0_vals = window_f0_vals[~np.isnan(window_f0_vals)]
                window_pitch = float(np.mean(window_f0_vals)) if len(window_f0_vals) > 0 else 0.0
            else:
                window_pitch = 0.0

            # tension_index 계산
            # (1) 피치 변동
            pitch_deviation = abs(window_pitch - f0_mean) / (f0_std + 1e-6) if window_pitch > 0 else 0.0

            # (2) RMS 급락
            rms_drop = max(0.0, (rms_mean - window_rms) / (rms_mean + 1e-6))

            # (3) 긴 pause 근접도
            pause_proximity = 0.0
            for pp in pause_positions:
                dist = abs(t - pp)
                if dist < 3.0:
                    pause_proximity = max(pause_proximity, 1.0 - dist / 3.0)

            tension_index = min(1.0, (
                0.4 * min(pitch_deviation / 3.0, 1.0)
                + 0.3 * rms_drop
                + 0.3 * pause_proximity
            ))

            timeseries.append({
                "time_sec": round(t, 1),
                "pitch": round(window_pitch, 2),
                "rms": round(window_rms, 6),
                "tension_index": round(tension_index, 4),
            })
            t += window_size

        return timeseries
