"""분석 파이프라인 오케스트레이터.

면접 종료 후 Celery 태스크에서 호출.
Phase 1~4 순서대로 실행하며, 각 단계 실패 시에도 나머지 단계 계속 진행.
"""
import os
import subprocess
from pathlib import Path
from typing import Any, Dict, List, Optional

import structlog

from analysis.audio.confidence_metrics import ConfidenceMetricsCalculator
from analysis.audio.delivery_metrics import DeliveryMetricsCalculator
from analysis.audio.feature_extractor import AudioFeatureExtractor, convert_to_wav
from analysis.feedback.generator import FeedbackGenerator
from analysis.scoring.rubric import EVALUATION_WEIGHTS, score_to_grade
from analysis.scoring.scorer import InterviewScorer
from analysis.stt.transcriber import Transcriber
from analysis.stt.vad import VoiceActivityDetector
from analysis.structure.star_analyzer import STARAnalyzer
from analysis.text.filler_detector import FillerWordDetector
from analysis.text.preprocessor import TextPreprocessor
from analysis.text.repetition_detector import RepetitionDetector
from analysis.text.self_correction_detector import SelfCorrectionDetector
from analysis.timeseries.emotional_tracker import EmotionalTracker

logger = structlog.get_logger(__name__)


class AnalysisPipeline:
    """전체 분석 파이프라인."""

    def __init__(self):
        self.transcriber = Transcriber()
        self.vad = VoiceActivityDetector()
        self.feature_extractor = AudioFeatureExtractor()
        self.preprocessor = TextPreprocessor()
        self.filler_detector = FillerWordDetector()
        self.repetition_detector = RepetitionDetector()
        self.self_correction_detector = SelfCorrectionDetector()
        self.confidence_calculator = ConfidenceMetricsCalculator()
        self.delivery_calculator = DeliveryMetricsCalculator()
        self.emotional_tracker = EmotionalTracker()
        self.star_analyzer = STARAnalyzer()
        self.scorer = InterviewScorer()
        self.feedback_generator = FeedbackGenerator()

    def analyze_answer(
        self,
        audio_path: str,
        question_text: str,
        target_job_keywords: Optional[List[str]] = None,
    ) -> Dict[str, Any]:
        """
        단일 답변 분석 (Phase 1 + 2).

        Returns:
            {
                "transcript_data": dict,
                "vad_segments": list,
                "audio_features_summary": dict,
                "text_analysis": dict,
                "filler_data": dict,
                "repetition_data": dict,
                "self_correction_data": dict,
                "confidence_data": dict,
                "audio_delivery": dict,
                "timeseries": list,
                "star_result": dict,
                "llm_scores": dict,
                "scores": dict,         # 5개 항목 점수
            }
        """
        result: Dict[str, Any] = {}

        # ---- 1-1. VAD ----
        try:
            vad_segments = self.vad.detect(audio_path)
            result["vad_segments"] = vad_segments
        except Exception as e:
            logger.error("VAD failed", error=str(e))
            vad_segments = []
            result["vad_segments"] = vad_segments

        # ---- 1-2. STT ----
        wav_path = audio_path
        try:
            wav_path = convert_to_wav(audio_path)
            transcript_data = self.transcriber.transcribe(wav_path)
            result["transcript_data"] = transcript_data
        except Exception as e:
            logger.error("STT failed", error=str(e))
            transcript_data = {"full_text": "", "segments": [], "language": "ko", "language_probability": 0.0}
            result["transcript_data"] = transcript_data

        # ---- 1-3. 음향 특징 ----
        audio_features: Dict[str, Any] = {}
        try:
            audio_features = self.feature_extractor.extract(wav_path)
            result["audio_features_summary"] = {
                "duration": audio_features["duration"],
                "pitch_mean": audio_features["pitch_mean"],
                "pitch_std": audio_features["pitch_std"],
                "rms_mean": audio_features["rms_mean"],
                "rms_std": audio_features["rms_std"],
            }
        except Exception as e:
            logger.error("Audio feature extraction failed", error=str(e))

        # ---- 1-4. 텍스트 전처리 ----
        text_analysis: Dict[str, Any] = {}
        tokens: list = []
        sentences: list = []
        try:
            text_analysis = self.preprocessor.analyze(transcript_data.get("full_text", ""))
            tokens = text_analysis.get("tokens", [])
            sentences = text_analysis.get("sentences", [])
            result["text_analysis"] = {
                "word_count": text_analysis["word_count"],
                "sentence_count": text_analysis["sentence_count"],
                "avg_sentence_length": text_analysis["avg_sentence_length"],
            }
        except Exception as e:
            logger.error("Text preprocessing failed", error=str(e))

        # ---- 1-5. 추임새 탐지 ----
        filler_data: Dict[str, Any] = {}
        try:
            filler_data = self.filler_detector.detect(transcript_data.get("full_text", ""), tokens)
            result["filler_data"] = filler_data
        except Exception as e:
            logger.error("Filler detection failed", error=str(e))
            filler_data = {"total": 0, "ratio": 0.0, "details": []}

        # ---- 1-6. 반복 표현 ----
        repetition_data: Dict[str, Any] = {}
        try:
            repetition_data = self.repetition_detector.detect(tokens, sentences)
            result["repetition_data"] = repetition_data
        except Exception as e:
            logger.error("Repetition detection failed", error=str(e))
            repetition_data = {"score": 80.0, "details": []}

        # ---- 자기 수정 ----
        self_correction_data: Dict[str, Any] = {}
        try:
            self_correction_data = self.self_correction_detector.detect(transcript_data.get("full_text", ""))
            result["self_correction_data"] = self_correction_data
        except Exception as e:
            logger.error("Self-correction detection failed", error=str(e))
            self_correction_data = {"count": 0, "details": []}

        # ---- 1-7. 자신감 지표 ----
        confidence_data: Dict[str, Any] = {}
        try:
            confidence_data = self.confidence_calculator.calculate(
                audio_features, transcript_data, sentences
            )
            result["confidence_data"] = confidence_data
        except Exception as e:
            logger.error("Confidence metrics failed", error=str(e))
            confidence_data = {
                "end_of_sentence_rms_drop": 0.2,
                "pitch_stability": 0.3,
                "volume_consistency": 0.3,
                "confident_ending_ratio": 0.5,
                "uncertain_ending_ratio": 0.1,
                "ending_details": [],
            }

        # ---- 1-8. 전달력 지표 ----
        audio_delivery: Dict[str, Any] = {}
        try:
            audio_delivery = self.delivery_calculator.calculate(
                transcript_data, audio_features, vad_segments, filler_data, confidence_data
            )
            result["audio_delivery"] = audio_delivery
        except Exception as e:
            logger.error("Delivery metrics failed", error=str(e))
            audio_delivery = {"audio_delivery_score": 65.0}

        # ---- 1-8. 시계열 ----
        timeseries: list = []
        try:
            timeseries = self.emotional_tracker.generate_timeseries(audio_features, transcript_data)
            result["timeseries"] = timeseries
        except Exception as e:
            logger.error("Timeseries generation failed", error=str(e))

        # ---- 1-9. LLM 구조 분석 ----
        star_result: Dict[str, Any] = {}
        llm_scores: Dict[str, Any] = {}
        try:
            answer_text = transcript_data.get("full_text", "")
            star_result = self.star_analyzer.analyze_star(question_text, answer_text)
            llm_scores = self.star_analyzer.analyze_llm_scores(question_text, answer_text)
            result["star_result"] = star_result
            result["llm_scores"] = llm_scores
        except Exception as e:
            logger.error("LLM analysis failed", error=str(e))
            star_result = self.star_analyzer._fallback_star()
            llm_scores = self.star_analyzer._fallback_llm_scores()

        # ---- Phase 2: 점수 산출 ----
        keywords = target_job_keywords or []
        number_count = len(self.preprocessor.get_numbers(transcript_data.get("full_text", "")))
        llm_scores["number_count"] = number_count

        try:
            scores = self.scorer.score_all(
                llm_scores=llm_scores,
                text_metrics=text_analysis,
                audio_delivery=audio_delivery,
                filler_data=filler_data,
                repetition_data=repetition_data,
                star_result=star_result,
                keyword_match_count=self._count_keyword_matches(
                    transcript_data.get("full_text", ""), keywords
                ),
                total_keywords=max(len(keywords), 1),
            )
            result["scores"] = scores
        except Exception as e:
            logger.error("Scoring failed", error=str(e))
            result["scores"] = {}

        return result

    def _count_keyword_matches(self, text: str, keywords: List[str]) -> int:
        if not keywords:
            return 0
        return sum(1 for kw in keywords if kw.lower() in text.lower())

    def run_session_analysis(
        self,
        answers: List[Dict[str, Any]],     # [{audio_path, question_text, question_id}]
        target_job_keywords: Optional[List[str]] = None,
    ) -> Dict[str, Any]:
        """
        면접 세션 전체 분석 (Phase 1~4).

        Returns:
            {
                "per_answer": [분석 결과 리스트],
                "overall_scores": {"logic": float, ...},
                "weighted_total": float,
                "grade": str,
                "overall_feedback": dict,
                "timeseries_combined": list,
            }
        """
        per_answer_results: List[Dict[str, Any]] = []
        all_timeseries: list = []

        # Phase 1+2: 각 문항 분석
        for idx, answer_info in enumerate(answers):
            logger.info("Analyzing answer", order=idx + 1, total=len(answers))
            try:
                analysis = self.analyze_answer(
                    audio_path=answer_info["audio_path"],
                    question_text=answer_info["question_text"],
                    target_job_keywords=target_job_keywords,
                )

                # 피드백 생성
                feedback = self.feedback_generator.generate_per_question(
                    question=answer_info["question_text"],
                    answer_text=analysis.get("transcript_data", {}).get("full_text", ""),
                    scores=analysis.get("scores", {}),
                    analysis={
                        "filler_words": analysis.get("filler_data", {}),
                        "audio_delivery": analysis.get("audio_delivery", {}),
                        "repetition_details": analysis.get("repetition_data", {}),
                        "self_correction_count": analysis.get("self_correction_data", {}).get("count", 0),
                    },
                )
                analysis["feedback"] = feedback
                per_answer_results.append(analysis)

                # 시계열 데이터 오프셋 계산 (이전 답변들의 총 시간)
                offset = sum(
                    r.get("audio_delivery", {}).get("total_duration_sec", 0)
                    for r in per_answer_results[:-1]
                )
                for ts in analysis.get("timeseries", []):
                    all_timeseries.append({
                        **ts,
                        "time_sec": round(ts["time_sec"] + offset, 1),
                        "answer_order": idx + 1,
                    })

            except Exception as e:
                logger.error("Answer analysis failed", order=idx + 1, error=str(e))
                per_answer_results.append({"error": str(e), "scores": {}})

        # Phase 3: 종합 점수
        valid_scores = [r.get("scores", {}) for r in per_answer_results if r.get("scores")]
        if valid_scores:
            overall_scores = {}
            for key in EVALUATION_WEIGHTS:
                vals = [s.get(key, {}).get("score", 0) for s in valid_scores if s.get(key)]
                overall_scores[key] = round(sum(vals) / len(vals), 2) if vals else 0.0
            weighted_total = self.scorer.calculate_weighted_total(overall_scores)
        else:
            overall_scores = {k: 0.0 for k in EVALUATION_WEIGHTS}
            weighted_total = 0.0

        grade = score_to_grade(weighted_total)

        # 종합 피드백
        overall_feedback = self.feedback_generator.generate_overall(
            session_scores=valid_scores,
            session_analyses=[r for r in per_answer_results if not r.get("error")],
            timeseries_data=all_timeseries,
        )

        return {
            "per_answer": per_answer_results,
            "overall_scores": overall_scores,
            "weighted_total": weighted_total,
            "grade": grade,
            "overall_feedback": overall_feedback,
            "timeseries_combined": all_timeseries,
        }


pipeline = AnalysisPipeline()
