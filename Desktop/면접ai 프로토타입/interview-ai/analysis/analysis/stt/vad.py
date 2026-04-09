"""Silero VAD 기반 발화 구간 탐지 모듈."""
from typing import Any, Dict, List, Optional

import structlog

logger = structlog.get_logger(__name__)


class VoiceActivityDetector:
    """Silero VAD를 사용하여 발화/비발화 구간을 분리."""

    def __init__(self):
        self._model = None
        self._utils = None

    def _load_model(self):
        if self._model is not None:
            return
        try:
            import torch
            self._model, self._utils = torch.hub.load(
                repo_or_dir="snakers4/silero-vad",
                model="silero_vad",
                force_reload=False,
                onnx=False,
            )
            logger.info("Silero VAD model loaded")
        except Exception as e:
            logger.warning("Silero VAD load failed, using fallback", error=str(e))
            self._model = None

    def detect(self, audio_path: str) -> List[Dict[str, Any]]:
        """
        발화/비발화 구간 탐지.

        Returns:
            [{"start": float, "end": float, "is_speech": bool}]
        """
        self._load_model()
        if self._model is None:
            return self._fallback_detect(audio_path)

        try:
            import torch
            get_speech_timestamps, _, read_audio, _, _ = self._utils

            wav = read_audio(audio_path, sampling_rate=16000)
            speech_timestamps = get_speech_timestamps(
                wav,
                self._model,
                sampling_rate=16000,
                threshold=0.5,
                min_speech_duration_ms=250,
                min_silence_duration_ms=500,
            )

            # 전체 구간을 발화/비발화로 분할
            duration = len(wav) / 16000
            segments: List[Dict[str, Any]] = []
            prev_end = 0.0

            for ts in speech_timestamps:
                start = ts["start"] / 16000
                end = ts["end"] / 16000

                if start > prev_end + 0.05:
                    segments.append({"start": round(prev_end, 3), "end": round(start, 3), "is_speech": False})
                segments.append({"start": round(start, 3), "end": round(end, 3), "is_speech": True})
                prev_end = end

            if prev_end < duration - 0.05:
                segments.append({"start": round(prev_end, 3), "end": round(duration, 3), "is_speech": False})

            return segments
        except Exception as e:
            logger.error("VAD detection failed", error=str(e))
            return self._fallback_detect(audio_path)

    def _fallback_detect(self, audio_path: str) -> List[Dict[str, Any]]:
        """librosa 기반 폴백 발화 구간 탐지."""
        try:
            import librosa
            y, sr = librosa.load(audio_path, sr=16000)
            intervals = librosa.effects.split(y, top_db=25)
            duration = len(y) / sr

            segments: List[Dict[str, Any]] = []
            prev_end = 0.0
            for start_s, end_s in intervals:
                start = start_s / sr
                end = end_s / sr
                if start > prev_end + 0.05:
                    segments.append({"start": round(prev_end, 3), "end": round(start, 3), "is_speech": False})
                segments.append({"start": round(start, 3), "end": round(end, 3), "is_speech": True})
                prev_end = end

            if prev_end < duration - 0.05:
                segments.append({"start": round(prev_end, 3), "end": round(duration, 3), "is_speech": False})

            return segments
        except Exception as e:
            logger.error("Fallback VAD failed", error=str(e))
            return [{"start": 0.0, "end": 60.0, "is_speech": True}]

    def get_speech_duration(self, vad_segments: List[Dict[str, Any]]) -> float:
        """발화 구간의 총 길이 계산."""
        return sum(
            seg["end"] - seg["start"]
            for seg in vad_segments
            if seg["is_speech"]
        )

    def get_pause_count(
        self, vad_segments: List[Dict[str, Any]], threshold_sec: float = 1.5
    ) -> int:
        """threshold_sec 이상의 비발화 구간(pause) 개수."""
        return sum(
            1
            for seg in vad_segments
            if not seg["is_speech"] and (seg["end"] - seg["start"]) >= threshold_sec
        )
