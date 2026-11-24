import { describe, expect, it } from "vitest";
import { compilePipeline } from "../../src/core/compiler/pipeline";
import { RawLibError } from "../../src/core/errors";

function fails(fn: () => unknown): boolean {
  try {
    fn();
    return false;
  } catch (error) {
    return error instanceof RawLibError && error.code === "VALIDATION_FAILED";
  }
}

describe("compilePipeline validation", () => {
  it("rejects a non-array pipeline", () => {
    expect(fails(() => compilePipeline({} as any))).toBe(true);
  });

  it("rejects non-object steps", () => {
    expect(fails(() => compilePipeline([1 as any]))).toBe(true);
    expect(fails(() => compilePipeline([null as any]))).toBe(true);
  });

  it("requires a non-empty match", () => {
    expect(fails(() => compilePipeline([{ $match: {} }]))).toBe(true);
  });

  it("requires a non-empty sort", () => {
    expect(fails(() => compilePipeline([{ $sort: {} }]))).toBe(true);
  });

  it("validates group specs", () => {
    expect(fails(() => compilePipeline([{ $group: { by: "" } }]))).toBe(true);
    expect(fails(() => compilePipeline([{ $group: { by: 1 as any } }]))).toBe(true);
    expect(fails(() => compilePipeline([{ $group: { by: { role: "" } } }]))).toBe(true);
    expect(fails(() => compilePipeline([{ $group: { by: "role", fields: 1 as any } }]))).toBe(true);
    expect(
      fails(() => compilePipeline([{ $group: { by: "role", fields: { x: 1 as any } } }])),
    ).toBe(true);
    expect(
      fails(() =>
        compilePipeline([{ $group: { by: "role", fields: { x: { op: "nope" as any } } } }]),
      ),
    ).toBe(true);
  });

  it("accepts a valid group spec", () => {
    expect(
      compilePipeline([
        {
          $group: {
            by: { role: "role", plan: "plan" },
            fields: { total: { op: "count" }, oldest: { op: "min", field: "age" } },
          },
        },
      ]),
    ).toEqual([
      {
        $group: {
          by: { role: "role", plan: "plan" },
          fields: { total: { op: "count" }, oldest: { op: "min", field: "age" } },
        },
      },
    ]);
  });

  it("validates lookup specs", () => {
    for (const key of ["from", "localField", "foreignField", "as"]) {
      const spec: Record<string, string> = {
        from: "posts",
        localField: "id",
        foreignField: "userId",
        as: "posts",
      };
      delete spec[key];
      expect(fails(() => compilePipeline([{ $lookup: spec as any }]))).toBe(true);
      expect(fails(() => compilePipeline([{ $lookup: { ...spec, [key]: "" } as any }]))).toBe(true);
    }
  });

  it("compiles nested lookup pipelines", () => {
    expect(
      compilePipeline([
        {
          $lookup: {
            from: "posts",
            localField: "id",
            foreignField: "userId",
            as: "posts",
            pipeline: [{ $match: { published: true } }, { $limit: 2 }],
          },
        },
      ]),
    ).toEqual([
      {
        $lookup: {
          from: "posts",
          localField: "id",
          foreignField: "userId",
          as: "posts",
          pipeline: [
            { $match: { kind: "comparison", field: "published", op: "eq", value: true } },
            { $limit: 2 },
          ],
        },
      },
    ]);
  });

  it("compiles lookup without a pipeline", () => {
    expect(
      compilePipeline([
        { $lookup: { from: "posts", localField: "id", foreignField: "userId", as: "posts" } },
      ]),
    ).toEqual([
      { $lookup: { from: "posts", localField: "id", foreignField: "userId", as: "posts" } },
    ]);
  });

  it("validates unwind specs", () => {
    expect(fails(() => compilePipeline([{ $unwind: "" }]))).toBe(true);
    expect(fails(() => compilePipeline([{ $unwind: 1 as any }]))).toBe(true);
    expect(fails(() => compilePipeline([{ $unwind: {} as any }]))).toBe(true);
    expect(fails(() => compilePipeline([{ $unwind: { path: "" } }]))).toBe(true);
    expect(
      fails(() =>
        compilePipeline([{ $unwind: { path: "tags", preserveNullAndEmptyArrays: "yes" as any } }]),
      ),
    ).toBe(true);
  });

  it("compiles an unwind without the preserve flag", () => {
    expect(compilePipeline([{ $unwind: { path: "tags" } }])).toEqual([
      { $unwind: { path: "tags" } },
    ]);
  });

  it("validates project specs", () => {
    expect(fails(() => compilePipeline([{ $project: [] as any }]))).toBe(true);
    expect(fails(() => compilePipeline([{ $project: { a: 2 as any } }]))).toBe(true);
  });

  it("validates addFields and count", () => {
    expect(fails(() => compilePipeline([{ $addFields: [] as any }]))).toBe(true);
    expect(fails(() => compilePipeline([{ $count: "" }]))).toBe(true);
    expect(fails(() => compilePipeline([{ $count: 1 as any }]))).toBe(true);
  });

  it("validates limit and skip", () => {
    expect(fails(() => compilePipeline([{ $limit: 1.5 }]))).toBe(true);
    expect(fails(() => compilePipeline([{ $limit: "1" as any }]))).toBe(true);
    expect(fails(() => compilePipeline([{ $skip: 1.5 }]))).toBe(true);
  });

  it("returns undefined when no pipeline is provided", () => {
    expect(compilePipeline(undefined)).toBeUndefined();
    expect(compilePipeline([])).toEqual([]);
  });
});
