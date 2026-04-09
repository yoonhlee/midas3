"""대시보드 API."""
from typing import List

from fastapi import APIRouter
from sqlalchemy import select
from sqlalchemy.orm import selectinload

from app.dependencies import CurrentUser, DB
from app.models.analysis_result import AnalysisResult
from app.models.answer import Answer
from app.models.interview_session import InterviewSession
from app.models.score import Score
from app.schemas.dashboard import (
    DashboardMetrics,
    DashboardSummary,
    DashboardTrends,
    MetricTrendPoint,
    TrendPoint,
)

router = APIRouter(prefix="/dashboard", tags=["dashboard"])


@router.get("/summary", response_model=DashboardSummary)
async def get_summary(current_user: CurrentUser, db: DB) -> DashboardSummary:
    """요약 통계 — 총 세션 수, 평균/최고/최신 점수, 추이 방향."""
    sessions_result = await db.execute(
        select(InterviewSession)
        .where(
            InterviewSession.user_id == current_user.id,
            InterviewSession.status == "completed",
        )
        .order_by(InterviewSession.created_at.asc())
    )
    sessions = sessions_result.scalars().all()

    total = len(sessions)
    scores = [float(s.total_score) for s in sessions if s.total_score is not None]

    avg_score = round(sum(scores) / len(scores), 2) if scores else None
    best_score = max(scores) if scores else None
    latest_score = scores[-1] if scores else None

    # 추이 판단 (최근 3개 세션)
    trend = "stable"
    if len(scores) >= 3:
        recent = scores[-3:]
        if recent[-1] > recent[0] + 2:
            trend = "improving"
        elif recent[-1] < recent[0] - 2:
            trend = "declining"

    return DashboardSummary(
        total_sessions=total,
        avg_score=avg_score,
        best_score=best_score,
        latest_score=latest_score,
        score_trend=trend,
    )


@router.get("/trends", response_model=DashboardTrends)
async def get_trends(current_user: CurrentUser, db: DB) -> DashboardTrends:
    """회차별 점수 추이 데이터."""
    sessions_result = await db.execute(
        select(InterviewSession)
        .where(
            InterviewSession.user_id == current_user.id,
            InterviewSession.status == "completed",
        )
        .order_by(InterviewSession.created_at.asc())
    )
    sessions = sessions_result.scalars().all()

    trend_points: List[TrendPoint] = []
    for session in sessions:
        overall_result = await db.execute(
            select(Score).where(
                Score.session_id == session.id,
                Score.score_type == "overall",
            )
        )
        overall = overall_result.scalar_one_or_none()

        def _f(v):
            return float(v) if v is not None else None

        trend_points.append(
            TrendPoint(
                session_number=session.session_number,
                date=session.started_at.strftime("%Y-%m-%d"),
                total_score=_f(session.total_score),
                logic_score=_f(overall.logic_score) if overall else None,
                specificity_score=_f(overall.specificity_score) if overall else None,
                job_relevance_score=_f(overall.job_relevance_score) if overall else None,
                structure_score=_f(overall.structure_score) if overall else None,
                delivery_score=_f(overall.delivery_score) if overall else None,
            )
        )

    return DashboardTrends(score_trends=trend_points)


@router.get("/metrics", response_model=DashboardMetrics)
async def get_metrics(current_user: CurrentUser, db: DB) -> DashboardMetrics:
    """세부 음성/텍스트 지표 추이."""
    sessions_result = await db.execute(
        select(InterviewSession)
        .where(
            InterviewSession.user_id == current_user.id,
            InterviewSession.status == "completed",
        )
        .order_by(InterviewSession.created_at.asc())
    )
    sessions = sessions_result.scalars().all()

    metric_points: List[MetricTrendPoint] = []
    for session in sessions:
        answers_result = await db.execute(
            select(Answer)
            .where(Answer.session_id == session.id, Answer.status == "analyzed")
        )
        answers = answers_result.scalars().all()

        # 문항별 평균 계산
        speech_rates, pause_ratios, filler_ratios, rep_scores, conf_ratios = [], [], [], [], []
        for answer in answers:
            ar_result = await db.execute(
                select(AnalysisResult).where(AnalysisResult.answer_id == answer.id)
            )
            ar = ar_result.scalar_one_or_none()
            if ar:
                if ar.speech_rate_wpm:
                    speech_rates.append(float(ar.speech_rate_wpm))
                if ar.pause_ratio:
                    pause_ratios.append(float(ar.pause_ratio))
                if ar.filler_words and ar.filler_words.get("ratio") is not None:
                    filler_ratios.append(float(ar.filler_words["ratio"]))
                if ar.repetition_score:
                    rep_scores.append(float(ar.repetition_score))
                if ar.confident_ending_ratio:
                    conf_ratios.append(float(ar.confident_ending_ratio))

        def _avg(lst):
            return round(sum(lst) / len(lst), 4) if lst else None

        metric_points.append(
            MetricTrendPoint(
                session_number=session.session_number,
                speech_rate_wps=_avg(speech_rates),
                pause_ratio=_avg(pause_ratios),
                filler_ratio=_avg(filler_ratios),
                repetition_score=_avg(rep_scores),
                confident_ending_ratio=_avg(conf_ratios),
            )
        )

    return DashboardMetrics(metric_trends=metric_points)
