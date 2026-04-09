"""SQLite DB 테이블 생성 스크립트 (Alembic 대체)."""
import asyncio
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))

async def main():
    # 모든 모델 임포트 (Base에 등록되도록)
    from app.core.database import engine, Base
    import app.models.user  # noqa
    import app.models.interview_session  # noqa
    import app.models.question  # noqa
    import app.models.answer  # noqa
    import app.models.analysis_result  # noqa
    import app.models.score  # noqa

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    print("테이블 생성 완료!")

if __name__ == "__main__":
    asyncio.run(main())
