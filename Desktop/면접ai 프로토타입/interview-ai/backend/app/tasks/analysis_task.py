"""분석 태스크 — Celery가 없을 때는 동기 실행 폴백."""
import asyncio
import logging
import os
import sys
from datetime import datetime, timezone
from typing import Any, Dict, List

# analysis 패키지 경로 추가
_analysis_root = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../../../analysis"))
if _analysis_root not in sys.path:
    sys.path.insert(0, _analysis_root)

logger = logging.getLogger(__name__)


def run_analysis_pipeline(session_id: str):
    """분석 파이프라인 실행 — 동기 방식(로컬 개발용)."""
    asyncio.run(_async_analysis(session_id))


async def _async_analysis(session_id: str):
    """실제 분석 로직 (비동기)."""
    from sqlalchemy import select
    from app.core.database import AsyncSessionLocal
    from app.models.answer import Answer
    from app.models.analysis_result import AnalysisResult
    from app.models.interview_session import InterviewSession
    from app.models.question import Question
    from app.models.score import Score

    logger.info(f"Analysis started for session {session_id}")

    async with AsyncSessionLocal() as db:
        session_result = await db.execute(
            select(InterviewSession).where(InterviewSession.id == session_id)
        )
        session = session_result.scalar_one_or_none()
        if not session:
            logger.error(f"Session {session_id} not found")
            return

        answers_result = await db.execute(
            select(Answer)
            .where(Answer.session_id == session_id, Answer.status == "recorded")
            .order_by(Answer.question_order)
        )
        answers = answers_result.scalars().all()

        if not answers:
            session.status = "failed"
            await db.commit()
            return

        # 분석 엔진 로드
        try:
            import sys, os
            sys.path.insert(0, os.path.join(os.path.dirname(__file__), "../../../../analysis"))
            from analysis.pipeline import AnalysisPipeline
            pipeline = AnalysisPipeline()
        except Exception as e:
            logger.error(f"Pipeline load failed: {e}")
            session.status = "failed"
            await db.commit()
            return

        answer_infos = []
        for answer in answers:
            q_text = ""
            if answer.question_id:
                q_res = await db.execute(select(Question).where(Question.id == answer.question_id))
                q = q_res.scalar_one_or_none()
                if q:
                    q_text = q.question_text
            answer_infos.append({"audio_path": answer.audio_file_path, "question_text": q_text})

        # 사용자 키워드
        from app.models.user import User
        user_res = await db.execute(select(User).where(User.id == session.user_id))
        user = user_res.scalar_one_or_none()
        keywords = user.target_job_keywords or [] if user else []

        # 파이프라인 실행 (동기)
        try:
            result_data = pipeline.run_session_analysis(answer_infos, target_job_keywords=keywords)
        except Exception as e:
            logger.error(f"Pipeline execution failed: {e}")
            session.status = "failed"
            await db.commit()
            return

        # DB 저장
        for answer, per_answer in zip(answers, result_data["per_answer"]):
            transcript_data = per_answer.get("transcript_data", {})
            answer.transcript = transcript_data.get("full_text", "")
            answer.transcript_segments = transcript_data.get("segments", [])
            answer.vad_segments = per_answer.get("vad_segments", [])
            answer.status = "analyzed"

            scores = per_answer.get("scores", {})
            audio_delivery = per_answer.get("audio_delivery", {})
            filler_data = per_answer.get("filler_data", {})
            repetition_data = per_answer.get("repetition_data", {})
            self_correction = per_answer.get("self_correction_data", {})
            confidence = per_answer.get("confidence_data", {})
            audio_summary = per_answer.get("audio_features_summary", {})
            text_analysis = per_answer.get("text_analysis", {})
            star_result = per_answer.get("star_result", {})

            ar_check = await db.execute(
                select(AnalysisResult).where(AnalysisResult.answer_id == answer.id)
            )
            ar = ar_check.scalar_one_or_none() or AnalysisResult(answer_id=answer.id)
            ar.word_count = text_analysis.get("word_count")
            ar.sentence_count = text_analysis.get("sentence_count")
            ar.filler_words = filler_data
            ar.repetition_score = repetition_data.get("score")
            ar.repetition_details = {"details": repetition_data.get("details", [])}
            ar.self_correction_count = self_correction.get("count")
            ar.self_correction_details = {"details": self_correction.get("details", [])}
            ar.speech_duration_sec = audio_delivery.get("speech_duration_sec")
            ar.speech_rate_wpm = audio_delivery.get("speech_rate_wps")
            ar.pause_count = audio_delivery.get("pause_count")
            ar.pause_ratio = audio_delivery.get("pause_ratio")
            ar.pitch_mean = audio_summary.get("pitch_mean")
            ar.pitch_std = audio_summary.get("pitch_std")
            ar.rms_mean = audio_summary.get("rms_mean")
            ar.rms_std = audio_summary.get("rms_std")
            ar.end_of_sentence_rms_drop = confidence.get("end_of_sentence_rms_drop")
            ar.confident_ending_ratio = confidence.get("confident_ending_ratio")
            ar.uncertain_ending_ratio = confidence.get("uncertain_ending_ratio")
            ar.ending_details = {"details": confidence.get("ending_details", [])}
            ar.star_score = star_result
            ar.timeseries_data = {"data": per_answer.get("timeseries", [])}
            ar.raw_audio_features = audio_summary
            db.add(ar)

            feedback = per_answer.get("feedback", {})
            pq_score = Score(
                session_id=session.id,
                answer_id=answer.id,
                logic_score=scores.get("logic", {}).get("score"),
                specificity_score=scores.get("specificity", {}).get("score"),
                job_relevance_score=scores.get("job_relevance", {}).get("score"),
                structure_score=scores.get("structure", {}).get("score"),
                delivery_score=scores.get("delivery", {}).get("score"),
                weighted_total=scores.get("weighted_total"),
                logic_feedback=feedback.get("logic_feedback"),
                specificity_feedback=feedback.get("specificity_feedback"),
                job_relevance_feedback=feedback.get("job_relevance_feedback"),
                structure_feedback=feedback.get("structure_feedback"),
                delivery_feedback=feedback.get("delivery_feedback"),
                score_type="per_question",
            )
            db.add(pq_score)

        overall_feedback = result_data.get("overall_feedback", {})
        overall_scores = result_data.get("overall_scores", {})
        overall_score = Score(
            session_id=session.id,
            answer_id=None,
            logic_score=overall_scores.get("logic"),
            specificity_score=overall_scores.get("specificity"),
            job_relevance_score=overall_scores.get("job_relevance"),
            structure_score=overall_scores.get("structure"),
            delivery_score=overall_scores.get("delivery"),
            weighted_total=result_data.get("weighted_total"),
            overall_feedback=overall_feedback.get("overall_feedback"),
            improvement_suggestions=overall_feedback.get("improvement_suggestions", []),
            score_type="overall",
        )
        db.add(overall_score)

        session.status = "completed"
        session.total_score = result_data.get("weighted_total")
        session.analysis_completed_at = datetime.now(timezone.utc)
        await db.commit()
        logger.info(f"Analysis completed for session {session_id}, score={session.total_score}")
