import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import {
  emitAgentEvent,
  getAgentEventLifecycleGeneration,
  onAgentRuntimeEvent,
  resetAgentEventsForTest,
  withAgentRunLifecycleGeneration,
} from "../infra/agent-events.js";
import { clearAgentRunContext, registerAgentRunContext } from "../infra/agent-run-registry.js";
import { abortChatRunById } from "./chat-abort.js";
import { createAgentEventTestHarness } from "./server-chat.agent-events.test-harness.js";
import { subscribeAgentEvents } from "./server-chat.agent-events.test-helpers.js";
import { registerRpcSourceForTest } from "./server-methods/rpc-source-fixtures.test-support.js";
import type { persistGatewaySessionLifecycleEvent } from "./session-lifecycle-state.js";
import { claimRpcSourceForTest } from "./test-helpers.rpc-source.js";

// mock-isolation: Inject persistence without operator config, SQLite, or restart markers.
vi.mock("../config/io.js", () => ({ getRuntimeConfig: () => ({}) }));
vi.mock("./session-utils-store-worker.js", () => ({
  loadGatewaySessionEntryReadOnlyInWorker: async () => undefined,
}));

const persist = vi.fn<typeof persistGatewaySessionLifecycleEvent>(async () => {});
afterEach(() => resetAgentEventsForTest());
function createHarness(runId: string) {
  resetAgentEventsForTest();
  persist.mockClear();
  const h = createAgentEventTestHarness({ persistGatewaySessionLifecycleEventForEvent: persist });
  const unlisten = subscribeAgentEvents(h.handler);
  onTestFinished(unlisten);
  return Object.assign(h, {
    drain: unlisten.drain,
    publish: (data: Record<string, unknown>) =>
      emitAgentEvent({ runId, stream: "lifecycle", data }),
  });
}

it("reserves the RPC abort terminal before synchronous lifecycle errors", async () => {
  const stopReason = "rpc";
  const runId = "run-abort";
  const h = createHarness(runId);
  const sessionKey = "session-abort";
  const registration = registerRpcSourceForTest({ runId, sessionKey, sessionId: "session-id" });
  registration.initializeTiming();
  onTestFinished(await claimRpcSourceForTest(registration.entry, { executionStarted: false }));
  const observedPhases: unknown[] = [];
  onTestFinished(onAgentRuntimeEvent((event) => observedPhases.push(event.data.phase)));
  await withAgentRunLifecycleGeneration(getAgentEventLifecycleGeneration(), async () => {
    registerAgentRunContext(runId, { sessionKey, sessionId: "session-id" });
    h.register(runId, sessionKey, runId);
    registration.markExecutionStarted();
    h.publish({ phase: "start", startedAt: Date.now() });
    await h.drain();
    registration.controller.signal.addEventListener("abort", () => {
      h.publish({ phase: "error", aborted: true, stopReason: "aborted", executionSettled: true });
      clearAgentRunContext(runId);
    });
    expect(
      abortChatRunById(
        { ...h, removeChatRun: h.chatRunState.registry.remove },
        { runId, sessionKey, stopReason },
      ),
    ).toEqual({ aborted: true });
    expect(observedPhases).toEqual(["start", "error", "end"]);
    for (const data of [
      { phase: "model", provider: null, model: null },
      { phase: "finishing" },
      { phase: "error", aborted: true, stopReason: "aborted", executionSettled: true },
    ]) {
      h.publish(data);
    }
    await h.drain();
  });
  expect(h.agent().map(([, event]) => event)).toMatchObject([
    { seq: 1, data: { phase: "start" } },
    { seq: 3, data: { phase: "end", status: "cancelled", aborted: true, stopReason } },
  ]);
  expect(h.nodeAgent()).toHaveLength(2);
  expect(h.chat().filter(([, event]) => event.state === "aborted")).toHaveLength(1);
  expect(h.clearAgentRunContext).toHaveBeenCalledWith(runId);
  const terminal = persist.mock.lastCall?.[0].event.data;
  expect(terminal).toMatchObject({ phase: "error", executionSettled: true });
});

it.each([false, true])("suppresses post-terminal projections (hidden=%s)", async (hidden) => {
  const runId = "run-single-projection";
  const h = createHarness(runId);
  const sessionKey = "session-single-projection";
  h.sessionEventSubscribers.subscribe("session-observer");
  h.sessionMessageSubscribers.subscribe("message-observer", sessionKey);
  await withAgentRunLifecycleGeneration(getAgentEventLifecycleGeneration(), async () => {
    registerAgentRunContext(runId, { sessionKey, isControlUiVisible: !hidden });
    h.publish({ phase: "end" });
    await h.drain();
    expect(h.changes()).toHaveLength(1);
    for (const data of [{ phase: "end" }, { phase: "start", startedAt: 2 }]) {
      h.publish(data);
      await h.drain();
    }
    expect(h.changes()).toHaveLength(1);
  });
  const agent = hidden ? h.targetedAgent() : h.agent();
  const chat = hidden ? h.targetedChat() : h.chat();
  expect(agent.map(([, event]) => event.data.phase)).toEqual(["end"]);
  expect(chat.map(([, event]) => event.state)).toEqual(["final"]);
  expect(persist).toHaveBeenCalledTimes(2);
  expect(h.clearAgentRunContext).toHaveBeenCalledTimes(2);
});
