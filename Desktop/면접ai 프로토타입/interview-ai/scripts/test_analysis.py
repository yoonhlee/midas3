"""분석 파이프라인 단독 테스트 스크립트.

실행: python scripts/test_analysis.py --audio path/to/audio.wav --question "질문 텍스트"
"""
import argparse
import json
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "../analysis"))

def main():
    parser = argparse.ArgumentParser(description="분석 파이프라인 테스트")
    parser.add_argument("--audio", required=True, help="오디오 파일 경로")
    parser.add_argument("--question", default="지원하신 직무에서 가장 어려웠던 프로젝트 경험을 말씀해 주세요.")
    parser.add_argument("--keywords", nargs="*", default=[], help="직무 키워드 목록")
    args = parser.parse_args()

    if not os.path.exists(args.audio):
        print(f"오디오 파일을 찾을 수 없습니다: {args.audio}")
        sys.exit(1)

    print(f"분석 시작: {args.audio}")
    print(f"질문: {args.question[:60]}...")

    from analysis.pipeline import AnalysisPipeline
    pipeline = AnalysisPipeline()
    result = pipeline.analyze_answer(
        audio_path=args.audio,
        question_text=args.question,
        target_job_keywords=args.keywords,
    )

    print("\n=== 전사 결과 ===")
    print(result.get("transcript_data", {}).get("full_text", "(없음)"))

    print("\n=== 점수 ===")
    scores = result.get("scores", {})
    for key, val in scores.items():
        if isinstance(val, dict) and "score" in val:
            print(f"  {key}: {val['score']:.1f}점")
        elif key == "weighted_total":
            print(f"  [총점]: {val:.1f}점")

    print("\n=== 음성 지표 ===")
    audio = result.get("audio_delivery", {})
    print(f"  답변 시간: {audio.get('total_duration_sec', '-')}초")
    print(f"  발화 속도: {audio.get('speech_rate_wps', '-')} 어절/초")
    print(f"  추임새: {result.get('filler_data', {}).get('total', 0)}회")
    print(f"  pause 비율: {audio.get('pause_ratio', '-')}")

    print("\n전체 결과 (JSON):")
    # numpy/ndarray 제거 후 출력
    safe_result = {
        k: v for k, v in result.items()
        if k not in ("timeseries",) and not hasattr(v, "shape")
    }
    print(json.dumps(safe_result, ensure_ascii=False, indent=2, default=str)[:3000])


if __name__ == "__main__":
    main()
