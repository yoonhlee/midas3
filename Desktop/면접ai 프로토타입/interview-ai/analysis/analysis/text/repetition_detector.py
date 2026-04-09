"""반복 표현 탐지 모듈 — n-gram + 의미 유사도 기반."""
from collections import Counter
from typing import Any, Dict, List, Tuple

import structlog

logger = structlog.get_logger(__name__)


class RepetitionDetector:
    """n-gram 반복 및 의미적 반복 탐지."""

    SEMANTIC_SIM_THRESHOLD = 0.85
    UNIGRAM_WINDOW = 3          # 인접 N 문장 내 반복 체크
    UNIGRAM_MIN_COUNT = 3       # 최소 반복 횟수

    def __init__(self):
        self._embedder = None

    def _load_embedder(self):
        if self._embedder is not None:
            return
        try:
            from sentence_transformers import SentenceTransformer
            self._embedder = SentenceTransformer("snunlp/KR-SBERT-V40K-klueNLI-augSTS")
            logger.info("Sentence embedder loaded")
        except Exception as e:
            logger.warning("Sentence embedder not available", error=str(e))

    def detect(self, tokens: List[Dict[str, Any]], sentences: List[str]) -> Dict[str, Any]:
        """
        반복 표현 탐지.

        Returns:
            {
                "score": float (0~100, 반복 적을수록 고득점),
                "details": [{type, text, count, positions}]
            }
        """
        details: List[Dict[str, Any]] = []

        # 1. Unigram 반복 탐지
        morphemes = [t["form"] for t in tokens if t["tag"] not in {"SF", "SP", "SS", "SE", "SO"}]
        unigram_reps = self._detect_unigram_repetition(morphemes)
        details.extend(unigram_reps)

        # 2. Bigram 반복 탐지
        bigram_reps = self._detect_ngram_repetition(morphemes, n=2)
        details.extend(bigram_reps)

        # 3. Trigram 반복 탐지
        trigram_reps = self._detect_ngram_repetition(morphemes, n=3)
        details.extend(trigram_reps)

        # 4. 의미적 반복 탐지 (선택적)
        semantic_reps = self._detect_semantic_repetition(sentences)
        details.extend(semantic_reps)

        # 점수 계산 — 반복 항목이 많을수록 감점
        penalty = min(len(details) * 8.0, 60.0)
        score = max(0.0, 100.0 - penalty)

        return {
            "score": round(score, 2),
            "details": details,
        }

    def _detect_unigram_repetition(self, morphemes: List[str]) -> List[Dict[str, Any]]:
        """인접 윈도우 내 같은 형태소 반복 탐지."""
        results = []
        counter: Dict[str, List[int]] = {}
        for idx, m in enumerate(morphemes):
            if m not in counter:
                counter[m] = []
            counter[m].append(idx)

        for form, positions in counter.items():
            if len(positions) >= self.UNIGRAM_MIN_COUNT:
                # 인접 WINDOW 내에 몰려 있는지 확인
                for i in range(len(positions) - self.UNIGRAM_MIN_COUNT + 1):
                    window = positions[i:i + self.UNIGRAM_MIN_COUNT]
                    if window[-1] - window[0] <= self.UNIGRAM_WINDOW * 5:
                        results.append({
                            "type": "unigram",
                            "text": form,
                            "count": len(positions),
                            "positions": positions[:5],
                        })
                        break
        return results

    def _detect_ngram_repetition(self, morphemes: List[str], n: int) -> List[Dict[str, Any]]:
        """n-gram 반복 탐지."""
        if len(morphemes) < n * 2:
            return []

        ngrams = [
            " ".join(morphemes[i:i + n])
            for i in range(len(morphemes) - n + 1)
        ]
        counter = Counter(ngrams)
        results = []
        for gram, count in counter.items():
            if count >= 2:
                positions = [i for i, g in enumerate(ngrams) if g == gram]
                results.append({
                    "type": f"{n}gram",
                    "text": gram,
                    "count": count,
                    "positions": positions[:5],
                })
        return results[:3]  # 상위 3개만

    def _detect_semantic_repetition(self, sentences: List[str]) -> List[Dict[str, Any]]:
        """인접 문장 간 의미적 유사도 기반 반복 탐지."""
        if len(sentences) < 2:
            return []

        self._load_embedder()
        if self._embedder is None:
            return []

        try:
            import numpy as np
            embeddings = self._embedder.encode(sentences, convert_to_numpy=True)

            results = []
            for i in range(len(sentences) - 1):
                for j in range(i + 1, min(i + 3, len(sentences))):
                    a, b = embeddings[i], embeddings[j]
                    sim = float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b) + 1e-8))
                    if sim >= self.SEMANTIC_SIM_THRESHOLD:
                        results.append({
                            "type": "semantic",
                            "text": sentences[i][:50] + "...",
                            "count": 2,
                            "positions": [i, j],
                        })
            return results[:2]
        except Exception as e:
            logger.warning("Semantic repetition detection failed", error=str(e))
            return []
