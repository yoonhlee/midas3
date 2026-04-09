"""분석 결과 API."""
from typing import List, Optional

import structlog
from fastapi import APIRouter, HTTPException
from sqlalchemy import select

from app.dependencies import CurrentUser, DB
from app.models.analysis_result import AnalysisResult
from app.models.answer import Answer
from app.models.interview_session import InterviewSession
from app.models.question import Question
from app.models.score import Score
from app.schemas.analysis import (
    AnswerResultResponse,
    AudioAnalysis,
    ScoreDetail,
    SessionResultResponse,
    TimeseriesResponse,
)
from analysis.scoring.rubric import score_to_grade
from analysis.text.filler_detector import FillerWordDetector

logger = structlog.get_logger(__name__)
router = APIRouter(prefix="/interviews", tags=["results"])

filler_detector = FillerWordDetector()


async def _require_completed_session(db, session_id: str, user_id: str) -> InterviewSession:
    result = await db.execute(
        select(InterviewSession).where(
            InterviewSession.id == session_id,
            InterviewSession.user_id == user_id,
        )
    )
    session = result.scalar_one_or_none()
    if not session:
        raise HTTPException(status_code=404, detail="세션을 찾을 수 없습니다.")
    if session.status != "completed":
        raise HTTPException(status_code=422, detail=f"분석이 완료되지 않았습니다. (현재: {session.status})")
    return session


def _build_answer_result(
    answer: Answer,
    ar: Optional[AnalysisResult],
    score: Optional[Score],
    question_text: str,
) -> AnswerResultResponse:
    """Answer + AnalysisResult + Score → AnswerResultResponse 변환."""

    def _float(v) -> Optional[float]:
        return float(v) if v is not None else None

    # 추임새 하이라이트
    highlighted = answer.transcript or ""
    filler_details: List = []
    if ar and ar.filler_words:
        filler_details = ar.filler_words.get("details", [])
        try:
            highlighted = filler_detector.highlight_transcript(highlighted, ar.filler_words)
        except Exception:
            pass

    audio_analysis = None
    if ar:
        audio_analysis = AudioAnalysis(
            duration_sec=_float(ar.speech_duration_sec),
            speech_rate_wps=_float(ar.speech_rate_wpm),
            pause_count=ar.pause_count,
            pause_ratio=_float(ar.pause_ratio),
            pitch_mean=_float(ar.pitch_mean),
            pitch_std=_float(ar.pitch_std),
            rms_mean=_float(ar.rms_mean),
            rms_std=_float(ar.rms_std),
            filler_total=ar.filler_words.get("total") if ar.filler_words else None,
            filler_ratio=ar.filler_words.get("ratio") if ar.filler_words else None,
            end_of_sentence_rms_drop=_float(ar.end_of_sentence_rms_drop),
            confident_ending_ratio=_float(ar.confident_ending_ratio),
            uncertain_ending_ratio=_float(ar.uncertain_ending_ratio),
        )

    scores_dict = {}
    if score:
        scores_dict = {
            "logic": ScoreDetail(score=_float(score.logic_score), feedback=score.logic_feedback),
            "specificity": ScoreDetail(score=_float(score.specificity_score), feedback=score.specificity_feedback),
            "job_relevance": ScoreDetail(score=_float(score.job_relevance_score), feedback=score.job_relevance_feedback),
            "structure": ScoreDetail(score=_float(score.structure_score), feedback=score.structure_feedback),
            "delivery": ScoreDetail(score=_float(score.delivery_score), feedback=score.delivery_feedback),
        }

    return AnswerResultResponse(
        answer_id=str(answer.id),
        question_order=answer.question_order,
        question_text=question_text,
        transcript=answer.transcript,
        highlighted_transcript=highlighted,
        scores=scores_dict,
        weighted_total=_float(score.weighted_total) if score else None,
        audio_analysis=audio_analysis,
        filler_details=filler_details,
        repetition_details=(ar.repetition_details or {}).get("details", []) if ar else [],
        self_correction_count=ar.self_correction_count if ar else None,
        star_result=ar.star_score if ar else None,
        improvement_suggestions=score.improvement_suggestions if score else [],
    )


