"""FastAPI 애플리케이션 엔트리포인트."""
import os
import sys

# analysis 패키지 경로 추가 (interview-ai/analysis/ 디렉터리)
_analysis_root = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../analysis"))
if _analysis_root not in sys.path:
    sys.path.insert(0, _analysis_root)

import structlog
from contextlib import asynccontextmanager
from typing import AsyncGenerator

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from app.api.v1.router import api_router
from app.config import settings

logger = structlog.get_logger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    """앱 시작/종료 시 실행되는 라이프사이클 핸들러."""
    logger.info("Starting Interview AI Backend", env=settings.ENVIRONMENT)
    # 스토리지 디렉토리 생성
    import os
    os.makedirs(f"{settings.STORAGE_PATH}/audio", exist_ok=True)
    os.makedirs(f"{settings.STORAGE_PATH}/tts_cache", exist_ok=True)
    yield
    logger.info("Shutting down Interview AI Backend")


app = FastAPI(
    title="Interview AI API",
    description="AI 모의면접 시스템 — 음성 분석 기반 면접 평가 플랫폼",
    version="0.1.0",
    lifespan=lifespan,
)

# CORS 설정
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# API 라우터 등록
app.include_router(api_router)


# 헬스체크
@app.get("/health", tags=["health"])
async def health_check() -> dict:
    return {"status": "ok", "env": settings.ENVIRONMENT}
