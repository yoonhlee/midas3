import { z } from "zod";
import { AxisSchema, EvaluationSchema, EvidenceSchema } from "../evaluator/schema.js";

export const AxisProfileSchema = z.object({
  AX1: z.number().finite(),
  AX2: z.number().finite(),
  AX3: z.number().finite(),
  AX4: z.number().finite(),
  AX5: z.number().finite()
});

export const MissionScoreSchema = AxisProfileSchema;

export const EvaluateMissionSchema = z.object({
  mission_id: z.string().min(1),
  job_name: z.string().optional(),
  title: z.string().optional(),
  scenario: z.string().optional(),
  task: z.string().optional(),
  axis_signals: AxisProfileSchema.partial().optional(),
  rubric: z.record(z.array(z.string())).optional(),
  rubric_criteria: z.array(z.object({
    criterion: z.string(),
    description: z.string(),
    points: z.number()
  })).optional(),
  expected_insights: z.array(z.string()).optional(),
  materials: z.array(z.object({}).passthrough()).optional()
});

// mission_key가 있으면 서버 카탈로그의 미션으로 채점한다. mission은 예전 클라이언트 호환용이다.
export const EvaluateRequestSchema = z.object({
  mission: EvaluateMissionSchema.optional(),
  mission_key: z.string().min(1).max(200).optional(),
  answer: z.string().trim().min(1).max(3000),
  attempt_id: z.string().uuid().optional(),
  round: z.number().int().min(1).max(5).optional(),
  self_report: z.record(z.unknown()).optional()
}).refine((value) => Boolean(value.mission || value.mission_key), { message: "mission 또는 mission_key가 필요해." });

export const EvaluateResponseSchema = z.object({
  evaluation: EvaluationSchema,
  missionScore: MissionScoreSchema,
  scoring: z.object({
    mode: z.enum(["llm", "fake"]),
    source: z.string(),
    server_mission: z.boolean()
  }).optional(),
  attempt_mission_id: z.string().nullable().optional()
});

const JobCodeSchema = z.string().regex(/^K\d{9}$/);

export const CreateAttemptRequestSchema = z.object({
  job_codes: z.array(JobCodeSchema).min(1).max(3),
  pre_answers: z.record(z.unknown()).optional()
});

export const UpdateAttemptRequestSchema = z.object({
  pre_answers: z.record(z.unknown())
});

// 결과 화면을 다시 그리는 데 필요한 상태(처음 본 결과 화면 그대로 다시 보기)
export const CompleteAttemptRequestSchema = z.object({
  snapshot: z.object({
    selectedJobs: z.array(JobCodeSchema).min(1).max(3),
    preqAnswers: z.record(z.unknown()).default({}),
    missionScores: z.record(z.array(z.record(z.number()))).default({}),
    evaluationLogs: z.array(z.record(z.unknown())).max(30).default([]),
    resultSummary: z.record(z.unknown()).nullable().default(null),
    selfReports: z.record(z.unknown()).default({}),
    retry: z.record(z.unknown()).nullable().default(null)
  }).passthrough()
});

export const MissionScoreRowSchema = AxisProfileSchema.partial();

const RecommendationLogSchema = z.object({
  job_code: z.string().min(1),
  mission_key: z.string().min(1).optional(),
  mission_id: z.string().min(1).optional(),
  mission_title: z.string().min(1),
  answer: z.string().max(3000).optional(),
  self_report: z.record(z.unknown()).default({}),
  evaluation: EvaluationSchema
});

export const RecommendationsRequestSchema = z.object({
  selectedJobs: z.array(z.string().min(1)).min(1),
  missionScoresByJob: z.record(z.array(MissionScoreRowSchema)).default({}),
  evaluationLogs: z.array(RecommendationLogSchema).default([]),
  topN: z.number().int().min(1).max(10).optional()
});

export const RecommendationItemSchema = z.object({
  code: z.string().min(1),
  name: z.string().min(1),
  clusterId: z.string().min(1),
  similarity: z.number().finite(),
  similarityPct: z.number().int().min(0).max(100),
  weights: AxisProfileSchema
});

export const AxisEvidenceSummaryItemSchema = z.object({
  score: z.number().int().min(0).max(4),
  confidence: z.number().min(0).max(1),
  evidence: z.array(EvidenceSchema.extend({
    mission_title: z.string().min(1)
  })),
  flags: z.array(z.string()),
  sources: z.number().int().min(0)
});

export const AxisCoverageItemSchema = z.object({
  totalSignal: z.number().min(0).max(1000),
  missionCount: z.number().int().min(0),
  measured: z.boolean()
});

export const JobInsightSchema = z.object({
  performance: z.number().min(0).max(1),
  emotion: z.number().min(0).max(1),
  compatibility: z.number().int().min(0).max(100),
  quadrant: z.enum(["q1", "q2", "q3", "q4"]),
  topAxis: AxisSchema,
  lowAxis: AxisSchema,
  missionCount: z.number().int().min(0),
  label: z.string().min(1),
  detail: z.string().min(1)
});

