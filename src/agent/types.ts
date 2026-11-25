import type { RawLibErrorShape } from "../core/errors";
import type { Op, PipelineStep, Query, Where } from "../core/types/query";
import type { Result } from "../core/types/result";

export type AgentField = {
  type?: string;
  description?: string;
  values?: string[];
  /** Excluded from descriptions and never selectable when marked sensitive. */
  sensitive?: boolean;
};

export type AgentRelation = {
  entity: string;
  field: string;
  description?: string;
};

export type AgentEntity = {
  description?: string;
  fields?: Record<string, AgentField | string>;
  relations?: Record<string, AgentRelation>;
  /** Optional sample used to infer fields when `fields` is omitted. */
  sample?: Record<string, unknown>;
};

export type AgentEntities = Record<string, AgentEntity>;

export type AgentContext = {
  actor?: string;
  tenant?: string;
  [key: string]: unknown;
};

export type AgentPolicy = {
  /** Operations the model may request. Defaults to read-only operations. */
  allowOps?: Op[];
  /** Entity allowlist. Defaults to every configured entity. */
  allowEntities?: string[] | "*";
  /** Fields that may never be referenced in a query. */
  denyFields?: Record<string, string[]>;
  /** Fields returned to the model as `[redacted]`. */
  redactFields?: Record<string, string[]>;
  /** Trusted server-side filter injected into every query. */
  tenantScope?: (context: AgentContext) => Where<any> | Promise<Where<any>>;
  /** Maximum page size. Defaults to 50. */
  maxLimit?: number;
  /** Maximum pipeline stages. Defaults to 6. */
  maxPipelineStages?: number;
  /** Maximum rows returned to the model. Defaults to 50. */
  maxRows?: number;
  /** Execution timeout per tool call. Defaults to 5000ms. */
  timeoutMs?: number;
  /** Operations that need an explicit approval callback. Defaults to writes. */
  requireApproval?: Op[];
  budget?: {
    /** Defaults to 8. */
    maxToolCalls?: number;
    /** Defaults to 20_000. */
    maxTokens?: number;
  };
};

export type NormalizedAgentPolicy = {
  allowOps: ReadonlySet<Op>;
  allowEntities: "*" | ReadonlySet<string>;
  denyFields: Readonly<Record<string, readonly string[]>>;
  redactFields: Readonly<Record<string, readonly string[]>>;
  tenantScope?: (context: AgentContext) => Where<any> | Promise<Where<any>>;
  maxLimit: number;
  maxPipelineStages: number;
  maxRows: number;
  timeoutMs: number;
  requireApproval: ReadonlySet<Op>;
  budget: { maxToolCalls: number; maxTokens: number };
};

export type ApprovalRequest = {
  runId: string;
  op: Op;
  entity: string;
  query: Query<any>;
  context: AgentContext;
};

export type ApprovalCallback = (request: ApprovalRequest) => Promise<boolean> | boolean;

export type AgentUsage = {
  inputTokens: number;
  outputTokens: number;
};

export type AgentMessage = {
  role: "user" | "assistant" | "tool";
  content: string;
  name?: string;
  toolCallId?: string;
  toolCalls?: AgentToolCall[];
};

export type AgentToolCall = {
  id: string;
  name: string;
  arguments: Record<string, unknown> | string;
};

export type AgentToolDefinition = {
  name: string;
  description: string;
  /** JSON Schema object for the tool arguments. */
  parameters: Record<string, unknown>;
};

export type AgentModelInput = {
  system: string;
  messages: AgentMessage[];
  tools: AgentToolDefinition[];
  signal?: AbortSignal;
};

export type AgentModelResult = {
  text?: string;
  toolCalls?: AgentToolCall[];
  usage?: Partial<AgentUsage>;
};

export interface AgentModel {
  readonly id?: string;
  generate(input: AgentModelInput): Promise<AgentModelResult>;
}

export type AgentStep = {
  index: number;
  type: "model" | "tool";
  text?: string;
  tool?: string;
  input?: unknown;
  output?: unknown;
  error?: RawLibErrorShape;
  tookMs: number;
};

export type AgentCitation = {
  entity: string;
  count?: number;
  ids?: string[];
};

