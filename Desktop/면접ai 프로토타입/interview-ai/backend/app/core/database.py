"""비동기 SQLAlchemy 데이터베이스 연결 및 세션 관리."""
from typing import AsyncGenerator

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase

from app.config import settings


_is_sqlite = settings.DATABASE_URL.startswith("sqlite")
_engine_kwargs = {"echo": settings.ENVIRONMENT == "development"}
if not _is_sqlite:
    _engine_kwargs.update({"pool_size": 10, "max_overflow": 20, "pool_pre_ping": True})
else:
    _engine_kwargs["connect_args"] = {"check_same_thread": False}

engine = create_async_engine(settings.DATABASE_URL, **_engine_kwargs)

AsyncSessionLocal = async_sessionmaker(
    engine,
    class_=AsyncSession,
    expire_on_commit=False,
    autocommit=False,
    autoflush=False,
)


class Base(DeclarativeBase):
    """모든 SQLAlchemy 모델의 베이스 클래스."""
    pass


async def get_db() -> AsyncGenerator[AsyncSession, None]:
    """FastAPI 의존성 주입용 DB 세션 생성기."""
    async with AsyncSessionLocal() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise
        finally:
            await session.close()
