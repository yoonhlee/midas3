// 채점 품질 측정(U18): 기준 답안 25개를 여러 번 채점해 반복 일관성, 품질 단계 순서, 사람 점수와의 일치를 잰다.
// npm run eval:quality -- --runs=3 --out=reports/eval-quality.json [--fail] [--limit=5]
// 채점 방식은 서버와 같다(EVAL_MODE, OPENAI_API_KEY). 키가 없으면 휴리스틱, EVAL_MODE=fake면 가짜 채점이라 결과가 항상 같다.
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { evaluateAnswer, getEvalMode } from "../src/lib/evaluator/evaluateAnswer.js";
import { MissionStore, missionToEvaluateInput } from "../src/server/missionStore.js";
import { ROOT_DIR } from "../src/server/config.js";

const AXES = ["AX1", "AX2", "AX3", "AX4", "AX5"] as const;
type Axis = (typeof AXES)[number];
type AxisScores = Partial<Record<Axis, number | null>>;

interface ReferenceItem {
  id: string;
  mission_key: string;
  level: string;
  expected_rank: number;
  answer: string;
  human_scores: AxisScores | null;
}

// 통과 기준(기능 지도 U18): 같은 답을 다시 채점해도 ±1점 안, 품질 단계 순서가 대부분 맞고, 사람 점수와 ±1점 안
export const THRESHOLDS = { repeatWithin1: 0.9, orderConcordance: 0.8, humanWithin1: 0.8, minHumanItems: 10 };

function arg(name: string, fallback: string | null = null) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  return process.argv.includes(`--${name}`) ? "true" : fallback;
}

const mean = (values: number[]) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0);
const round = (value: number, digits = 3) => Math.round(value * 10 ** digits) / 10 ** digits;

// 반복 일관성: (답안, 축)마다 여러 번 채점한 점수의 범위
export function repeatConsistency(runsByItem: Array<Array<Record<Axis, number>>>) {
  const ranges: number[] = [];
  const sds: number[] = [];
  for (const runs of runsByItem) {
    if (runs.length < 2) continue;
    for (const axis of AXES) {
      const values = runs.map((run) => run[axis]);
      const m = mean(values);
      ranges.push(Math.max(...values) - Math.min(...values));
      sds.push(Math.sqrt(mean(values.map((v) => (v - m) ** 2))));
    }
  }
  return {
    pairs: ranges.length,
    identical_rate: ranges.length ? round(ranges.filter((r) => r === 0).length / ranges.length) : null,
    within1_rate: ranges.length ? round(ranges.filter((r) => r <= 1).length / ranges.length) : null,
    mean_sd: ranges.length ? round(mean(sds)) : null
  };
}

// 품질 단계 순서: 같은 미션 안에서 기대 순위가 높은 답이 점수도 높으면(같으면 반) 맞은 쌍
export function orderConcordance(items: Array<{ mission_key: string; expected_rank: number; total: number }>) {
  let correct = 0;
  let total = 0;
  const byMission = new Map<string, typeof items>();
  for (const item of items) byMission.set(item.mission_key, [...(byMission.get(item.mission_key) ?? []), item]);
  for (const group of byMission.values()) {
    for (let i = 0; i < group.length; i += 1) {
      for (let j = 0; j < group.length; j += 1) {
        const a = group[i];
        const b = group[j];
        if (a.expected_rank >= b.expected_rank) continue;
        total += 1;
        if (a.total > b.total) correct += 1;
        else if (a.total === b.total) correct += 0.5;
      }
    }
  }
  return { pairs: total, concordance: total ? round(correct / total) : null };
}

// 사람 점수 일치: 사람이 매긴 축만 비교(null은 건너뜀)
export function humanAgreement(pairs: Array<{ human: AxisScores; model: Record<Axis, number> }>) {
  const diffs: number[] = [];
  const perAxis = Object.fromEntries(AXES.map((axis) => [axis, [] as number[]])) as Record<Axis, number[]>;
  for (const { human, model } of pairs) {
    for (const axis of AXES) {
      const h = human[axis];
      if (h === null || h === undefined || !Number.isFinite(Number(h))) continue;
      const d = Math.abs(Number(h) - model[axis]);
      diffs.push(d);
      perAxis[axis].push(d);
    }
  }
  return {
    items: pairs.length,
    compared_scores: diffs.length,
    exact_rate: diffs.length ? round(diffs.filter((d) => d < 0.5).length / diffs.length) : null,
    within1_rate: diffs.length ? round(diffs.filter((d) => d <= 1).length / diffs.length) : null,
    mae: diffs.length ? round(mean(diffs)) : null,
    mae_by_axis: Object.fromEntries(AXES.map((axis) => [axis, perAxis[axis].length ? round(mean(perAxis[axis])) : null]))
  };
}

