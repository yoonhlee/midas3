"""API v1 라우터 통합."""
from fastapi import APIRouter

from app.api.v1 import auth, interview, analysis, dashboard, tts

api_router = APIRouter(prefix="/api/v1")

api_router.include_router(auth.router)
api_router.include_router(interview.router)
api_router.include_router(analysis.router)
api_router.include_router(dashboard.router)
api_router.include_router(tts.router)
