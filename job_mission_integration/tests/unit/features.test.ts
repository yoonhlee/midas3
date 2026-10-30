import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
// 브라우저 모듈(app/)도 순수 함수라 그대로 불러 테스트한다.
// @ts-expect-error 타입 선언이 없는 브라우저 JS 모듈
import { filterJobs, suggestWhenEmpty } from "../../app/common/jobSearch.js";
// @ts-expect-error 타입 선언이 없는 브라우저 JS 모듈
import { pickNextMissions, quoteMatchesSentence, splitSentences, strongestAxis, withJosa } from "../../app/components/resultExtras.js";
import { analyzeRequirementTexts, axesOfSentence, splitRequirementSentences } from "../../src/lib/postings/requirements.js";
import { humanAgreement, orderConcordance, repeatConsistency } from "../../scripts/eval-quality.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const AXES = ["AX1", "AX2", "AX3", "AX4", "AX5"];
const jobsIndex = JSON.parse(fs.readFileSync(path.join(ROOT, "data/jobs/index.json"), "utf8")) as { jobs: Array<Record<string, unknown>> };

// ── 직무 탐색(U04·U04-3) ─────────────────────────────
test("탐색: 537개, 이름 일치가 먼저, 일상어(별칭)로도 찾음, 분야·체험 필터", () => {
  const jobs = jobsIndex.jobs.map((job) => ({ ...job, experienceable: job.code === "K000001080" }));
  assert.equal(jobs.length, 537);
  const byName = filterJobs(jobs, { q: "데이터분석가" });
  assert.equal(byName[0].code, "K000001080");
  const byAlias = filterJobs(jobs, { q: "데이터 사이언티스트" });
  assert.ok(byAlias.some((job: { code: string }) => job.code === "K000001080"), "별칭으로 찾아야 해");
  const field = filterJobs(jobs, { field: "보건·의료직" });
  assert.ok(field.length > 0 && field.every((job: { lrcl: string }) => job.lrcl === "보건·의료직"));
  assert.deepEqual(filterJobs(jobs, { experienceableOnly: true }).map((job: { code: string }) => job.code), ["K000001080"]);
});

test("탐색: 결과가 없으면 필터를 풀었을 때 개수와 비슷한 이름을 제안", () => {
  const jobs = jobsIndex.jobs.map((job) => ({ ...job, experienceable: false }));
  assert.equal(filterJobs(jobs, { q: "간호사", field: "농림어업직" }).length, 0);
  const s = suggestWhenEmpty(jobs, { q: "간호사", field: "농림어업직" });
  assert.ok(s.withoutField > 0);
  const typo = suggestWhenEmpty(jobs, { q: "데이타분석가" });
  assert.ok(typo.similarNames.some((job: { name: string }) => job.name.includes("데이터분석가")));
});

// ── 근거 문장 강조(U19) ───────────────────────────────
test("근거 강조: 문장 나누기와 인용구 일치(정확·부분)", () => {
  const answer = "먼저 4주 데이터를 비교하겠습니다. 어제 수치가 30% 낮은 원인을 가설로 세우겠습니다.\n팀에 보고하겠습니다.";
  const sentences = splitSentences(answer);
  assert.equal(sentences.length, 3);
  assert.ok(quoteMatchesSentence("4주 데이터를 비교", sentences[0]));
  assert.ok(quoteMatchesSentence("어제 수치가 30% 낮은 원인을 가설로", sentences[1]));
  assert.ok(!quoteMatchesSentence("고객 불만을 들어 보겠습니다", sentences[2]));
  assert.ok(!quoteMatchesSentence("", sentences[0]));
});

