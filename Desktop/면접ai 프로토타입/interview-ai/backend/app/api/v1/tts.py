"""TTS API 엔드포인트."""
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel

from app.config import settings
from app.services.tts_service import tts_service

router = APIRouter(prefix="/tts", tags=["tts"])


class TTSRequest(BaseModel):
    text: str


class TTSResponse(BaseModel):
    url: str


@router.post("/synthesize", response_model=TTSResponse)
async def synthesize(data: TTSRequest) -> TTSResponse:
    """텍스트를 음성으로 변환하고 URL 반환."""
    if not data.text.strip():
        raise HTTPException(status_code=400, detail="텍스트를 입력해주세요.")
    path = await tts_service.synthesize(data.text)
    return TTSResponse(url=tts_service.get_public_url(path))


@router.get("/audio/{filename}")
async def get_tts_audio(filename: str):
    """TTS 오디오 파일 서빙."""
    # 경로 조작 방지
    if ".." in filename or "/" in filename or "\\" in filename:
        raise HTTPException(status_code=400, detail="잘못된 파일명입니다.")
    file_path = Path(settings.STORAGE_PATH) / "tts_cache" / filename
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="오디오 파일을 찾을 수 없습니다.")
    return FileResponse(str(file_path), media_type="audio/mpeg")
