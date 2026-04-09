"""TTS(텍스트 → 음성) 서비스 — edge-tts 기반, 파일 캐싱."""
import hashlib
import os
from pathlib import Path
from typing import Optional

import structlog

from app.config import settings

logger = structlog.get_logger(__name__)


class TTSService:
    """edge-tts를 사용하여 한국어 TTS 음성을 생성하고 캐시."""

    VOICE = "ko-KR-SunHiNeural"  # 한국어 여성 음성
    CACHE_DIR = Path(settings.STORAGE_PATH) / "tts_cache"

    def _get_cache_path(self, text: str) -> Path:
        text_hash = hashlib.md5(text.encode("utf-8")).hexdigest()
        return self.CACHE_DIR / f"{text_hash}.mp3"

    async def synthesize(self, text: str, question_id: Optional[str] = None) -> str:
        """
        텍스트를 음성으로 변환하고 파일 경로를 반환.
        캐시된 파일이 있으면 재사용.
        """
        os.makedirs(self.CACHE_DIR, exist_ok=True)

        # 질문 ID가 있으면 ID 기반 캐싱, 없으면 텍스트 해시 기반
        if question_id:
            cache_path = self.CACHE_DIR / f"q_{question_id}.mp3"
        else:
            cache_path = self._get_cache_path(text)

        if cache_path.exists():
            logger.debug("TTS cache hit", path=str(cache_path))
            return str(cache_path)

        try:
            import edge_tts
            communicate = edge_tts.Communicate(text, self.VOICE)
            await communicate.save(str(cache_path))
            logger.info("TTS generated", path=str(cache_path), text_len=len(text))
            return str(cache_path)
        except Exception as e:
            logger.error("TTS synthesis failed", error=str(e))
            raise RuntimeError(f"TTS 음성 생성 실패: {e}") from e

    def get_public_url(self, file_path: str) -> str:
        """파일 경로를 API URL로 변환."""
        filename = Path(file_path).name
        return f"/api/v1/tts/audio/{filename}"


tts_service = TTSService()