// ── 다음 미션(U20)·강점(U24)·조사 ───────────────────────
test("다음 미션: 덜 잰 축을 재는 미션을 고르고, 이미 한 미션은 빼기", () => {
  const allMissions = [
    { key: "done", job_code: "A", title: "한 것", axis_signals: { AX1: 0.9, AX5: 0.1 } },
    { key: "m5", job_code: "B", title: "대인", axis_signals: { AX5: 0.7 } },
    { key: "m4", job_code: "A", title: "조직", axis_signals: { AX4: 0.6 } },
    { key: "m1", job_code: "B", title: "분석", axis_signals: { AX1: 0.9 } }
  ];
  const state = {
    selectedJobs: ["A"],
    evaluationLogs: [{ mission_key: "done" }],
    resultSummary: { axisCoverage: { AX1: { totalSignal: 0.9 }, AX2: { totalSignal: 0.2 }, AX3: { totalSignal: 0.3 }, AX4: { measured: false }, AX5: { measured: false } } }
  };
  const { targetAxes, picks } = pickNextMissions({ state, axes: AXES, allMissions });
  assert.deepEqual(targetAxes.sort(), ["AX4", "AX5"]);
  const keys = picks.map((p: { mission: { key: string } }) => p.mission.key);
  assert.ok(keys.includes("m4") && keys.includes("m5"));
  assert.ok(!keys.includes("done"));
  assert.deepEqual(strongestAxis(AXES, { AX1: 3.5, AX2: 1, AX3: 3, AX4: 0, AX5: 0 }), { axis: "AX1", strong: true });
  assert.deepEqual(strongestAxis(AXES, { AX1: 1, AX2: 2, AX3: 0, AX4: 0, AX5: 0 }), { axis: "AX2", strong: false });
  assert.equal(withJosa("정보분석·논리", "이", "가"), "정보분석·논리가");
  assert.equal(withJosa("관찰·탐색", "은", "는"), "관찰·탐색은");
  assert.equal(withJosa("KPI", "을", "를"), "KPI을(를)");
});

// ── 공고 요구역량(U25) ───────────────────────────────
test("요구역량: 문장 나누기, 축 분류, 비중 합 1, 원문 미보관", () => {
  assert.deepEqual(splitRequirementSentences("- SQL로 데이터 추출\n- 고객 상담 응대"), ["SQL로 데이터 추출", "고객 상담 응대"]);
  assert.deepEqual(axesOfSentence("SQL로 데이터 추출").map((h) => h.axis), ["AX1"]);
  assert.deepEqual(axesOfSentence("고객 상담 응대").map((h) => h.axis), ["AX5"]);
  const summary = analyzeRequirementTexts([
    { title: "데이터 분석가", detail: "• 지표 분석\n• 프로젝트 일정 관리\n• 고객 인터뷰" },
    { title: "마케팅 기획 담당" }
  ]);
  assert.equal(summary.generated_from, "title+detail");
  assert.equal(summary.analyzed_postings, 2);
  assert.equal(summary.detail_postings, 1);
  const total = AXES.reduce((sum, axis) => sum + summary.axes[axis as "AX1"].share, 0);
  assert.ok(Math.abs(total - 1) < 0.01);
  assert.ok(summary.axes.AX1.count >= 2);
  assert.ok(!JSON.stringify(summary).includes("인터뷰"), "원문 문장은 남기지 않는다");
  const empty = analyzeRequirementTexts([]);
  assert.equal(empty.axes.AX1.share, 0);
});

// ── 채점 품질 측정(U18) ───────────────────────────────
test("품질 측정: 반복 일관성·품질 순서·사람 점수 일치 계산", () => {
  const same = { AX1: 2, AX2: 1, AX3: 0, AX4: 0, AX5: 0 };
  const repeat = repeatConsistency([[same, same], [same, { ...same, AX1: 4 }]]);
  assert.equal(repeat.pairs, 10);
  assert.equal(repeat.within1_rate, 0.9);
  const order = orderConcordance([
    { mission_key: "m", expected_rank: 1, total: 3 },
    { mission_key: "m", expected_rank: 2, total: 2 },
    { mission_key: "m", expected_rank: 3, total: 2 }
  ]);
  assert.equal(order.pairs, 3);
  assert.equal(order.concordance, 0.833);
  const human = humanAgreement([{ human: { AX1: 3, AX2: null, AX3: 0, AX4: 0, AX5: 0 }, model: { AX1: 1, AX2: 4, AX3: 0, AX4: 1, AX5: 0 } }]);
  assert.equal(human.compared_scores, 4);
  assert.equal(human.within1_rate, 0.75);
  assert.equal(human.mae, 0.75);
});

test("기준 답안 25개: 5개 미션 × 5단계, 모두 서버 카탈로그 미션", () => {
  const ref = JSON.parse(fs.readFileSync(path.join(ROOT, "data/eval/reference_answers.json"), "utf8")) as { items: Array<{ mission_key: string; level: string }> };
  const index = JSON.parse(fs.readFileSync(path.join(ROOT, "missions/index.json"), "utf8")) as { missions: Array<{ key: string }> };
  const keys = new Set(index.missions.map((m) => m.key));
  assert.equal(ref.items.length, 25);
  assert.equal(new Set(ref.items.map((i) => i.mission_key)).size, 5);
  assert.ok(ref.items.every((i) => keys.has(i.mission_key)));
});
