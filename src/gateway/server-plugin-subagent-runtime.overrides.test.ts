import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  normalizeAgentCommandModelRef,
  parseAgentCommandModelRef,
} from "../agents/command/model-ref.js";
import { makeModel } from "../agents/embedded-agent-runner/model.test-harness.js";
import { resetConfigRuntimeState, setRuntimeConfigSnapshot } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withPluginRuntimePluginScope } from "../plugins/runtime/gateway-request-scope.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import {
  createGatewaySubagentRuntime,
  resolvePluginSubagentOverridePolicies,
} from "./server-plugin-subagent-runtime.js";

const dispatch = vi.hoisted(() =>
  vi.fn(async (_method: string, _params: Record<string, unknown>) => ({ runId: "override-run" })),
);
vi.mock("./server-plugin-in-process-dispatch.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./server-plugin-in-process-dispatch.js")>()),
  dispatchGatewayMethodInProcess: dispatch,
}));
vi.mock("../agents/provider-model-normalization.runtime.js", () => ({
  normalizeProviderModelIdWithRuntime: (params: {
    provider: string;
    context: { modelId: string };
  }) =>
    params.provider === "fixture"
      ? new Map(Object.entries({ literal: "permitted", permitted: "different" })).get(
          params.context.modelId,
        )
      : undefined,
}));

let config: OpenClawConfig;

beforeEach(() => {
  dispatch.mockClear();
  config = {
    agents: { entries: { worker: { model: "fixture/literal" } } },
    models: {
      providers: {
        fixture: {
          baseUrl: "https://fixture.invalid/v1",
          models: [],
        },
      },
    },
    plugins: {
      entries: {
        "override-fixture": {
          subagent: { allowModelOverride: true, allowedModels: ["fixture/permitted"] },
        },
      },
    },
  };
});

afterEach(() => {
  resetConfigRuntimeState();
  vi.restoreAllMocks();
});

function run(override: { provider?: string; model?: string }) {
  setRuntimeConfigSnapshot(config);
  const context = { getRuntimeConfig: () => config } as GatewayRequestContext;
  const runtime = createGatewaySubagentRuntime(
    () => context,
    resolvePluginSubagentOverridePolicies(config),
  );
  return withPluginRuntimePluginScope({ pluginId: "override-fixture" }, () =>
    runtime.run({
      sessionKey: "agent:worker:subagent:override",
      message: "Use the selected model",
      ...override,
    }),
  );
}

it("checks the exact configured execution target", async () => {
  config.models!.providers!.fixture!.models = [makeModel("literal")];
  await expect(run({ provider: "fixture", model: "literal" })).rejects.toThrow(/not allowlisted/u);
  expect(dispatch).not.toHaveBeenCalled();
});

it("preserves an explicit API owner without configured model rows", async () => {
  config.models!.providers!.fixture!.api = "openai-completions";
  await expect(run({ model: "fixture/literal" })).rejects.toThrow(/not allowlisted/u);
  expect(dispatch).not.toHaveBeenCalled();
});

it.each([{ provider: "fixture", model: "literal" }, { model: "fixture/literal" }])(
  "preserves command selection for %j with chained aliases",
  async (override) => {
    await expect(run(override)).resolves.toMatchObject({ runId: "override-run" });
    const request = dispatch.mock.calls[0]?.[1];
    expect(request).toMatchObject(override);
    const model = request?.model as string;
    const selected = request?.provider
      ? normalizeAgentCommandModelRef(config, request.provider as string, model, {})
      : parseAgentCommandModelRef(config, "worker", model, "", {});
    expect(selected).toEqual({ provider: "fixture", model: "permitted" });
  },
);

it("rejects a replaced configuration before admitting its prepared override", async () => {
  const pending = run({ provider: "fixture", model: "literal" });
  config = { ...config };
  await expect(pending).rejects.toThrow(/configuration changed before admission/u);
  expect(dispatch).not.toHaveBeenCalled();
});
