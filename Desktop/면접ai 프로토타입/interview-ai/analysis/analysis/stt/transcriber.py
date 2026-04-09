"""faster-whisper 기반 STT(음성→텍스트) 변환 모듈."""
import os
from typing import Any, Dict, List, Optional

import structlog

from app.config import settings as app_settings

logger = structlog.get_logger(__name__)


class Transcriber:
    """faster-whisper를 사용하여 한국어 음성을 텍스트로 변환."""

    def __init__(self):
        self._model = None

    def _load_model(self):
        """모델 지연 로딩 — 최초 사용 시에만 로드."""
        if self._model is not None:
            return

        try:
            from faster_whisper import WhisperModel
            use_gpu = os.environ.get("USE_GPU", "false").lower() == "true"
            if use_gpu:
                model_size = os.environ.get("WHISPER_MODEL", "large-v3")
                device = "cuda"
                compute_type = "float16"
            else:
                model_size = os.environ.get("WHISPER_MODEL_CPU", "base")
                device = "cpu"
                compute_type = "int8"

            logger.info("Loading Whisper model", model=model_size, device=device)
            self._model = WhisperModel(model_size, device=device, compute_type=compute_type)
            logger.info("Whisper model loaded", model=model_size)
        except ImportError:
            logger.warning("faster-whisper not installed, using mock transcriber")
            self._model = None

    def transcribe(self, audio_path: str) -> Dict[str, Any]:
        """
        오디오 파일을 한국어 텍스트로 변환.

        Returns:
            {
                "full_text": str,
                "segments": [
                    {
                        "text": str,
                        "start": float,
                        "end": float,
                        "words": [{"word": str, "start": float, "end": float, "probability": float}]
                    }
                ],
                "language": str,
                "language_probability": float
            }
        """
        self._load_model()

        if self._model is None:
            return self._mock_transcribe(audio_path)

        try:
            segments_iter, info = self._model.transcribe(
                audio_path,
                language="ko",
                word_timestamps=True,
                vad_filter=True,
                vad_parameters={"min_silence_duration_ms": 500},
            )

            segments: List[Dict[str, Any]] = []
            full_text_parts: List[str] = []

            for seg in segments_iter:
                words = []
                if seg.words:
                    for w in seg.words:
                        words.append({
                            "word": w.word,
                            "start": round(w.start, 3),
                            "end": round(w.end, 3),
                            "probability": round(w.probability, 4),
                        })
                segments.append({
                    "text": seg.text.strip(),
                    "start": round(seg.start, 3),
                    "end": round(seg.end, 3),
                    "words": words,
                })
                full_text_parts.append(seg.text.strip())

            return {
                "full_text": " ".join(full_text_parts),
                "segments": segments,
                "language": info.language,
                "language_probability": round(info.language_probability, 4),
            }
        except Exception as e:
            logger.error("Transcription failed", audio_path=audio_path, error=str(e))
            raise

    def _mock_transcribe(self, audio_path: str) -> Dict[str, Any]:
        """테스트용 목 전사 결과."""
        logger.warning("Using mock transcription", audio_path=audio_path)
        return {
            "full_text": "저는 이전 프로젝트에서 팀 리더로서 어 데이터 분석 파이프라인을 구축했습니다. 약 6개월에 걸쳐 진행되었으며 처리 속도를 30% 향상시켰습니다.",
            "segments": [
                {
                    "text": "저는 이전 프로젝트에서 팀 리더로서 어 데이터 분석 파이프라인을 구축했습니다.",
                    "start": 0.0,
                    "end": 5.2,
                    "words": [],
                },
                {
                    "text": "약 6개월에 걸쳐 진행되었으며 처리 속도를 30% 향상시켰습니다.",
                    "start": 5.5,
                    "end": 10.1,
                    "words": [],
                },
            ],
            "language": "ko",
            "language_probability": 0.99,
        }
