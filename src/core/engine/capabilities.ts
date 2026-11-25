import { RawLibError } from "../errors";
import type { Capability } from "../types/capability";
import type { CompiledWhere, NormalizedPipelineStep, NormalizedQuery } from "../types/normalized";

export function requiredCapabilities(query: NormalizedQuery): Set<Capability> {
  const capabilities = new Set<Capability>();

  if (query.where) collectWhere(query.where, capabilities);
  if (query.sort) capabilities.add("sort");
  if (query.select) capabilities.add("select");
  if (query.page) capabilities.add("page.offset");
  if (query.pipeline) {
    for (const step of query.pipeline) collectStep(step, capabilities);
  }

  return capabilities;
}

export function assertCapabilities(
  query: NormalizedQuery,
  available: ReadonlySet<Capability>,
): void {
  const required = requiredCapabilities(query);
  const missing = [...required].filter((capability) => !available.has(capability));

  if (missing.length > 0) {
    throw new RawLibError(
      "UNSUPPORTED_CAPABILITY",
      `Adapter does not support: ${missing.join(", ")}`,
      { missing },
    );
  }
}

function collectWhere(where: CompiledWhere, capabilities: Set<Capability>): void {
  switch (where.kind) {
    case "and":
    case "or":
      capabilities.add("filter.logical");
      for (const clause of where.clauses) collectWhere(clause, capabilities);
      break;
    case "not":
      capabilities.add("filter.logical");
      collectWhere(where.clause, capabilities);
      break;
    case "comparison":
      capabilities.add("filter.comparison");
      break;
    case "array":
      capabilities.add("filter.array");
      break;
    case "text":
      capabilities.add("filter.text");
      break;
    case "presence":
      capabilities.add("filter.presence");
      break;
  }
}

function collectStep(step: NormalizedPipelineStep, capabilities: Set<Capability>): void {
  if ("$match" in step) {
    capabilities.add("pipeline.match");
    collectWhere(step.$match, capabilities);
  } else if ("$group" in step) {
    capabilities.add("pipeline.group");
  } else if ("$sort" in step) {
    capabilities.add("pipeline.sort");
  } else if ("$limit" in step) {
    capabilities.add("pipeline.limit");
  } else if ("$skip" in step) {
    capabilities.add("pipeline.skip");
  } else if ("$project" in step) {
    capabilities.add("pipeline.project");
  } else if ("$lookup" in step) {
    capabilities.add("pipeline.lookup");
    if (step.$lookup.pipeline) {
      for (const nested of step.$lookup.pipeline) collectStep(nested, capabilities);
    }
  } else if ("$unwind" in step) {
    capabilities.add("pipeline.unwind");
  } else if ("$addFields" in step) {
    capabilities.add("pipeline.addFields");
  } else if ("$count" in step) {
    capabilities.add("pipeline.count");
  }
}
