import fs from "node:fs";
import path from "node:path";
import { resolveInside } from "../../server/missionStore.js";

// 생성기 실행 폴더(outputs/pilot/v1/runs/<폴더>) 읽기. 파일이 없거나 못 읽어도 던지지 않는다.

export const RUNS_SUBDIR = "pilot/v1/runs";
const SAFE_NAME = /^[A-Za-z0-9_]+$/;

// 폴더 이름이 이름 글자만으로 돼 있을 때만 실행 폴더 경로를 준다(../ 같은 값은 null).
export function runDirFor(outputsDir: string, runFolder: string): string | null {
  if (!SAFE_NAME.test(runFolder)) return null;
  return path.join(outputsDir, RUNS_SUBDIR, runFolder);
}

export interface RunArtifacts {
  saved: boolean;
  missionId: string | null;
  missionTitle: string | null;
  missionFile: string | null;
  mission: unknown | null;
  basis: unknown | null;
  failureCode: string | null;
}

function readJson(filePath: string): Record<string, any> | null {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, any>) : null;
  } catch {
    return null;
  }
}

const textOrNull = (value: unknown) => (typeof value === "string" && value ? value : null);

export function readRunArtifacts(runDir: string): RunArtifacts {
  const summary = readJson(path.join(runDir, "pilot_summary.json"));
  const result = Array.isArray(summary?.results) ? (summary!.results[0] as Record<string, unknown> | undefined) : undefined;
  let missionFile: string | null = null;
  const relative = textOrNull(result?.mission_output_path);
  if (relative) {
    try {
      missionFile = resolveInside(runDir, relative); // 실행 폴더 밖은 읽지 않는다
    } catch {
      missionFile = null;
    }
  }
  const mission = missionFile ? readJson(missionFile) : null;
  const basis = missionFile && mission ? readJson(path.join(path.dirname(missionFile), "generation_basis.json")) : null;
  const saved = Number(summary?.saved_count ?? 0) >= 1 && mission !== null;
  const failures = readJson(path.join(runDir, "_failed", "failure_index.json"));
  const firstFailure = Array.isArray(failures?.items) ? (failures!.items[0] as Record<string, unknown> | undefined) : undefined;
  return {
    saved,
    missionId: saved ? textOrNull(mission?.mission_id) ?? textOrNull(result?.mission_id) : null,
    missionTitle: saved ? textOrNull(mission?.mission?.title) : null,
    missionFile: saved ? missionFile : null,
    mission: saved ? mission : null,
    basis: saved ? basis : null,
    failureCode: textOrNull(firstFailure?.reason_code)
  };
}

export type ReviewVerdict = "pass" | "doubt" | "fail" | "review_failed";
const VERDICTS = new Set<ReviewVerdict>(["pass", "doubt", "fail", "review_failed"]);

// 검수 기록(review/<직업코드>_<난이도>.json). 기록이 없거나 판정이 넷 밖이면 review_failed다.
export function readReview(runDir: string, jobCode: string, difficulty: string): { verdict: ReviewVerdict; record: unknown | null } {
  if (!SAFE_NAME.test(jobCode) || !SAFE_NAME.test(difficulty)) return { verdict: "review_failed", record: null };
  const record = readJson(path.join(runDir, "review", `${jobCode}_${difficulty}.json`));
  const verdict = VERDICTS.has(record?.verdict) ? (record!.verdict as ReviewVerdict) : "review_failed";
  return { verdict, record };
}