@router.get("/{session_id}/result", response_model=SessionResultResponse)
async def get_session_result(session_id: str, current_user: CurrentUser, db: DB) -> SessionResultResponse:
    """전체 결과 리포트 조회."""
    session = await _require_completed_session(db, session_id, current_user.id)

    overall_score_result = await db.execute(
        select(Score).where(Score.session_id == session_id, Score.score_type == "overall")
    )
    overall_score = overall_score_result.scalar_one_or_none()

    answers_result = await db.execute(
        select(Answer)
        .where(Answer.session_id == session_id, Answer.status == "analyzed")
        .order_by(Answer.question_order)
    )
    answers = answers_result.scalars().all()

    answer_results: List[AnswerResultResponse] = []
    for answer in answers:
        ar_result = await db.execute(select(AnalysisResult).where(AnalysisResult.answer_id == answer.id))
        ar = ar_result.scalar_one_or_none()

        score_result = await db.execute(
            select(Score).where(Score.answer_id == answer.id, Score.score_type == "per_question")
        )
        score = score_result.scalar_one_or_none()

        question_text = ""
        if answer.question_id:
            q_result = await db.execute(select(Question).where(Question.id == answer.question_id))
            q = q_result.scalar_one_or_none()
            if q:
                question_text = q.question_text

        answer_results.append(_build_answer_result(answer, ar, score, question_text))

    def _f(v) -> Optional[float]:
        return float(v) if v is not None else None

    total = _f(session.total_score)
    grade = score_to_grade(total) if total is not None else None

    return SessionResultResponse(
        session_id=str(session.id),
        session_number=session.session_number,
        job_category=session.job_category,
        total_score=total,
        grade=grade,
        category_scores={
            "logic": _f(overall_score.logic_score) if overall_score else None,
            "specificity": _f(overall_score.specificity_score) if overall_score else None,
            "job_relevance": _f(overall_score.job_relevance_score) if overall_score else None,
            "structure": _f(overall_score.structure_score) if overall_score else None,
            "delivery": _f(overall_score.delivery_score) if overall_score else None,
        },
        overall_feedback=overall_score.overall_feedback if overall_score else None,
        strength_points=None,
        improvement_suggestions=overall_score.improvement_suggestions if overall_score else [],
        timeseries_insight=None,
        answers=answer_results,
    )


@router.get("/{session_id}/result/scores")
async def get_scores_only(session_id: str, current_user: CurrentUser, db: DB):
    """점수만 조회."""
    session = await _require_completed_session(db, session_id, current_user.id)
    result = await db.execute(
        select(Score).where(Score.session_id == session_id, Score.score_type == "overall")
    )
    score = result.scalar_one_or_none()
    if not score:
        raise HTTPException(status_code=404, detail="점수를 찾을 수 없습니다.")
    return {
        "total_score": float(session.total_score) if session.total_score else None,
        "logic": float(score.logic_score) if score.logic_score else None,
        "specificity": float(score.specificity_score) if score.specificity_score else None,
        "job_relevance": float(score.job_relevance_score) if score.job_relevance_score else None,
        "structure": float(score.structure_score) if score.structure_score else None,
        "delivery": float(score.delivery_score) if score.delivery_score else None,
    }


@router.get("/{session_id}/result/answers/{answer_id}", response_model=AnswerResultResponse)
async def get_answer_detail(
    session_id: str, answer_id: str, current_user: CurrentUser, db: DB
) -> AnswerResultResponse:
    """문항별 상세 분석 조회."""
    await _require_completed_session(db, session_id, current_user.id)

    answer_result = await db.execute(
        select(Answer).where(Answer.id == answer_id, Answer.session_id == session_id)
    )
    answer = answer_result.scalar_one_or_none()
    if not answer:
        raise HTTPException(status_code=404, detail="답변을 찾을 수 없습니다.")

    ar_result = await db.execute(select(AnalysisResult).where(AnalysisResult.answer_id == answer_id))
    ar = ar_result.scalar_one_or_none()

    score_result = await db.execute(
        select(Score).where(Score.answer_id == answer_id, Score.score_type == "per_question")
    )
    score = score_result.scalar_one_or_none()

    question_text = ""
    if answer.question_id:
        q = await db.execute(select(Question).where(Question.id == answer.question_id))
        q_obj = q.scalar_one_or_none()
        if q_obj:
            question_text = q_obj.question_text

    return _build_answer_result(answer, ar, score, question_text)


@router.get("/{session_id}/result/timeseries", response_model=TimeseriesResponse)
async def get_timeseries(session_id: str, current_user: CurrentUser, db: DB) -> TimeseriesResponse:
    """시계열 긴장도 데이터 조회."""
    await _require_completed_session(db, session_id, current_user.id)

    answers_result = await db.execute(
        select(Answer)
        .where(Answer.session_id == session_id, Answer.status == "analyzed")
        .order_by(Answer.question_order)
    )
    answers = answers_result.scalars().all()

    combined: list = []
    offset = 0.0
    for answer in answers:
        ar_result = await db.execute(select(AnalysisResult).where(AnalysisResult.answer_id == answer.id))
        ar = ar_result.scalar_one_or_none()
        if ar and ar.timeseries_data:
            ts_data = ar.timeseries_data.get("data", [])
            duration = float(answer.audio_duration_sec or 0)
            for point in ts_data:
                combined.append({
                    **point,
                    "time_sec": round(point["time_sec"] + offset, 1),
                    "answer_order": answer.question_order,
                })
            offset += duration

    return TimeseriesResponse(session_id=session_id, data=combined)
