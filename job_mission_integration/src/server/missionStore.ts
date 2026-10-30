import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { BootstrapResponseSchema } from "../lib/api/contracts.js";
import { buildMissionBootstrapPayload } from "../lib/bootstrap/missionBootstrap.js";

export type MissionBootstrapPayload = ReturnType<typeof buildMissionBootstrapPayload>;
export type CatalogMission = MissionBootstrapPayload["allMissions"][number];

export function resolveInside(base: string, candidate: string) {
  const resolved = path.resolve(base, candidate);
  const normalizedBase = path.resolve(base);
  if (resolved !== normalizedBase && !resolved.startsWith(normalizedBase + path.sep)) {
    throw new Error(`Path escapes base directory: ${candidate}`);
  }
  return resolved;
}

function loadJsonFile<T = unknown>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

// 서버가 가진 미션 카탈로그. 채점은 항상 이 카탈로그의 미션 정의로 한다.
export class MissionStore {
  private payload: MissionBootstrapPayload | null = null;

  constructor(private readonly missionsDir: string, log: (message: string) => void = (m) => console.error(m)) {
    try {
      this.payload = buildMissionBootstrapPayload(missionsDir);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`[bootstrap] failed to preload mission catalog: ${message}`);
    }
  }

  get(): MissionBootstrapPayload | null {
    return this.payload;
  }

  findByKey(key: string | null | undefined): CatalogMission | null {
    if (!key || !this.payload) return null;
    return this.payload.allMissions.find((mission) => mission.key === key) ?? null;
  }

  findById(missionId: string | null | undefined): CatalogMission | null {
    if (!missionId || !this.payload) return null;
    return this.payload.allMissions.find((mission) => mission.mission_id === missionId) ?? null;
  }

  experienceableJobCodes(): Set<string> {
    return new Set((this.payload?.allMissions ?? []).map((mission) => mission.job_code));
  }

  // 관리자 내보내기 뒤 카탈로그를 검증하고 통과하면 교체한다.
  validateAndRefresh() {
    const indexPath = path.join(this.missionsDir, "index.json");
    const index = loadJsonFile<{ missions?: Array<Record<string, any>> }>(indexPath);
    const missions = Array.isArray(index.missions) ? index.missions : [];
    const issues: Array<{ code: string; message: string; path?: string }> = [];
    const keys = new Set<string>();
    const ids = new Set<string>();
    const axes = ["AX1", "AX2", "AX3", "AX4", "AX5"];

    for (const entry of missions) {
      const key = String(entry.key ?? "");
      const missionId = String(entry.mission_id ?? "");
      if (!key) issues.push({ code: "MISSION_KEY_MISSING", message: "Mission index entry is missing key." });
      if (keys.has(key)) issues.push({ code: "MISSION_KEY_DUPLICATE", message: `Duplicate mission key: ${key}` });
      keys.add(key);
      if (!missionId) issues.push({ code: "MISSION_ID_MISSING", message: `Mission ${key || "(unknown)"} is missing mission_id.` });
      if (ids.has(missionId)) issues.push({ code: "MISSION_ID_DUPLICATE", message: `Duplicate mission_id: ${missionId}` });
      ids.add(missionId);

      const relativePath = String(entry.path ?? "");
      let missionPath = "";
      try {
        missionPath = resolveInside(this.missionsDir, relativePath);
      } catch (error) {
        issues.push({ code: "MISSION_PATH_INVALID", message: error instanceof Error ? error.message : String(error), path: relativePath });
        continue;
      }
      if (!fs.existsSync(missionPath)) {
        issues.push({ code: "MISSION_FILE_MISSING", message: `Referenced mission file is missing: ${relativePath}`, path: relativePath });
        continue;
      }

      const signals = entry.axis_signals ?? {};
      for (const axis of axes) {
        const value = Number(signals[axis]);
        if (!Number.isFinite(value) || value < 0) {
          issues.push({ code: "AXIS_SIGNAL_INVALID", message: `${key} has invalid ${axis}.`, path: relativePath });
        }
      }
    }

    const payload = buildMissionBootstrapPayload(this.missionsDir);
    const validated = BootstrapResponseSchema.safeParse(payload);
    if (!validated.success) {
      issues.push({
        code: "BOOTSTRAP_RESPONSE_SCHEMA_MISMATCH",
        message: "Mission bootstrap payload does not match API schema."
      });
    }
    if (issues.length) {
      return { ok: false, issues, jobs: 0, missions: 0 };
    }

    this.payload = payload;
    return {
      ok: true,
      issues,
      jobs: payload.jobDefs.length,
      missions: payload.allMissions.length
    };
  }
}

// 채점에 넘길 미션 정의를 서버 카탈로그에서 만든다(클라이언트가 보낸 기준은 쓰지 않는다).
export function missionToEvaluateInput(mission: CatalogMission) {
  const raw = (mission._raw ?? {}) as Record<string, any>;
  const rawEval = raw.evaluation ?? {};
  return {
    mission_id: mission.mission_id,
    job_name: mission.job_name,
    title: mission.title,
    scenario: mission.scenario,
    task: mission.task,
    axis_signals: mission.axis_signals,
    rubric: mission.rubric,
    expected_insights: Array.isArray(rawEval.expected_insights) ? rawEval.expected_insights.map(String) : [],
    rubric_criteria: Array.isArray(rawEval.rubric)
      ? rawEval.rubric.map((item: Record<string, unknown>) => ({
          criterion: String(item.criterion ?? ""),
          description: String(item.description ?? ""),
          points: Number(item.points ?? 0) || 0
        }))
      : [],
    materials: Array.isArray(raw.mission?.materials) ? raw.mission.materials : []
  };
}

// 채점 당시 미션 내용의 지문. 나중에 미션이 바뀌면 기록에 '이전 버전 미션'으로 표시한다.
export function missionHash(mission: CatalogMission) {
  return createHash("sha256").update(JSON.stringify(mission._raw ?? {})).digest("hex").slice(0, 16);
}
