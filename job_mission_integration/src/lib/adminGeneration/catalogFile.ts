import fs from "node:fs";
import path from "node:path";
import { resolveInside } from "../../server/missionStore.js";

// 서비스 미션 카탈로그(missions/index.json + missions/scenarios/) 파일 다루기.
// 관리자 페이지로 추가한 미션은 키가 jobsim_admin_v1__로 시작한다. 그 키만 지울 수 있다.

export const ADMIN_KEY_PREFIX = "jobsim_admin_v1";
const SAFE_NAME = /^[A-Za-z0-9_]+$/;

export function isAdminMissionKey(key: string): boolean {
  return typeof key === "string" && key.startsWith(`${ADMIN_KEY_PREFIX}__`);
}

// 내보내기 스크립트는 경로에서 runs 바로 다음 폴더 이름을 키의 앞부분으로 쓴다.
// 그래서 이름이 고정된 폴더에 미션 파일 하나만 두고 부른다: <outputs>/admin_export/runs/jobsim_admin_v1/jobs/<직업코드>/<난이도>/mission_output.json
export function prepareExportStaging(outputsDir: string, missionFile: string, jobCode: string, difficulty: string): string {
  if (!SAFE_NAME.test(jobCode) || !SAFE_NAME.test(difficulty)) throw new Error(`Invalid export target: ${jobCode} ${difficulty}`);
  const staging = path.join(outputsDir, "admin_export");
  fs.rmSync(staging, { recursive: true, force: true });
  const target = path.join(staging, "runs", ADMIN_KEY_PREFIX, "jobs", jobCode, difficulty, "mission_output.json");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(missionFile, target);
  return staging;
}

interface IndexEntry {
  key?: unknown;
  path?: unknown;
  job_cd?: unknown;
}
interface IndexJob {
  job_cd?: unknown;
  mission_keys?: unknown;
}
interface MissionIndex {
  jobs?: IndexJob[];
  missions?: IndexEntry[];
  [key: string]: unknown;
}

const indexPathOf = (missionsDir: string) => path.join(missionsDir, "index.json");

// 색인은 내보내기 스크립트(Python)가 쓴 모양이다. 숫자를 원래 글자 그대로 두고 읽어(1.0이 1로 바뀌지 않게)
// 다시 쓸 때 고친 줄 말고는 글이 그대로 남게 한다.
function parseKeepingNumbers(text: string): unknown {
  const rawJSON = (JSON as unknown as { rawJSON?: (source: string) => unknown }).rawJSON;
  if (!rawJSON) return JSON.parse(text);
  return JSON.parse(text, (_key, value, context?: { source?: string }) =>
    typeof value === "number" && context?.source ? rawJSON(context.source) : value
  );
}

function readIndex(missionsDir: string): MissionIndex | null {
  try {
    return parseKeepingNumbers(fs.readFileSync(indexPathOf(missionsDir), "utf8")) as MissionIndex;
  } catch {
    return null;
  }
}

// 색인은 임시 파일에 쓴 뒤 이름을 바꿔 넣는다(쓰다 멈춰도 반쯤 쓴 색인이 남지 않게).
function writeTextAtomic(filePath: string, text: string) {
  const temp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temp, text, "utf8");
  fs.renameSync(temp, filePath);
}

const isMissing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";

// strict이면 "없음"(ENOENT)만 빈 목록으로 보고 다른 읽기 오류는 던진다. 바꾸기 전 모습을 잘못 알고 되돌리면 미리 넣은 파일을 지울 수 있다.
function scenarioFiles(missionsDir: string, strict = false): string[] {
  try {
    return fs.readdirSync(path.join(missionsDir, "scenarios"), { withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => entry.name);
  } catch (error) {
    if (strict && !isMissing(error)) throw error;
    return [];
  }
}

export interface CatalogSnapshot {
  indexText: string | null;
  scenarioFiles: string[];
  removed: { file: string; text: string } | null;
}

// 바꾸기 전 모습. keyToRemove를 주면 그 미션 파일의 글도 담는다(빼다 실패하면 되살린다).
// 색인이나 미션 폴더를 "없음" 말고 다른 이유로 읽지 못하면 던진다(그러면 카탈로그를 바꾸지 않는다).
export function snapshotCatalog(missionsDir: string, keyToRemove?: string): CatalogSnapshot {
  let indexText: string | null = null;
  try {
    indexText = fs.readFileSync(indexPathOf(missionsDir), "utf8");
  } catch (error) {
    if (!isMissing(error)) throw error;
    indexText = null;
  }
  let removed: CatalogSnapshot["removed"] = null;
  if (keyToRemove && indexText) {
    const entry = (JSON.parse(indexText) as MissionIndex).missions?.find((item) => item.key === keyToRemove);
    if (entry && typeof entry.path === "string") {
      try {
        const file = resolveInside(missionsDir, entry.path);
        removed = { file, text: fs.readFileSync(file, "utf8") };
      } catch {
        removed = null;
      }
    }
  }
  return { indexText, scenarioFiles: scenarioFiles(missionsDir, true), removed };
}

// 색인을 되쓰고, 그 뒤에 생긴 미션 파일을 지우고, 지운 파일을 되살린다.
export function restoreCatalog(missionsDir: string, snapshot: CatalogSnapshot): void {
  if (snapshot.indexText === null) fs.rmSync(indexPathOf(missionsDir), { force: true });
  else writeTextAtomic(indexPathOf(missionsDir), snapshot.indexText);
  const keep = new Set(snapshot.scenarioFiles);
  for (const name of scenarioFiles(missionsDir)) {
    if (!keep.has(name)) fs.rmSync(path.join(missionsDir, "scenarios", name), { force: true });
  }
  if (snapshot.removed) {
    fs.mkdirSync(path.dirname(snapshot.removed.file), { recursive: true });
    fs.writeFileSync(snapshot.removed.file, snapshot.removed.text, "utf8");
  }
}

export function catalogKeys(missionsDir: string): string[] {
  return (readIndex(missionsDir)?.missions ?? []).map((entry) => String(entry.key ?? ""));
}

// 관리자 페이지로 추가한 미션 하나를 카탈로그에서 뺀다. 관리자 키가 아니면 던진다. 색인에 없으면 false.
export function removeCatalogMission(missionsDir: string, key: string): boolean {
  if (!isAdminMissionKey(key)) throw new Error(`Only missions added from the admin page can be removed: ${key}`);
  const index = readIndex(missionsDir);
  const entry = index?.missions?.find((item) => item.key === key);
  if (!index || !entry) return false;
  const missionFile = typeof entry.path === "string" ? resolveInside(missionsDir, entry.path) : null;
  index.missions = (index.missions ?? []).filter((item) => item.key !== key);
  index.jobs = (index.jobs ?? []).flatMap((job) => {
    const keys = Array.isArray(job.mission_keys) ? (job.mission_keys as unknown[]).map(String) : [];
    if (!keys.includes(key)) return [job];
    const rest = keys.filter((item) => item !== key);
    return rest.length ? [{ ...job, mission_keys: rest }] : []; // 미션이 하나도 안 남은 직업은 뺀다
  });
  writeTextAtomic(indexPathOf(missionsDir), JSON.stringify(index, null, 2));
  if (missionFile) fs.rmSync(missionFile, { force: true });
  return true;
}
