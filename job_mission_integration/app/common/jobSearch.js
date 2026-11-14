/* 직무 탐색 필터(U04, U04-2, U04-3). 브라우저에서 바로 거른다. 순수 함수라 단위 테스트한다. */

export function normalize(text) {
  return String(text ?? "").toLowerCase().replace(/[\s·・()\[\]\-_,./]/g, "");
}

function bigrams(text) {
  const value = normalize(text);
  const out = new Set();
  for (let i = 0; i < value.length - 1; i += 1) out.add(value.slice(i, i + 2));
  return out;
}

// 점수: 이름 일치 > 이름 포함 > 별칭(일상어) > 중분류 > 요약
export function scoreJob(job, query) {
  const q = normalize(query);
  if (!q) return 1;
  const name = normalize(job.name);
  if (name === q) return 100;
  if (name.startsWith(q)) return 80;
  if (name.includes(q)) return 70;
  const aliases = (job.aliases || []).map(normalize);
  if (aliases.some((alias) => alias === q)) return 65;
  if (aliases.some((alias) => alias.includes(q) || (q.length >= 2 && q.includes(alias) && alias.length >= 2))) return 55;
  if (normalize(job.mdcl).includes(q)) return 30;
  if (normalize(job.summary).includes(q)) return 15;
  return 0;
}

export function filterJobs(jobs, { q = "", field = "", experienceableOnly = false } = {}) {
  return jobs
    .filter((job) => (!field || job.lrcl === field) && (!experienceableOnly || job.experienceable))
    .map((job) => ({ job, score: scoreJob(job, q) }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || Number(b.job.experienceable) - Number(a.job.experienceable) || a.job.name.localeCompare(b.job.name, "ko"))
    .map((row) => row.job);
}

// 결과가 없을 때 제안: 필터를 풀면 몇 개인지, 글자가 비슷한 직무, 예시 검색어
export function suggestWhenEmpty(jobs, { q = "", field = "", experienceableOnly = false } = {}) {
  const suggestions = { withoutField: 0, withoutExperienceable: 0, similarNames: [], examples: ["마케터", "데이터", "디자이너", "간호사", "공무원", "PD"] };
  if (field) suggestions.withoutField = filterJobs(jobs, { q, experienceableOnly }).length;
  if (experienceableOnly) suggestions.withoutExperienceable = filterJobs(jobs, { q, field }).length;
  const qb = bigrams(q);
  if (qb.size) {
    suggestions.similarNames = jobs
      .map((job) => {
        const nb = bigrams(job.name);
        let hit = 0;
        qb.forEach((g) => { if (nb.has(g)) hit += 1; });
        return { job, ratio: hit / qb.size };
      })
      .filter((row) => row.ratio >= 0.34)
      .sort((a, b) => b.ratio - a.ratio)
      .slice(0, 5)
      .map((row) => ({ code: row.job.code, name: row.job.name }));
  }
  return suggestions;
}