async function main() {
  const runs = Math.max(1, Math.min(10, Number(arg("runs", "3")) || 3));
  const limit = Number(arg("limit", "0")) || 0;
  const failOnThreshold = arg("fail") === "true";
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const outPath = path.resolve(ROOT_DIR, arg("out", `reports/eval-quality-${date}.json`)!);
  const refPath = path.resolve(ROOT_DIR, arg("ref", "data/eval/reference_answers.json")!);

  const reference = JSON.parse(fs.readFileSync(refPath, "utf8")) as { items: ReferenceItem[] };
  const items = limit ? reference.items.slice(0, limit) : reference.items;
  const store = new MissionStore(path.join(ROOT_DIR, "missions"));
  const mode = getEvalMode();
  console.log(`채점 품질 측정: 기준 답안 ${items.length}개 × ${runs}회, 채점 방식 ${mode}${process.env.OPENAI_API_KEY ? "" : " (OpenAI 키 없음)"}`);

  const results: Array<{
    id: string;
    mission_key: string;
    level: string;
    expected_rank: number;
    source: string;
    runs: Array<Record<Axis, number>>;
    mean: Record<Axis, number>;
    total: number;
    human_scores: AxisScores | null;
  }> = [];
  for (const item of items) {
    const mission = store.findByKey(item.mission_key);
    if (!mission) throw new Error(`카탈로그에 없는 미션: ${item.mission_key}`);
    const input = missionToEvaluateInput(mission);
    const axisRuns: Array<Record<Axis, number>> = [];
    let source = "";
    for (let r = 0; r < runs; r += 1) {
      const result = await evaluateAnswer({ mission: input, answer: item.answer });
      source = String(result.evaluation.source ?? "llm");
      axisRuns.push(Object.fromEntries(AXES.map((axis) => [axis, Number(result.evaluation.axes[axis]?.score) || 0])) as Record<Axis, number>);
    }
    const meanScores = Object.fromEntries(AXES.map((axis) => [axis, round(mean(axisRuns.map((run) => run[axis])), 2)])) as Record<Axis, number>;
    // 미션이 재는 축 비중으로 가중한 총점(품질 순서 비교용)
    const signals = (input.axis_signals ?? {}) as Partial<Record<Axis, number>>;
    const weightSum = AXES.reduce((sum, axis) => sum + (Number(signals[axis]) || 0), 0) || 1;
    const total = round(AXES.reduce((sum, axis) => sum + meanScores[axis] * (Number(signals[axis]) || 0), 0) / weightSum, 3);
    results.push({ id: item.id, mission_key: item.mission_key, level: item.level, expected_rank: item.expected_rank, source, runs: axisRuns, mean: meanScores, total, human_scores: item.human_scores });
    process.stdout.write(".");
  }
  process.stdout.write("\n");

  const repeat = repeatConsistency(results.map((r) => r.runs));
  const order = orderConcordance(results);
  const human = humanAgreement(results.filter((r) => r.human_scores).map((r) => ({ human: r.human_scores as AxisScores, model: r.mean })));
  const checks = {
    repeat: runs < 2 ? "skipped" : (repeat.within1_rate ?? 0) >= THRESHOLDS.repeatWithin1 ? "pass" : "fail",
    order: (order.concordance ?? 0) >= THRESHOLDS.orderConcordance ? "pass" : "fail",
    human: human.items < THRESHOLDS.minHumanItems ? "skipped" : (human.within1_rate ?? 0) >= THRESHOLDS.humanWithin1 ? "pass" : "fail"
  };
  const byLevel = Object.fromEntries([...new Set(results.map((r) => r.level))].map((level) => [level, round(mean(results.filter((r) => r.level === level).map((r) => r.total)), 2)]));
  const report = {
    schema_version: "eval_quality_report.v1",
    created_at: new Date().toISOString(),
    eval_mode: mode,
    runs,
    item_count: results.length,
    thresholds: THRESHOLDS,
    repeat_consistency: repeat,
    level_order: { ...order, mean_total_by_level: byLevel },
    human_agreement: human,
    checks,
    items: results
  };
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);

  console.log(`반복 일관성: ±1점 안 ${repeat.within1_rate ?? "-"} · 완전히 같음 ${repeat.identical_rate ?? "-"} · 평균 표준편차 ${repeat.mean_sd ?? "-"} → ${checks.repeat}`);
  console.log(`품질 단계 순서: 맞은 쌍 비율 ${order.concordance ?? "-"} (${order.pairs}쌍) · 단계별 평균 ${JSON.stringify(byLevel)} → ${checks.order}`);
  console.log(`사람 점수 일치: ${human.items}개 답안 · ±1점 안 ${human.within1_rate ?? "-"} · 평균 오차 ${human.mae ?? "-"} → ${checks.human}`);
  console.log(`보고서: ${path.relative(ROOT_DIR, outPath)}`);
  if (failOnThreshold && Object.values(checks).includes("fail")) process.exit(1);
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]).endsWith(path.join("scripts", "eval-quality.ts"));
if (isDirectRun) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
