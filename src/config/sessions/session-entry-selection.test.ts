import { describe, expect, it, vi } from "vitest";
import { inheritSessionSelection, SessionLabelOwnerIndex } from "./session-entry-selection.js";
import type { SessionEntry } from "./types.js";

const inherit = (fields: Partial<SessionEntry>) =>
  inheritSessionSelection({ sessionId: "parent", updatedAt: 1, ...fields });

describe("inheritSessionSelection", () => {
  it("inherits canonical user and automatic provenance without the old generation", () => {
    expect(
      inherit({
        authProfileOverride: "openai:work",
        thinkingLevel: "ultra",
      }),
    ).toMatchObject({
      authProfileOverride: "openai:work",
      authProfileOverrideSource: "user",
      thinkingLevel: "ultra",
    });

    const automatic = inherit({
      authProfileOverride: "openai:fallback",
      authProfileOverrideCompactionCount: 0,
    });
    expect(automatic).toMatchObject({
      authProfileOverride: "openai:fallback",
      authProfileOverrideSource: "auto",
    });
    expect(automatic.authProfileOverrideCompactionCount).toBeUndefined();
  });

  it("inherits an explicit configured-default selection", () => {
    expect(inherit({ modelOverrideSource: "default" })).toMatchObject({
      modelOverrideSource: "default",
    });
  });
  it.each([
    { source: "auto" as const, profile: "google-vertex:fallback", inheritedProfile: undefined },
    { source: "user" as const, profile: "openai:work", inheritedProfile: "openai:work" },
  ])(
    "drops fallback model state while preserving only $source auth intent",
    ({ source, profile, inheritedProfile }) => {
      const inherited = inherit({
        providerOverride: "google-vertex",
        modelOverride: "gemini-fallback",
        modelOverrideSource: "auto",
        modelOverrideFallbackOriginProvider: "openai",
        modelOverrideFallbackOriginModel: "gpt-primary",
        agentRuntimeOverride: "vertex-runtime",
        nativeRuntimeConsent: "vertex-runtime",
        contextWindow: "1m",
        authProfileOverride: profile,
        authProfileOverrideSource: source,
        thinkingLevel: "high",
      });

      expect(inherited).toEqual({
        contextWindow: "1m",
        thinkingLevel: "high",
        ...(inheritedProfile
          ? { authProfileOverride: inheritedProfile, authProfileOverrideSource: "user" }
          : {}),
      });
    },
  );
});

describe("SessionLabelOwnerIndex", () => {
  it("indexes the store once and answers repeated conflicts without rescanning entries", () => {
    const labelReads = vi.fn();
    const entry = (sessionId: string, label: string): SessionEntry => ({
      sessionId,
      updatedAt: 1,
      get label() {
        labelReads();
        return label;
      },
    });
    const store = {
      "agent:main:a": entry("a", "Alpha"),
      "agent:main:b": entry("b", "Beta"),
    };
    const index = new SessionLabelOwnerIndex(store);

    expect(labelReads).toHaveBeenCalledTimes(2);
    for (let iteration = 0; iteration < 20; iteration += 1) {
      expect(index.isLabelInUse("Alpha", ["agent:main:b"])).toBe(true);
      expect(index.isLabelInUse("Beta", ["agent:main:b"])).toBe(false);
    }
    expect(labelReads).toHaveBeenCalledTimes(2);
  });
});
