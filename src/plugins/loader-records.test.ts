import { afterEach, describe, expect, it, vi } from "vitest";
import { createPluginRecord, recordPluginError } from "./loader-records.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";

function recordError(error: Error, origin: "global" | "bundled", missingDependencyHint?: string) {
  const id = origin === "global" ? "broken-plugin" : "discord";
  const record = createPluginRecord({
    id,
    source: `/tmp/${id}/index.js`,
    origin,
    enabled: true,
    configSchema: false,
  });
  recordPluginError({
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    registry: createEmptyPluginRegistry(),
    record,
    seenIds: new Map(),
    phase: "load",
    error,
    logPrefix: "",
    diagnosticMessagePrefix: "",
    missingDependencyHint,
  });
  return record.error;
}

describe("plugin loader records", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    { diagnostics: "", expected: "Error: boom" },
    { diagnostics: "1", expected: "Error: boom\n    at plugin-entry.ts:1:1" },
  ])("uses lifecycle tracing for loader error stacks", ({ diagnostics, expected }) => {
    vi.stubEnv("OPENCLAW_PLUGIN_LIFECYCLE_TRACE", diagnostics);
    const error = new Error("boom");
    error.stack = "Error: boom\n    at plugin-entry.ts:1:1";

    expect(recordError(error, "global")).toBe(expected);
  });

  it.each([
    {
      name: "names the install path when a missing module sits on the error cause",
      error: new Error("import failed", {
        cause: Object.assign(new Error("Cannot find module 'discord-api-types/v10'"), {
          code: "MODULE_NOT_FOUND",
        }),
      }),
      expected: "install @openclaw/discord (Error: import failed)",
    },
    {
      name: "keeps unrelated failures verbatim",
      error: new Error("boom"),
      expected: "Error: boom",
    },
    {
      name: "survives a nested throwing code accessor without rethrowing",
      error: new Error("wrapped", {
        cause: Object.defineProperty(new Error("nested"), "code", {
          get(): never {
            throw new Error("code exploded");
          },
        }),
      }),
      expected: "Error: wrapped",
    },
    {
      name: "survives a throwing cause accessor without rethrowing",
      error: Object.defineProperty(new Error("hostile"), "cause", {
        get(): never {
          throw new Error("cause exploded");
        },
      }),
      expected: "Error: hostile",
    },
  ])("$name", ({ error, expected }) => {
    expect(recordError(error, "bundled", "install @openclaw/discord")).toBe(expected);
  });
});