export type AuditOutcome = "answered" | "refused" | "failed";

export type AuditRecord = {
  runId: string;
  actor?: string;
  tenant?: string;
  question: string;
  proposedQuery?: Query<any>;
  query?: Query<any>;
  policyDecisions: string[];
  resultSummary?: { entity?: string; rows: number; tookMs: number };
  tokens: AgentUsage;
  model: string;
  outcome: AuditOutcome;
  createdAt: string;
};

export type AuditSink = {
  record(record: AuditRecord): Promise<unknown> | unknown;
};

export type AgentRunStats = {
  toolCalls: number;
  invalidToolCalls: number;
  repairs: number;
  steps: number;
};

export type AgentAnswer = {
  answer: string;
  outcome: "answered" | "refused";
  query?: Query<any>;
  proposedQuery?: Query<any>;
  data?: unknown;
  citations: AgentCitation[];
  usage: AgentUsage;
  stats: AgentRunStats;
  steps: AgentStep[];
  audit: AuditRecord;
};

export type AgentRunResult = Result<AgentAnswer>;

export type EntityDescription = {
  entity: string;
  description?: string;
  fields: Record<string, AgentField>;
  relations: Record<string, AgentRelation>;
  allowedOps: Op[];
};

export type GuardedQuery = {
  query: Query<any>;
  decisions: string[];
  redactFields: string[];
  requiresApproval: boolean;
};

export type ToolExecution = {
  result: Result<unknown>;
  /** The model-facing payload after redaction and row caps. */
  payload: unknown;
  /** Redacted result value, when the tool executed successfully. */
  data?: unknown;
  proposedQuery?: Query<any>;
  guardedQuery?: Query<any>;
  decisions: string[];
  invalid: boolean;
  rows: number;
  tookMs: number;
};

export type EvalExpected =
  | { kind: "query"; query: Query<any> }
  | { kind: "result"; entity: string; invariants: Record<string, unknown> }
  | { kind: "refusal"; reason: string };

export type EvalCase = {
  id: string;
  question: string;
  context?: AgentContext;
  expected: EvalExpected;
  tags: string[];
};

export type EvalDataset = {
  name: string;
  cases: EvalCase[];
};

export type EvalCaseResult = {
  id: string;
  question: string;
  tags: string[];
  passed: boolean;
  outcome: "answered" | "refused" | "failed";
  failure?: string;
  repairs: number;
  toolCalls: number;
  invalidToolCalls: number;
  usage: AgentUsage;
  latencyMs: number;
  query?: Query<any>;
};

export type EvalMetrics = {
  total: number;
  passed: number;
  executionAccuracy: number;
  schemaValidity: number;
  unsafeRate: number;
  repairRate: number;
  refusalRate: number;
  latencyP50Ms: number;
  latencyP95Ms: number;
  tokens: AgentUsage;
  estimatedCostUsd?: number;
};

export type EvalReport = {
  dataset: string;
  cases: EvalCaseResult[];
  metrics: EvalMetrics;
  createdAt: string;
};

export type EvalOptions = {
  agent?: DataAgent;
  dataset: EvalDataset;
  /** Build a fresh agent per case, useful with scripted mock models. */
  agentForCase?: (testCase: EvalCase) => DataAgent;
  /** Optional per-million-token prices. */
  pricing?: { inputPerMillion?: number; outputPerMillion?: number };
  now?: () => Date;
};

export type DataAgentConfig = {
  db: import("../core/engine/engine").RawQl;
  model: AgentModel;
  policy?: AgentPolicy;
  entities?: AgentEntities;
  approve?: ApprovalCallback;
  audit?: AuditSink;
  systemPrompt?: string;
  /** Model turns before the run fails. Defaults to 8. */
  maxSteps?: number;
  /** Retries after validation, capability, or policy failures. Defaults to 3. */
  maxRepairs?: number;
  now?: () => Date;
};

export interface DataAgent {
  enabled: boolean;
  readonly policy: NormalizedAgentPolicy;
  readonly tools: AgentToolDefinition[];
  run(question: string, context?: AgentContext): Promise<AgentRunResult>;
}

export type PipelineDescription = {
  steps: PipelineStep[];
  stages: number;
};
