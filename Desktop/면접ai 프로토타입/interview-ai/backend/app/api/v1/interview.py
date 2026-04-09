"""면접 세션 API."""
import threading
from typing import List, Optional

import structlog
from fastapi import APIRouter, File, Form, HTTPException, Query, UploadFile, status
from sqlalchemy import func, select

from app.dependencies import CurrentUser, DB
from app.models.answer import Answer
from app.models.interview_session import InterviewSession
from app.schemas.interview import (
    AnswerUploadResponse,
    QuestionResponse,
    SessionCreate,
    SessionDetailResponse,
    SessionListItem,
    SessionStatusResponse,
)
from app.services.interview_service import interview_service
from app.services.tts_service import tts_service

logger = structlog.get_logger(__name__)
router = APIRouter(prefix="/interviews", tags=["interviews"])


def _require_session(session: Optional[InterviewSession]) -> InterviewSession:
    if not session:
        raise HTTPException(status_code=404, detail="면접 세션을 찾을 수 없습니다.")
    return session


@router.post("", response_model=SessionDetailResponse, status_code=status.HTTP_201_CREATED)
async def create_session(data: SessionCreate, current_user: CurrentUser, db: DB):
    session = await interview_service.create_session(db, user_id=current_user.id, job_category=data.job_category)
    return SessionDetailResponse.model_validate(session)


@router.get("", response_model=List[SessionListItem])
async def list_sessions(current_user: CurrentUser, db: DB, page: int = Query(default=1, ge=1)):
    sessions = await interview_service.list_sessions(db, current_user.id, page)
    items = []
    for s in sessions:
        count_result = await db.execute(
            select(func.count()).where(Answer.session_id == s.id, Answer.status != "pending")
        )
        items.append(SessionListItem(
            id=s.id, session_number=s.session_number, job_category=s.job_category,
            status=s.status, total_score=float(s.total_score) if s.total_score else None,
            started_at=s.started_at, completed_at=s.completed_at,
            answer_count=count_result.scalar() or 0,
        ))
    return items


@router.get("/{session_id}", response_model=SessionDetailResponse)
async def get_session(session_id: str, current_user: CurrentUser, db: DB):
    session = _require_session(await interview_service.get_session(db, session_id, current_user.id))
    return SessionDetailResponse.model_validate(session)


@router.post("/{session_id}/start", response_model=QuestionResponse)
async def start_interview(session_id: str, current_user: CurrentUser, db: DB):
    session = _require_session(await interview_service.get_session(db, session_id, current_user.id))
    if session.status != "in_progress":
        raise HTTPException(status_code=400, detail=f"이 세션은 '{session.status}' 상태입니다.")

    question, order = await interview_service.start_session(db, session)
    tts_url = None
    try:
        tts_path = await tts_service.synthesize(question.question_text, str(question.id))
        tts_url = tts_service.get_public_url(tts_path)
    except Exception as e:
        logger.warning("TTS failed", error=str(e))

    return QuestionResponse(
        question_id=question.id, question_text=question.question_text,
        question_order=order, category=question.category,
        expected_star_applicable=question.expected_star_applicable, tts_url=tts_url,
    )


@router.get("/{session_id}/next-question", response_model=Optional[QuestionResponse])
async def next_question(session_id: str, current_user: CurrentUser, db: DB):
    session = _require_session(await interview_service.get_session(db, session_id, current_user.id))
    result = await interview_service.get_next_question(db, session)
    if not result:
        return None
    question, order = result
    tts_url = None
    try:
        tts_path = await tts_service.synthesize(question.question_text, str(question.id))
        tts_url = tts_service.get_public_url(tts_path)
    except Exception:
        pass
    return QuestionResponse(
        question_id=question.id, question_text=question.question_text,
        question_order=order, category=question.category,
        expected_star_applicable=question.expected_star_applicable, tts_url=tts_url,
    )


@router.post("/{session_id}/answers", response_model=AnswerUploadResponse)
async def upload_answer(
    session_id: str, current_user: CurrentUser, db: DB,
    audio_file: UploadFile = File(...),
    question_order: int = Form(...),
    audio_duration_sec: Optional[float] = Form(None),
):
    session = _require_session(await interview_service.get_session(db, session_id, current_user.id))
    if session.status != "in_progress":
        raise HTTPException(status_code=400, detail="진행 중인 세션만 답변을 업로드할 수 있습니다.")

    audio_bytes = await audio_file.read()
    if len(audio_bytes) == 0:
        raise HTTPException(status_code=400, detail="빈 오디오 파일입니다.")

    audio_path = await interview_service.save_audio(
        session_id=session_id, user_id=current_user.id,
        question_order=question_order, audio_bytes=audio_bytes,
        filename=audio_file.filename or "audio.webm",
    )
    answer = await interview_service.record_answer(db, session, question_order, audio_path, audio_duration_sec)

    next_q_result = await interview_service.get_next_question(db, session)
    next_question_data = None
    is_last = True
    if next_q_result:
        is_last = False
        q, order = next_q_result
        tts_url = None
        try:
            tts_path = await tts_service.synthesize(q.question_text, str(q.id))
            tts_url = tts_service.get_public_url(tts_path)
        except Exception:
            pass
        next_question_data = QuestionResponse(
            question_id=q.id, question_text=q.question_text, question_order=order,
            category=q.category, expected_star_applicable=q.expected_star_applicable, tts_url=tts_url,
        )

    return AnswerUploadResponse(
        answer_id=answer.id, message="답변이 성공적으로 업로드되었습니다.",
        next_question=next_question_data, is_last_question=is_last,
    )


@router.post("/{session_id}/finish", response_model=SessionStatusResponse)
async def finish_interview(session_id: str, current_user: CurrentUser, db: DB):
    session = _require_session(await interview_service.get_session(db, session_id, current_user.id))
    if session.status != "in_progress":
        raise HTTPException(status_code=400, detail=f"이 세션은 '{session.status}' 상태입니다.")

    session = await interview_service.finish_session(db, session)

    # 백그라운드 스레드에서 분석 실행 (Celery 대체)
    def _run_bg():
        from app.tasks.analysis_task import run_analysis_pipeline
        run_analysis_pipeline(session_id)

    thread = threading.Thread(target=_run_bg, daemon=True)
    thread.start()
    logger.info("Analysis thread started", session_id=session_id)

    return SessionStatusResponse(
        session_id=session.id, status=session.status, current_phase="분석을 시작합니다...",
    )


@router.get("/{session_id}/status", response_model=SessionStatusResponse)
async def get_session_status(session_id: str, current_user: CurrentUser, db: DB):
    session = _require_session(await interview_service.get_session(db, session_id, current_user.id))
    phase_map = {
        "in_progress": "면접 진행 중", "analyzing": "분석 중",
        "completed": "분석 완료", "failed": "분석 실패",
    }
    return SessionStatusResponse(
        session_id=session.id, status=session.status,
        current_phase=phase_map.get(session.status, session.status),
    )
