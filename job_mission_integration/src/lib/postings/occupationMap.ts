import fs from "node:fs";
import { z } from "zod";
import { OCCUPATION_MAP_PATH } from "./config.js";

export const JobCodeSchema = z.string().regex(/^K\d{9}$/);

const Work24CodeSchema = z.object({
  code: z.string().regex(/^\d{6}$/, "고용24 직종코드는 6자리 숫자 문자열이어야 해"),
  name: z.string().min(1)
});

export const OccupationEntrySchema = z.object({
  job_name: z.string().min(1),
  know_keco: z.string(),
  mode: z.enum(["code", "keyword", "tbd"]),
  work24_codes: z.array(Work24CodeSchema),
  keyword: z.string().min(1).nullable(),
  title_include: z.array(z.string()),
  title_exclude: z.array(z.string()),
  relevance_keywords: z.array(z.string()),
  evidence: z.string(),
  // 직종코드 탐색(discover)에 쓰는 후보 키워드. 수집에는 쓰지 않는다.
  discovery_keywords: z.array(z.string()).optional()
}).superRefine((entry, ctx) => {
  if (entry.mode === "code" && entry.work24_codes.length === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "mode=code에는 work24_codes가 1개 이상 필요해" });
  }
  if (entry.mode === "keyword" && !entry.keyword) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "mode=keyword에는 keyword가 필요해" });
  }
});

export const OccupationMapSchema = z.object({
  schema_version: z.literal("occupation_map.v1"),
  updated_at: z.string(),
  jobs: z.record(JobCodeSchema, OccupationEntrySchema)
});

export type OccupationEntry = z.infer<typeof OccupationEntrySchema>;
export type OccupationMap = z.infer<typeof OccupationMapSchema>;

export function parseOccupationMap(raw: unknown): OccupationMap {
  return OccupationMapSchema.parse(raw);
}

export function loadOccupationMap(filePath = OCCUPATION_MAP_PATH): OccupationMap {
  return parseOccupationMap(JSON.parse(fs.readFileSync(filePath, "utf8")));
}

export function saveOccupationMap(map: OccupationMap, filePath = OCCUPATION_MAP_PATH) {
  const validated = parseOccupationMap(map);
  fs.writeFileSync(filePath, `${JSON.stringify(validated, null, 2)}\n`, "utf8");
}
