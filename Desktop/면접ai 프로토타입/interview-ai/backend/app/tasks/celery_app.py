"""Celery 앱 설정."""
from celery import Celery
from app.config import settings

celery_app = Celery(
    "interview_ai",
    broker=settings.CELERY_BROKER_URL,
    backend=settings.CELERY_RESULT_BACKEND,
    include=["app.tasks.analysis_task"],
)

celery_app.conf.update(
    task_serializer="json",
    accept_content=["json"],
    result_serializer="json",
    timezone="Asia/Seoul",
    enable_utc=True,
    task_acks_late=True,
    worker_prefetch_multiplier=1,
    task_track_started=True,
    result_expires=86400,  # 24시간
)
