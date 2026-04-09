"""librosa 기반 음향 특징 추출 모듈."""
import subprocess
from pathlib import Path
from typing import Any, Dict, Optional

import numpy as np
import structlog

logger = structlog.get_logger(__name__)

TARGET_SR = 16000


def convert_to_wav(input_path: str, output_path: Optional[str] = None) -> str:
    """ffmpeg를 사용하여 오디오를 16kHz mono WAV로 변환."""
    if output_path is None:
        output_path = str(Path(input_path).with_suffix("")) + "_16k.wav"

    cmd = [
        "ffmpeg", "-y", "-i", input_path,
        "-ar", str(TARGET_SR),
        "-ac", "1",
        "-f", "wav",
        output_path,
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
        if result.returncode != 0:
            raise RuntimeError(f"ffmpeg 실패: {result.stderr}")
        return output_path
    except FileNotFoundError:
        logger.warning("ffmpeg not found, using input file directly")
        return input_path


class AudioFeatureExtractor:
    """librosa를 사용하여 음향 특징 벡터 추출."""

    def __init__(self, sr: int = TARGET_SR):
        self.sr = sr

    def extract(self, audio_path: str) -> Dict[str, Any]:
        """
        오디오 파일에서 음향 특징 추출.

        Returns:
            {
                "duration": float,
                "rms": np.ndarray,        # 프레임별 RMS
                "f0": np.ndarray,         # 프레임별 기본주파수 (Hz)
                "voiced_flag": np.ndarray,
                "voiced_prob": np.ndarray,
                "non_silent_intervals": list,
                "rms_times": np.ndarray,
                "f0_times": np.ndarray,
                "rms_mean": float,
                "rms_std": float,
                "pitch_mean": float,      # 유성음 구간 F0 평균
                "pitch_std": float,
            }
        """
        import librosa

        try:
            y, sr = librosa.load(audio_path, sr=self.sr, mono=True)
        except Exception as e:
            logger.error("Audio load failed", audio_path=audio_path, error=str(e))
            raise

        duration = librosa.get_duration(y=y, sr=sr)

        # RMS 에너지
        hop_length = 512
        rms = librosa.feature.rms(y=y, hop_length=hop_length)[0]
        rms_times = librosa.times_like(rms, sr=sr, hop_length=hop_length)

        # F0 추출 (pyin 알고리즘)
        f0, voiced_flag, voiced_prob = librosa.pyin(
            y,
            fmin=librosa.note_to_hz("C2"),   # ~65 Hz
            fmax=librosa.note_to_hz("C7"),   # ~2093 Hz
            sr=sr,
            hop_length=hop_length,
        )
        f0_times = librosa.times_like(f0, sr=sr, hop_length=hop_length)

        # 비무음 구간
        non_silent_intervals = librosa.effects.split(y, top_db=25).tolist()

        # 통계
        voiced_f0 = f0[voiced_flag == True] if voiced_flag is not None else np.array([])  # noqa: E712
        pitch_mean = float(np.nanmean(voiced_f0)) if len(voiced_f0) > 0 else 0.0
        pitch_std = float(np.nanstd(voiced_f0)) if len(voiced_f0) > 0 else 0.0
        rms_mean = float(np.mean(rms))
        rms_std = float(np.std(rms))

        return {
            "duration": round(duration, 3),
            "y": y,
            "sr": sr,
            "rms": rms,
            "rms_times": rms_times,
            "f0": f0,
            "f0_times": f0_times,
            "voiced_flag": voiced_flag,
            "voiced_prob": voiced_prob,
            "non_silent_intervals": non_silent_intervals,
            "rms_mean": round(rms_mean, 6),
            "rms_std": round(rms_std, 6),
            "pitch_mean": round(pitch_mean, 2),
            "pitch_std": round(pitch_std, 2),
        }