export const RecommendationsResponseSchema = z.object({
  axisProfile: AxisProfileSchema,
  similarityProfile: AxisProfileSchema,
  compatibility: z.record(z.number().int().min(0).max(100)),
  selectedJobMeta: z.record(z.object({
    referenceJobName: z.string().nullable(),
    clusterId: z.string().nullable(),
    reliable: z.boolean(),
    silhouette: z.number().nullable(),
    referenceWeights: AxisProfileSchema.nullable()
  })),
  recommendations: z.record(z.array(RecommendationItemSchema)),
  bestMatch: z.object({
    jobCode: z.string().min(1),
    score: z.number().int().min(0).max(100),
    referenceJobName: z.string().min(1),
    referenceWeights: AxisProfileSchema
  }).nullable(),
  axisEvidenceSummary: z.object({
    AX1: AxisEvidenceSummaryItemSchema,
    AX2: AxisEvidenceSummaryItemSchema,
    AX3: AxisEvidenceSummaryItemSchema,
    AX4: AxisEvidenceSummaryItemSchema,
    AX5: AxisEvidenceSummaryItemSchema
  }),
  axisCoverage: z.object({
    AX1: AxisCoverageItemSchema,
    AX2: AxisCoverageItemSchema,
    AX3: AxisCoverageItemSchema,
    AX4: AxisCoverageItemSchema,
    AX5: AxisCoverageItemSchema
  }),
  measuredAxes: z.array(AxisSchema),
  jobInsights: z.record(JobInsightSchema)
});

export const BootstrapResponseSchema = z.object({
  missionsIndex: z.object({}).passthrough(),
  jobDefs: z.array(z.object({
    job_code: z.string().min(1),
    real_job_code: z.string().min(1),
    job_name: z.string().min(1),
    cluster_id: z.string().min(1),
    icon: z.string(),
    desc: z.string()
  })),
  jobInfo: z.record(z.object({
    summary: z.string(),
    tasks: z.array(z.string()),
    skills: z.array(z.string()),
    daily: z.string()
  })),
  allMissions: z.array(z.object({
    mission_id: z.string().min(1),
    key: z.string().min(1),
    job_code: z.string().min(1),
    job_name: z.string().min(1),
    cluster_id: z.string().min(1),
    title: z.string(),
    scenario: z.string(),
    task: z.string(),
    input_type: z.string(),
    options: z.unknown().nullable(),
    is_sjt: z.boolean(),
    axis_signals: AxisProfileSchema.partial(),
    rubric: z.record(z.array(z.string())),
    _raw: z.unknown()
  }).passthrough())
});

export const LogEntrySchema = z.object({
  schema_version: z.number().int().min(1),
  session_id: z.string().min(1),
  created_at: z.string().min(1),
  user_key: z.string().min(1),
  job_code: z.string().min(1),
  mission_key: z.string().min(1).nullable().optional(),
  mission_id: z.string().min(1),
  mission_title: z.string().min(1),
  answer: z.string().max(3000),
  self_report: z.record(z.unknown()).default({}),
  prompt_version: z.string().min(1),
  evaluation: EvaluationSchema,
  mission_score: MissionScoreSchema
}).passthrough();

export const ApiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional()
  })
});

// ── 채용공고 지도(지금 이 일을 뽑는 곳) ─────────────────────
export const JobPostingsParamsSchema = z.object({
  jobCode: z.string().regex(/^K\d{9}$/)
});

export const PostingItemSchema = z.object({
  id: z.string(),
  company: z.string(),
  title: z.string(),
  jobs_cd: z.string(),
  sido: z.string().nullable(),
  sigungu: z.string().nullable(),
  is_metro: z.boolean().nullable(),
  address: z.string(),
  lat: z.number().finite().nullable(),
  lng: z.number().finite().nullable(),
  geo_precision: z.enum(["address", "region", "none"]),
  reg_date: z.string().nullable(),
  close_date: z.string().nullable(),
  close_type: z.enum(["date", "until_filled", "unknown"]),
  salary_text: z.string(),
  company_type: z.enum(["large", "public", "foreign"]).nullable(),
  info_svc: z.string(),
  url: z.string(),
  mobile_url: z.string()
});

export const JobPostingsResponseSchema = z.object({
  status: z.enum(["ok", "empty", "stale", "unmapped", "unconfigured", "error"]),
  job_code: z.string(),
  job_name: z.string().nullable(),
  fetched_at: z.string().nullable(),
  source: z.string(),
  query: z.object({
    mode: z.enum(["code", "keyword", "tbd"]).nullable(),
    occupation: z.array(z.object({ code: z.string(), name: z.string() })),
    keyword: z.string().nullable(),
    regDate: z.string().nullable()
  }),
  counts: z.object({
    kept: z.number().int(),
    metro: z.number().int(),
    nonmetro: z.number().int(),
    region_unknown: z.number().int(),
    geo_address: z.number().int(),
    geo_region: z.number().int(),
    geo_none: z.number().int(),
    by_sido: z.record(z.number().int()),
    company_type: z.object({ large: z.number().int(), public: z.number().int(), foreign: z.number().int() })
  }).nullable(),
  checks: z.object({
    occupation_filter_applied: z.boolean().nullable(),
    regdate_filter_applied: z.boolean(),
    company_type_filter_applied: z.record(z.boolean().nullable())
  }).nullable(),
  items: z.array(PostingItemSchema).max(1000)
});

export const AdminPostingsRefreshRequestSchema = z.object({
  jobCode: z.string().regex(/^K\d{9}$/).optional()
});
