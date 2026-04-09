"""Initial schema

Revision ID: 001
Revises:
Create Date: 2024-01-01 00:00:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql
from alembic import op

revision: str = "001"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # users
    op.create_table(
        "users",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("email", sa.String(255), nullable=False),
        sa.Column("password_hash", sa.String(255), nullable=False),
        sa.Column("name", sa.String(100), nullable=False),
        sa.Column("target_job_category", sa.String(100), nullable=True),
        sa.Column("target_job_keywords", postgresql.ARRAY(sa.Text()), nullable=True),
        sa.Column("is_active", sa.Boolean(), server_default="true"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("NOW()")),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("NOW()")),
    )
    op.create_unique_constraint("uq_users_email", "users", ["email"])
    op.create_index("ix_users_email", "users", ["email"])

    # questions
    op.create_table(
        "questions",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("category", sa.String(50), nullable=False),
        sa.Column("subcategory", sa.String(100), nullable=True),
        sa.Column("question_text", sa.Text(), nullable=False),
        sa.Column("expected_star_applicable", sa.Boolean(), server_default="false"),
        sa.Column("difficulty_level", sa.Integer(), server_default="1"),
        sa.Column("job_categories", postgresql.ARRAY(sa.Text()), nullable=True),
        sa.Column("is_active", sa.Boolean(), server_default="true"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("NOW()")),
    )
    op.create_index("ix_questions_category", "questions", ["category"])

    # interview_sessions
    op.create_table(
        "interview_sessions",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("session_number", sa.Integer(), nullable=False),
        sa.Column("job_category", sa.String(100), nullable=True),
        sa.Column("status", sa.String(20), server_default="in_progress"),
        sa.Column("total_score", sa.Numeric(5, 2), nullable=True),
        sa.Column("started_at", sa.DateTime(timezone=True), server_default=sa.text("NOW()")),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("analysis_completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("NOW()")),
    )
    op.create_index("idx_sessions_user", "interview_sessions", ["user_id", "created_at"])

    # answers
    op.create_table(
        "answers",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("session_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("interview_sessions.id", ondelete="CASCADE"), nullable=False),
        sa.Column("question_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("questions.id"), nullable=True),
        sa.Column("question_order", sa.Integer(), nullable=False),
        sa.Column("audio_file_path", sa.String(500), nullable=False),
        sa.Column("audio_duration_sec", sa.Numeric(8, 2), nullable=True),
        sa.Column("transcript", sa.Text(), nullable=True),
        sa.Column("transcript_segments", postgresql.JSONB(), nullable=True),
        sa.Column("vad_segments", postgresql.JSONB(), nullable=True),
        sa.Column("status", sa.String(20), server_default="recorded"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("NOW()")),
    )
    op.create_index("idx_answers_session", "answers", ["session_id", "question_order"])

    # analysis_results
    op.create_table(
        "analysis_results",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("answer_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("answers.id", ondelete="CASCADE"), nullable=False, unique=True),
        sa.Column("word_count", sa.Integer(), nullable=True),
        sa.Column("sentence_count", sa.Integer(), nullable=True),
        sa.Column("filler_words", postgresql.JSONB(), nullable=True),
        sa.Column("repetition_score", sa.Numeric(5, 2), nullable=True),
        sa.Column("repetition_details", postgresql.JSONB(), nullable=True),
        sa.Column("self_correction_count", sa.Integer(), nullable=True),
        sa.Column("self_correction_details", postgresql.JSONB(), nullable=True),
        sa.Column("speech_duration_sec", sa.Numeric(8, 2), nullable=True),
        sa.Column("speech_rate_wpm", sa.Numeric(6, 2), nullable=True),
        sa.Column("pause_count", sa.Integer(), nullable=True),
        sa.Column("pause_ratio", sa.Numeric(5, 4), nullable=True),
        sa.Column("pitch_mean", sa.Numeric(8, 2), nullable=True),
        sa.Column("pitch_std", sa.Numeric(8, 2), nullable=True),
        sa.Column("rms_mean", sa.Numeric(10, 6), nullable=True),
        sa.Column("rms_std", sa.Numeric(10, 6), nullable=True),
        sa.Column("end_of_sentence_rms_drop", sa.Numeric(5, 4), nullable=True),
        sa.Column("confident_ending_ratio", sa.Numeric(5, 4), nullable=True),
        sa.Column("uncertain_ending_ratio", sa.Numeric(5, 4), nullable=True),
        sa.Column("ending_details", postgresql.JSONB(), nullable=True),
        sa.Column("star_score", postgresql.JSONB(), nullable=True),
        sa.Column("timeseries_data", postgresql.JSONB(), nullable=True),
        sa.Column("raw_audio_features", postgresql.JSONB(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("NOW()")),
    )

    # scores
    op.create_table(
        "scores",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("session_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("interview_sessions.id", ondelete="CASCADE"), nullable=False),
        sa.Column("answer_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("answers.id"), nullable=True),
        sa.Column("logic_score", sa.Numeric(5, 2), nullable=True),
        sa.Column("specificity_score", sa.Numeric(5, 2), nullable=True),
        sa.Column("job_relevance_score", sa.Numeric(5, 2), nullable=True),
        sa.Column("structure_score", sa.Numeric(5, 2), nullable=True),
        sa.Column("delivery_score", sa.Numeric(5, 2), nullable=True),
        sa.Column("weighted_total", sa.Numeric(5, 2), nullable=True),
        sa.Column("logic_feedback", sa.Text(), nullable=True),
        sa.Column("specificity_feedback", sa.Text(), nullable=True),
        sa.Column("job_relevance_feedback", sa.Text(), nullable=True),
        sa.Column("structure_feedback", sa.Text(), nullable=True),
        sa.Column("delivery_feedback", sa.Text(), nullable=True),
        sa.Column("overall_feedback", sa.Text(), nullable=True),
        sa.Column("improvement_suggestions", postgresql.ARRAY(sa.Text()), nullable=True),
        sa.Column("score_type", sa.String(20), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("NOW()")),
    )
    op.create_index("idx_scores_session", "scores", ["session_id"])


def downgrade() -> None:
    op.drop_table("scores")
    op.drop_table("analysis_results")
    op.drop_table("answers")
    op.drop_table("interview_sessions")
    op.drop_table("questions")
    op.drop_table("users")
