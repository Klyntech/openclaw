import type { IncomingMessage } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";

const loadConfigMock = vi.fn();
const loadGatewayModelCatalogMock = vi.fn();

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: () => loadConfigMock(),
}));

vi.mock("../config/io.js", () => ({
  getRuntimeConfig: () => loadConfigMock(),
}));

vi.mock("./server-model-catalog.js", () => ({
  loadGatewayModelCatalog: (...args: unknown[]) => loadGatewayModelCatalogMock(...args),
}));

import { resolveOpenAiCompatModelOverride } from "./http-utils.js";

function override(model: string) {
  return resolveOpenAiCompatModelOverride({
    req: { headers: { "x-openclaw-model": model } } as IncomingMessage,
    agentId: "main",
    model: "openclaw",
  });
}

describe("resolveOpenAiCompatModelOverride", () => {
  beforeEach(() => {
    loadConfigMock.mockReset().mockReturnValue({
      agents: {
        ownership: "explicit",
        entries: { main: {}, beta: {} },
        defaults: {
          model: { primary: "openai/gpt-5.4" },
          models: {
            "openai/gpt-5.4": {},
          },
        },
      },
    } satisfies OpenClawConfig);
    loadGatewayModelCatalogMock
      .mockReset()
      .mockResolvedValue([{ id: "gpt-5.4", name: "GPT 5.4", provider: "openai" }]);
  });

  it("keeps provider-wildcard grants separate from a colliding default provider", async () => {
    loadConfigMock.mockReturnValue({
      agents: {
        ownership: "explicit",
        entries: { main: {} },
        defaults: { model: { primary: "Reader" }, modelPolicy: { allow: ["custom/*"] } },
      },
      models: {
        providers: {
          "custom/team": {
            api: "openai-completions",
            baseUrl: "https://fixture.invalid/v1",
            models: [
              {
                id: "Reader",
                name: "Reader",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                maxTokens: 4096,
              },
            ],
          },
        },
      },
    } satisfies OpenClawConfig);
    loadGatewayModelCatalogMock.mockResolvedValue([
      { provider: "custom", id: "team/Reader", name: "Allowed model" },
      { provider: "custom/team", id: "Reader", name: "Other provider default" },
    ]);

    await expect(override("Reader")).resolves.toEqual({
      errorMessage: "Model 'custom/team/Reader' is not allowed for agent 'main'.",
    });
    await expect(override("custom/team/Reader")).resolves.toEqual({
      modelOverride: "custom/team/Reader",
    });
  });

  it("rejects CLI model overrides outside the configured allowlist", async () => {
    await expect(override("claude-cli/opus")).resolves.toEqual({
      errorMessage: "Model 'claude-cli/opus' is not allowed for agent 'main'.",
    });
  });
});
