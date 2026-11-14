import fs from "node:fs";
import path from "node:path";

// 관리자 미션 생성에서 고를 수 있는 직업 · 하는 일 문장 · 능력단위 목록.
// 직업별 NCS 파일(data/ncs/jobs/K*.json)의 연결과 직업 카탈로그의 하는 일 문장(duties)을 합친다.
// 고를 수 있는 연결은 Python의 admin_target.link_is_selectable과 같다: 직접, 또는 간접 가운데 분야 한정.

export type LinkKind = "직접" | "분야 한정" | "범위 넓음" | "상위 수준" | "그 밖";

export interface UnitOption {
  unitKey: string;
  unitName: string;
  linkKind: LinkKind;
  selectable: boolean;
  reason: string;
  criteriaRefs: string[];
  counts: { criteria: number; documents: number; considerations: number };
  isDefault: boolean;
}

export interface SentenceItem {
  execJobId: string;
  text: string;
  selectable: boolean;
  blockedReason: null | "OTHER_LINK_ONLY" | "NO_LINK";
  units: UnitOption[];
}

export interface JobItem {
  jobCode: string;
  jobName: string;
  sentenceCount: number;
  selectableSentenceCount: number;
}

export interface SelectedLink {
  jobCode: string;
  jobName: string;
  execJobId: string;
  execJobText: string;
  unitKey: string;
  unitName: string;
  linkKind: "직접" | "분야 한정";
}

// 파일에서 필요한 칸만 기억한다(전체를 그대로 쥐고 있지 않는다).
interface StoredUnit {
  unitKey: string;
  unitName: string;
  execJobId: string;
  execJobText: string;
  linkKind: LinkKind;
  reason: string;
  criteriaRefs: string[];
  documents: number;
  considerations: number;
  order: number;
}

interface StoredJob {
  jobCode: string;
  jobName: string;
  units: StoredUnit[];
}

const KNOWN_INDIRECT: LinkKind[] = ["분야 한정", "범위 넓음", "상위 수준"];

function linkKindOf(link: Record<string, unknown>): LinkKind {
  if (link.match === "직접") return "직접";
  if (link.match === "간접" && KNOWN_INDIRECT.includes(link.indirect_kind as LinkKind)) return link.indirect_kind as LinkKind;
  return "그 밖";
}

const isSelectableKind = (kind: LinkKind) => kind === "직접" || kind === "분야 한정";
const asArray = (value: unknown) => (Array.isArray(value) ? value : []);
const execIdFor = (index: number) => `exec_${String(index + 1).padStart(3, "0")}`;

function readJob(filePath: string): StoredJob | null {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
    const jobCode = String(raw.job_cd ?? path.basename(filePath, ".json"));
    const units = asArray(raw.units).flatMap((item, order) => {
      if (!item || typeof item !== "object") return [];
      const unit = item as Record<string, unknown>;
      const link = (unit.link && typeof unit.link === "object" ? unit.link : {}) as Record<string, unknown>;
      const scope = (unit.scope && typeof unit.scope === "object" ? unit.scope : {}) as Record<string, unknown>;
      return [
        {
          unitKey: String(unit.unit_key ?? ""),
          unitName: String(unit.unit_name ?? ""),
          execJobId: String(unit.exec_job_id ?? ""),
          execJobText: String(unit.exec_job_text ?? ""),
          linkKind: linkKindOf(link),
          reason: String(link.reason ?? ""),
          criteriaRefs: asArray(link.criteria_refs).map(String),
          documents: asArray(scope.documents).length,
          considerations: asArray(scope.considerations).length,
          order
        }
      ];
    });
    return { jobCode, jobName: String(raw.job_name ?? jobCode), units };
  } catch {
    return null; // 못 읽는 파일은 건너뛴다.
  }
}

function compareSelectable(a: StoredUnit, b: StoredUnit) {
  const direct = Number(b.linkKind === "직접") - Number(a.linkKind === "직접");
  return (
    direct ||
    b.criteriaRefs.length - a.criteriaRefs.length ||
    b.documents - a.documents ||
    b.considerations - a.considerations ||
    a.order - b.order
  );
}

