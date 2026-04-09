"""애플리케이션 환경변수 설정."""
from typing import List
from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # App
    ENVIRONMENT: str = "development"
    LOG_LEVEL: str = "INFO"

    # Database
    DATABASE_URL: str = "postgresql+asyncpg://interview_user:interview_pass@localhost:5432/interview_db"
    DATABASE_URL_SYNC: str = "postgresql://interview_user:interview_pass@localhost:5432/interview_db"

    # Redis / Celery
    REDIS_URL: str = "redis://localhost:6379/0"
    CELERY_BROKER_URL: str = "redis://localhost:6379/0"
    CELERY_RESULT_BACKEND: str = "redis://localhost:6379/1"

    # JWT
    JWT_SECRET_KEY: str = "supersecretkey_change_in_production"
    JWT_ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 30
    REFRESH_TOKEN_EXPIRE_DAYS: int = 7

    # MinIO / Storage
    MINIO_ENDPOINT: str = "localhost:9000"
    MINIO_ACCESS_KEY: str = "minioadmin"
    MINIO_SECRET_KEY: str = "minioadmin123"
    MINIO_BUCKET_AUDIO: str = "interview-audio"
    MINIO_BUCKET_TTS: str = "interview-tts"
    MINIO_USE_SSL: bool = False
    STORAGE_PATH: str = "./storage"
    USE_LOCAL_STORAGE: bool = True

    # LLM
    OPENAI_API_KEY: str = ""
    OPENAI_MODEL: str = "gpt-4o"
    ANTHROPIC_API_KEY: str = ""
    LLM_PROVIDER: str = "openai"  # openai | anthropic

    # Whisper STT
    WHISPER_MODEL: str = "large-v3"
    WHISPER_MODEL_CPU: str = "base"
    USE_GPU: bool = False

    # Interview settings
    MAX_INTERVIEW_QUESTIONS: int = 5
    MAX_AUDIO_DURATION_SEC: int = 180

    # CORS
    CORS_ORIGINS: List[str] = ["http://localhost:3000", "http://127.0.0.1:3000"]

    @field_validator("DATABASE_URL_SYNC", mode="before")
    @classmethod
    def build_sync_url(cls, v: str, info) -> str:
        """비동기 URL에서 동기 URL 자동 생성."""
        if v:
            return v
        async_url = info.data.get("DATABASE_URL", "")
        return async_url.replace("postgresql+asyncpg://", "postgresql://")


settings = Settings()
