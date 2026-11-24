import { describe, expect, it } from "vitest";
import { compareFingerprint, hashDevice, type StoredFingerprint } from "../../src/auth/fingerprint";

describe("hashDevice", () => {
  it("hashes identifiers and never stores raw values", async () => {
    const hashed = await hashDevice({ deviceId: "device-1", userAgent: "Agent/1.0" });

    expect(hashed.deviceIdHash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashed.userAgentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashed.deviceIdHash).not.toContain("device-1");
  });

  it("returns null hashes for missing values", async () => {
    expect(await hashDevice()).toEqual({ deviceIdHash: null, userAgentHash: null });
    expect(await hashDevice({})).toEqual({ deviceIdHash: null, userAgentHash: null });
  });
});

describe("compareFingerprint", () => {
  const stored: StoredFingerprint = {
    deviceIdHash: "device-hash",
    userAgentHash: "agent-hash",
  };

  it("treats unbound sessions as pass-through", () => {
    expect(
      compareFingerprint(
        { deviceIdHash: null, userAgentHash: null },
        { deviceIdHash: null, userAgentHash: null },
        "strict",
      ),
    ).toBe("ok");
  });

  it("always allows the off policy", () => {
    expect(compareFingerprint(stored, { deviceIdHash: "other", userAgentHash: null }, "off")).toBe(
      "ok",
    );
  });

  it("strict requires the bound device id", () => {
    expect(compareFingerprint(stored, stored, "strict")).toBe("ok");
    expect(
      compareFingerprint(stored, { deviceIdHash: "other", userAgentHash: "agent-hash" }, "strict"),
    ).toBe("mismatch");
    expect(
      compareFingerprint(stored, { deviceIdHash: null, userAgentHash: "agent-hash" }, "strict"),
    ).toBe("mismatch");
  });

  it("strict falls back to the user agent when no device id was bound", () => {
    const agentOnly: StoredFingerprint = { deviceIdHash: null, userAgentHash: "agent-hash" };

    expect(compareFingerprint(agentOnly, agentOnly, "strict")).toBe("ok");
    expect(
      compareFingerprint(agentOnly, { deviceIdHash: null, userAgentHash: "other" }, "strict"),
    ).toBe("mismatch");
  });

  it("loose accepts either a matching device id or user agent", () => {
    expect(
      compareFingerprint(stored, { deviceIdHash: "device-hash", userAgentHash: null }, "loose"),
    ).toBe("ok");
    expect(
      compareFingerprint(stored, { deviceIdHash: null, userAgentHash: "agent-hash" }, "loose"),
    ).toBe("ok");
    expect(
      compareFingerprint(stored, { deviceIdHash: "other", userAgentHash: "other" }, "loose"),
    ).toBe("mismatch");
    expect(compareFingerprint(stored, { deviceIdHash: null, userAgentHash: null }, "loose")).toBe(
      "mismatch",
    );
  });
});