function toUnitOptions(units: StoredUnit[]): UnitOption[] {
  const selectable = units.filter((unit) => isSelectableKind(unit.linkKind)).sort(compareSelectable);
  const others = units.filter((unit) => !isSelectableKind(unit.linkKind)).sort((a, b) => a.order - b.order);
  return [...selectable, ...others].map((unit, index) => ({
    unitKey: unit.unitKey,
    unitName: unit.unitName,
    linkKind: unit.linkKind,
    selectable: isSelectableKind(unit.linkKind),
    reason: unit.reason,
    criteriaRefs: unit.criteriaRefs,
    counts: { criteria: unit.criteriaRefs.length, documents: unit.documents, considerations: unit.considerations },
    isDefault: index === 0 && selectable.length > 0
  }));
}

export class NcsCatalog {
  private loaded: Map<string, StoredJob> | null = null;

  constructor(
    private readonly ncsJobsDir: string,
    private readonly dutiesOf: (jobCode: string) => string[] | null
  ) {}

  private store(): Map<string, StoredJob> {
    if (this.loaded) return this.loaded;
    const jobs = new Map<string, StoredJob>();
    let names: string[] = [];
    try {
      names = fs.readdirSync(this.ncsJobsDir).filter((name) => /^K\w+\.json$/.test(name)).sort();
    } catch {
      names = [];
    }
    for (const name of names) {
      const job = readJob(path.join(this.ncsJobsDir, name));
      if (job) jobs.set(job.jobCode, job);
    }
    this.loaded = jobs;
    return jobs;
  }

  jobs(): JobItem[] {
    return [...this.store().values()]
      .map((job) => {
        const sentences = this.sentences(job.jobCode) ?? [];
        return {
          jobCode: job.jobCode,
          jobName: job.jobName,
          sentenceCount: sentences.length,
          selectableSentenceCount: sentences.filter((sentence) => sentence.selectable).length
        };
      })
      .filter((job) => job.selectableSentenceCount > 0)
      .sort((a, b) => a.jobCode.localeCompare(b.jobCode));
  }

  jobName(jobCode: string): string | null {
    return this.store().get(jobCode)?.jobName ?? null;
  }

  sentences(jobCode: string): SentenceItem[] | null {
    const job = this.store().get(jobCode);
    if (!job) return null;
    const duties = this.dutiesOf(jobCode);
    const byExec = new Map<string, StoredUnit[]>();
    for (const unit of job.units) byExec.set(unit.execJobId, [...(byExec.get(unit.execJobId) ?? []), unit]);

    // 문장 순서는 직업 카탈로그의 duties 순서다. n번째 문장의 번호가 exec_00n이다.
    // duties가 없으면 파일에 든 문장만 낸다. duties 밖의 번호가 파일에 있으면 뒤에 붙인다.
    const ordered: Array<{ execJobId: string; text: string }> = (duties ?? []).map((text, index) => ({ execJobId: execIdFor(index), text }));
    const covered = new Set(ordered.map((item) => item.execJobId));
    for (const execJobId of [...byExec.keys()].sort()) {
      if (!covered.has(execJobId)) ordered.push({ execJobId, text: "" });
    }

    return ordered.map(({ execJobId, text }) => {
      const units = byExec.get(execJobId) ?? [];
      const options = toUnitOptions(units);
      const selectable = options.some((option) => option.selectable);
      return {
        execJobId,
        text: units[0]?.execJobText || text,
        selectable,
        blockedReason: units.length === 0 ? "NO_LINK" : selectable ? null : "OTHER_LINK_ONLY",
        units: options
      };
    });
  }

  findSelectable(
    jobCode: string,
    execJobId: string,
    unitKey: string
  ): SelectedLink | { error: "JOB_NOT_FOUND" | "LINK_NOT_FOUND" | "LINK_NOT_SELECTABLE" } {
    const job = this.store().get(jobCode);
    if (!job) return { error: "JOB_NOT_FOUND" };
    const unit = job.units.find((item) => item.execJobId === execJobId && item.unitKey === unitKey);
    if (!unit) return { error: "LINK_NOT_FOUND" };
    if (unit.linkKind !== "직접" && unit.linkKind !== "분야 한정") return { error: "LINK_NOT_SELECTABLE" };
    return {
      jobCode: job.jobCode,
      jobName: job.jobName,
      execJobId,
      execJobText: unit.execJobText,
      unitKey,
      unitName: unit.unitName,
      linkKind: unit.linkKind
    };
  }
}
