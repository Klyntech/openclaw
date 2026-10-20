/* @vitest-environment jsdom */

import { createSignal, flush, type Setter } from "solid-js";
import { expect, it, vi } from "vitest";
import type {
  AgentsListResult,
  TaskSuggestion,
  TaskSuggestionsAcceptResult,
  TaskSuggestionsListResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError, type GatewayBrowserClient } from "../../api/gateway.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
  type GatewayRequestHandler,
} from "../../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { projectChatFields } from "./chat-field-projection.ts";
import {
  createSessionCapabilityFixture,
  createTestChatPane as createChatPane,
} from "./chat-pane.test-support.ts";
import {
  ChatTaskSuggestionTray,
  type ChatTaskSuggestionTrayProps,
} from "./components/chat-task-suggestions.tsx";

const suggestion: TaskSuggestion = {
  id: "task_123",
  title: "Remove stale adapter",
  prompt: "Delete the stale adapter and update tests.",
  tldr: "The adapter is unreachable and adds maintenance cost.",
  cwd: "/repo",
  sessionKey: "agent:main:current",
  agentId: "main",
  createdAt: 1,
};

function createTestChatPane(client: GatewayBrowserClient) {
  const result = createChatPane({ client, sessions: createSessionCapabilityFixture() });
  const snapshot = result.pane.context.gateway.snapshot;
  snapshot.hello = gatewayHelloForMethods([
    ...(snapshot.hello?.features?.methods ?? []),
    "taskSuggestions.accept",
    "taskSuggestions.dismiss",
  ]);
  result.pane.tasks.suggestions = [suggestion];
  return { ...result, ...createTray(result.pane) };
}

function createRequestPane(handler: GatewayRequestHandler) {
  const request = createGatewayRequestMock(handler);
  return { ...createTestChatPane(createTestGatewayClient(request)), request };
}

function createAcceptancePane(accept: () => unknown, suggestions: TaskSuggestion[] = []) {
  return createRequestPane((method) =>
    method === "taskSuggestions.accept" ? accept() : Promise.resolve({ suggestions }),
  );
}

function createTray(pane: ReturnType<typeof createChatPane>["pane"]) {
  const container = document.createElement("div");
  let setView: Setter<ChatTaskSuggestionTrayProps> | undefined;
  return {
    container,
    acceptance: () =>
      pane.suggestionChatProps(true, false, false).taskSuggestionAcceptance?.(suggestion.id),
    query: <T extends Element = Element>(selector: string) => container.querySelector<T>(selector),
    draw: (connected = true) => {
      const props = pane.suggestionChatProps(connected, false, false);
      if (!setView) {
        const [current, update] = createSignal(props);
        mountSolid(() => <ChatTaskSuggestionTray view={current()} />, { container });
        setView = update;
      } else {
        setView(props);
      }
      flush();
      return props;
    },
  };
}

function sourceRequired(message = "Checkout has no commits") {
  return new GatewayRequestError({
    code: "INVALID_REQUEST",
    message,
    details: { code: "TASK_WORKTREE_SOURCE_REQUIRED" },
  });
}

function acceptCalls(request: ReturnType<typeof createGatewayRequestMock>) {
  return request.mock.calls.filter(([method]) => method === "taskSuggestions.accept");
}

it.each(["confirmed", "failed", "resolved", "session", "connection"] as const)(
  "reconciles a pending dismissal after %s",
  async (outcome) => {
    const dismissed = createDeferred<{ taskId: string; dismissed: boolean }>();
    const listed = createDeferred<TaskSuggestionsListResult>();
    let holdLists = outcome === "confirmed";
    let suggestions = [suggestion];
    const { pane, state, request } = createRequestPane((method) =>
      method === "taskSuggestions.dismiss"
        ? dismissed.promise
        : holdLists
          ? listed.promise
          : Promise.resolve({ suggestions }),
    );
    const mounted = mountSolid(() => {
      projectChatFields(pane.tasks);
      return <ChatTaskSuggestionTray view={pane.suggestionChatProps(true, false, false)} />;
    });
    const card = () => mounted.container.querySelector('[data-task-id="task_123"]');
    expect(card()).not.toBeNull();
    const oldList = outcome === "confirmed" ? pane.refreshTaskSuggestions() : undefined;
    const pending = pane.resolveTaskSuggestion(suggestion, "dismiss");
    flush();
    expect(card()).toBeNull();
    expect(pane.tasks.suggestions).toEqual([]);
    await pane.resolveTaskSuggestion(suggestion, "dismiss");
    expect(
      request.mock.calls.filter(([method]) => method === "taskSuggestions.dismiss"),
    ).toHaveLength(1);
    if (outcome === "confirmed") {
      const pendingList = pane.refreshTaskSuggestions();
      holdLists = false;
      suggestions = [];
      dismissed.resolve({ taskId: suggestion.id, dismissed: true });
      await pending;
      listed.resolve({ suggestions: [suggestion] });
      await Promise.all([oldList, pendingList]);
      expect(pane.tasks.suggestions).toEqual([]);
    } else if (outcome === "failed") {
      await pane.refreshTaskSuggestions();
      expect(pane.tasks.suggestions).toEqual([]);
      const next = { ...suggestion, id: "task_next", title: "Next task" };
      suggestions = [suggestion, next];
      pane.tasks.suggestions = [next];
      dismissed.reject(new Error("Dismissal unavailable"));
      await pending;
      expect(pane.tasks.suggestions).toEqual([suggestion, next]);
      flush();
      expect(card()).not.toBeNull();
      expect(state.chatError).toBe("Dismissal unavailable");
    } else {
      let expected: TaskSuggestion[] = [];
      if (outcome === "resolved") {
        suggestions = [];
        pane.handleTaskSuggestionEvent({
          action: "resolved",
          taskId: suggestion.id,
          resolution: "dismissed",
        });
      } else {
        if (outcome === "connection") {
          pane.connectionGeneration += 1;
        } else {
          state.sessionKey = "agent:main:other";
        }
        expected = [{ ...suggestion, id: "task_other", sessionKey: state.sessionKey }];
        pane.tasks.suggestions = expected;
      }
      dismissed.reject(new Error("Old dismissal failed"));
      await pending;
      expect(pane.tasks.suggestions).toEqual(expected);
      expect(state.chatError).toBeNull();
    }
  },
);

it("preserves refused-dismissal reconciliation when another dismissal succeeds", async () => {
  const next = { ...suggestion, id: "task_next", title: "Next task" };
  const firstDismiss = createDeferred<{ taskId: string; dismissed: boolean }>();
  const secondDismiss = createDeferred<{ taskId: string; dismissed: boolean }>();
  const oldList = createDeferred<TaskSuggestionsListResult>();
  let listCount = 0;
  let dismissCount = 0;
  const { pane } = createRequestPane((method) => {
    if (method === "taskSuggestions.dismiss") {
      dismissCount += 1;
      return dismissCount === 1 ? firstDismiss.promise : secondDismiss.promise;
    }
    listCount += 1;
    return listCount === 1 ? oldList.promise : Promise.resolve({ suggestions: [suggestion] });
  });
  pane.tasks.suggestions = [suggestion, next];
  const first = pane.resolveTaskSuggestion(suggestion, "dismiss");
  const second = pane.resolveTaskSuggestion(next, "dismiss");
  firstDismiss.resolve({ taskId: suggestion.id, dismissed: false });
  await first;
  secondDismiss.resolve({ taskId: next.id, dismissed: true });
  await second;
  oldList.resolve({ suggestions: [suggestion, next] });

  await vi.waitFor(() => expect(pane.tasks.suggestions).toEqual([suggestion]));
});

it("surfaces clipboard failure through the pane error path", async () => {
  const writeText = vi.fn().mockRejectedValue(new Error("denied"));
  const execCommand = vi.fn(() => false);
  const restore = (
    [
      [navigator, "clipboard", { writeText }],
      [document, "execCommand", execCommand],
    ] as const
  ).map(([target, key, value]) => {
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    Object.defineProperty(target, key, { configurable: true, value });
    return () =>
      descriptor
        ? Object.defineProperty(target, key, descriptor)
        : Reflect.deleteProperty(target, key);
  });
  const client = { request: vi.fn() } as unknown as GatewayBrowserClient;
  const { pane, state } = createTestChatPane(client);

  try {
    await pane.copyTaskSuggestionPrompt(suggestion);
  } finally {
    // The fallback restores focus on the next turn; drain it before jsdom teardown.
    await new Promise<void>((resolve) => {
      window.setTimeout(resolve, 0);
    });
    restore.forEach((reset) => reset());
  }

  expect(writeText).toHaveBeenCalledWith(suggestion.prompt);
  expect(execCommand).toHaveBeenCalledWith("copy");
  const failure = "Couldn't copy the prompt to the clipboard";
  expect(state).toMatchObject({ lastError: failure, chatError: failure });
});

it("hides a launched task through early events and stale lists without changing sessions", async () => {
  const accepted = createDeferred<TaskSuggestionsAcceptResult>();
  const next = { ...suggestion, id: "task_next", title: "Next task" };
  const { pane, state, request, draw, query } = createAcceptancePane(
    () => accepted.promise,
    [suggestion, next],
  );
  state.lastError = "History unavailable";
  state.chatError = "Chat send failed";
  const navigate = vi.fn();
  pane.onPaneSessionChange = navigate;
  pane.tasks.suggestions = [suggestion, next];

  const pending = pane.resolveTaskSuggestion(suggestion, "accept");
  draw();
  expect(query('[data-task-id="task_123"]')).toBeNull();
  expect(query('[data-task-id="task_next"]')?.hasAttribute("hidden")).toBe(false);
  pane.handleTaskSuggestionEvent({
    action: "resolved",
    taskId: suggestion.id,
    resolution: "accepted",
  });
  await pane.refreshTaskSuggestions();
  expect(pane.tasks.suggestions).toEqual([next]);
  await pane.resolveTaskSuggestion(suggestion, "accept");
  expect(acceptCalls(request)).toEqual([
    ["taskSuggestions.accept", { taskId: suggestion.id, mode: "local" }],
  ]);
  accepted.resolve({ taskId: suggestion.id, key: "agent:main:task" });
  await pending;
  await pane.refreshTaskSuggestions();
  draw();
  expect(pane.tasks.suggestions).toEqual([next]);
  expect(query('[data-task-id="task_123"]')).toBeNull();
  expect(navigate).not.toHaveBeenCalled();
  expect(state).toMatchObject({ lastError: "History unavailable", chatError: "Chat send failed" });
  await pane.resolveTaskSuggestion(suggestion, "accept");
  expect(acceptCalls(request)).toHaveLength(1);
});

it("recovers a worktree source on the same card without changing the prompt or launch mode", async () => {
  let attempts = 0;
  const { pane, request, container, draw, query, acceptance } = createRequestPane(
    async (method) => {
      if (method === "projects.list") {
        return {
          projects: [
            { id: "app", displayName: "App", repoRoot: "/projects/app", source: "registered" },
          ],
        };
      }
      if (method === "taskSuggestions.accept") {
        if (++attempts === 1) {
          throw sourceRequired();
        }
        return { taskId: suggestion.id, key: "agent:main:recovered" };
      }
      return { suggestions: [suggestion] };
    },
  );
  pane.context.gateway.snapshot.hello = gatewayHelloForMethods([
    "taskSuggestions.accept",
    "projects.list",
  ]);
  await pane.resolveTaskSuggestion(suggestion, "accept", "worktree");
  await vi.waitFor(() => {
    draw();
    expect(query(".task-suggestion__repository-choice")).not.toBeNull();
  });
  draw();
  expect(container.textContent).toContain(suggestion.prompt);
  expect(container.textContent).toContain("Checkout has no commits");
  const input = () => query<HTMLInputElement>(".task-suggestion__repository-path")!;
  expect(input().value).toBe(suggestion.cwd);
  query<HTMLButtonElement>(".task-suggestion__repository-choice")!.click();
  draw();
  expect(input().value).toBe("/projects/app");
  expect(attempts).toBe(1);
  [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find((button) => button.textContent?.trim() === "Cancel")!
    .click();
  draw();
  expect(query(".task-suggestion__repository-path")).toBeNull();
  expect(container.textContent).toContain(suggestion.prompt);
  query<HTMLButtonElement>(".task-suggestion__retry")!.click();
  draw();
  expect(input().value).toBe("/projects/app");
  input().value = "relative/path";
  input().dispatchEvent(new Event("input", { bubbles: true }));
  draw();
  expect(query<HTMLButtonElement>(".task-suggestion__retry")!.disabled).toBe(true);
  input().value = "/projects/app";
  input().dispatchEvent(new Event("input", { bubbles: true }));
  draw();
  query<HTMLButtonElement>(".task-suggestion__retry")!.click();
  await vi.waitFor(() => expect(acceptance()?.phase).toBe("started"));
  draw();
  expect(query(".task-suggestion")).toBeNull();
  expect(acceptCalls(request)).toEqual([
    ["taskSuggestions.accept", { taskId: suggestion.id, mode: "worktree" }],
    ["taskSuggestions.accept", { taskId: suggestion.id, mode: "worktree", cwd: "/projects/app" }],
  ]);
  expect(request.mock.calls.some(([method]) => method === "sessions.create")).toBe(false);
});

it("does not populate a recovery chooser from a retired connection", async () => {
  const projects = createDeferred<{
    projects: Array<{ id: string; displayName: string; repoRoot: string; source: string }>;
  }>();
  const { pane, acceptance } = createRequestPane((method) =>
    method === "projects.list" ? projects.promise : Promise.reject(sourceRequired("No commits")),
  );
  pane.context.gateway.snapshot.hello = gatewayHelloForMethods([
    "taskSuggestions.accept",
    "projects.list",
  ]);
  await pane.resolveTaskSuggestion(suggestion, "accept", "worktree");
  pane.connectionGeneration += 1;
  projects.resolve({
    projects: [
      { id: "stale", displayName: "Stale project", repoRoot: "/stale", source: "registered" },
    ],
  });
  await projects.promise;
  const outcome = acceptance();
  expect(outcome?.phase === "failed" && outcome.repository?.projects).toEqual([]);
});

it("keeps submitted content through reconnect and fences a late acceptance behind a same-task retry", async () => {
  const first = createDeferred<TaskSuggestionsAcceptResult>();
  const retry = createDeferred<TaskSuggestionsAcceptResult>();
  let attempts = 0;
  const { pane, state, request, container, draw, query } = createRequestPane((method) => {
    if (method === "agents.list") {
      return Promise.resolve({
        defaultId: "main",
        mainKey: "main",
        scope: "per-sender",
        agents: [{ id: "main" }],
      } satisfies AgentsListResult);
    }
    return method === "taskSuggestions.accept"
      ? ++attempts === 1
        ? first.promise
        : retry.promise
      : Promise.resolve({ suggestions: [] });
  });
  pane.context.gateway.snapshot.selfUser = { id: "operator-a", name: "Operator A" };
  state.loadAssistantIdentity = vi.fn(async () => {});
  const snapshot = pane.context.gateway.snapshot;
  const pending = pane.resolveTaskSuggestion(suggestion, "accept", "worktree");

  pane.applyGatewaySnapshot({ ...snapshot, phase: "reconnecting", hello: null, selfUser: null });
  draw(false);
  expect(container.textContent).toContain(suggestion.prompt);
  expect(container.textContent).toContain("Delivery unconfirmed");
  expect(query<HTMLButtonElement>(".task-suggestion__retry")?.disabled).toBe(true);
  await pane.resolveTaskSuggestion(suggestion, "accept");
  expect(attempts).toBe(1);
  pane.applyGatewaySnapshot({ ...snapshot, phase: "connected" });
  await pane.refreshTaskSuggestions();
  draw(true);
  expect(container.textContent).toContain(suggestion.prompt);
  const retrying = pane.resolveTaskSuggestion(suggestion, "accept");
  first.resolve({ taskId: suggestion.id, key: "agent:main:stale" });
  await pending;
  draw(true);
  expect(query(".task-suggestion")).toBeNull();
  retry.resolve({ taskId: suggestion.id, key: "agent:main:recovered-task" });
  await retrying;
  draw(true);
  expect(query(".task-suggestion")).toBeNull();
  expect(acceptCalls(request)).toEqual([
    ["taskSuggestions.accept", { taskId: suggestion.id, mode: "worktree" }],
    ["taskSuggestions.accept", { taskId: suggestion.id, mode: "worktree" }],
  ]);
  pane.applyGatewaySnapshot({ ...snapshot, phase: "reconnecting", hello: null, selfUser: null });
  draw(false);
  expect(query(".task-suggestion")).toBeNull();

  pane.applyGatewaySnapshot({
    ...snapshot,
    selfUser: { id: "operator-b", name: "Operator B" },
  });
  draw(true);
  expect(container.textContent).not.toContain(suggestion.prompt);
  expect(pane.tasks.suggestions).toEqual([]);
});

it.each([
  { resolved: false, result: undefined },
  { resolved: true, result: undefined },
  { resolved: false, result: { taskId: "other-task", key: "agent:main:task" } },
  { resolved: false, result: { taskId: suggestion.id, key: " " } },
])(
  "restores a failed or unconfirmed acceptance and retries the same task (%j)",
  async ({ resolved, result }) => {
    const first = createDeferred<TaskSuggestionsAcceptResult>();
    const retry = createDeferred<TaskSuggestionsAcceptResult>();
    let attempts = 0;
    const { pane, state, request, container, draw, query } = createAcceptancePane(() =>
      ++attempts === 1 ? first.promise : retry.promise,
    );
    const pending = pane.resolveTaskSuggestion(suggestion, "accept", "worktree");
    expect(pane.tasks.suggestions).toEqual([]);
    if (resolved) {
      pane.handleTaskSuggestionEvent({
        action: "resolved",
        taskId: suggestion.id,
        resolution: "accepted",
      });
    }
    if (result) {
      first.resolve(result);
    } else {
      first.reject(new Error("Synthetic session creation failed"));
    }
    await pending;
    await pane.refreshTaskSuggestions();
    expect(pane.tasks.suggestions).toEqual([suggestion]);
    const failure = state.lastError;
    expect(failure).toContain(result ? "Couldn't confirm" : "Synthetic session creation failed");
    expect(state.chatError).toBe(failure);
    draw();
    expect(query<HTMLDetailsElement>("details")?.open).toBe(true);
    expect(container.textContent).toContain(suggestion.prompt);
    expect(query('[role="alert"]')?.textContent).toContain(
      result ? "Couldn't confirm" : "Synthetic session creation failed",
    );
    expect(query(".task-suggestion__retry")?.textContent).toContain("Retry");
    const retrying = pane.resolveTaskSuggestion(suggestion, "accept");
    expect(pane.tasks.suggestions).toEqual([]);
    expect(state).toMatchObject({ lastError: failure, chatError: failure });
    await pane.resolveTaskSuggestion(suggestion, "accept");
    expect(attempts).toBe(2);
    expect(acceptCalls(request)).toEqual([
      ["taskSuggestions.accept", { taskId: suggestion.id, mode: "worktree" }],
      ["taskSuggestions.accept", { taskId: suggestion.id, mode: "worktree" }],
    ]);
    retry.resolve({ taskId: suggestion.id, key: "agent:main:task" });
    await retrying;
    expect(pane.tasks.suggestions).toEqual([]);
    expect(state).toMatchObject({ lastError: null, chatError: null });
  },
);

it.each([
  { field: "lastError", sameMessage: false, beforeRetry: false },
  { field: "chatError", sameMessage: false, beforeRetry: false },
  { field: "lastError", sameMessage: true, beforeRetry: true },
  { field: "chatError", sameMessage: true, beforeRetry: false },
  { field: "both", sameMessage: true, beforeRetry: false },
  { field: "task", sameMessage: true, beforeRetry: false },
] as const)(
  "preserves a newer error when a task retry succeeds (%j)",
  async ({ field, sameMessage, beforeRetry }) => {
    const retry = createDeferred<TaskSuggestionsAcceptResult>();
    let attempts = 0;
    const { pane, state } = createAcceptancePane(() =>
      ++attempts === 2 ? retry.promise : Promise.reject(new Error("Session creation failed")),
    );
    const other = { ...suggestion, id: "task_other" };
    if (field === "task") {
      pane.tasks.suggestions = [suggestion, other];
    }
    await pane.resolveTaskSuggestion(suggestion, "accept");
    const message = sameMessage ? "Session creation failed" : "Chat send failed";
    const publishNewerError = () => {
      if (field === "task") {
        return;
      }
      if (field === "both") {
        state.lastError = state.chatError = message;
      } else {
        state[field] = message;
      }
    };
    if (beforeRetry) {
      publishNewerError();
    }
    const pending = pane.resolveTaskSuggestion(suggestion, "accept");
    if (field === "task") {
      await pane.resolveTaskSuggestion(other, "accept");
    } else if (!beforeRetry) {
      publishNewerError();
    }
    retry.resolve({ taskId: suggestion.id, key: "agent:main:task" });
    await pending;
    expect(pane.tasks.suggestions).toEqual(field === "task" ? [other] : []);
    expect(state).toMatchObject({
      lastError: field === "chatError" ? null : message,
      chatError: field === "lastError" ? null : message,
    });
  },
);

it.each(["hello", "client", "unknown"] as const)(
  "retires submitted suggestion content when Hello changes the %s recovery owner",
  async (source) => {
    const accepted = createDeferred<TaskSuggestionsAcceptResult>();
    const request = createGatewayRequestMock((method) =>
      method === "taskSuggestions.accept" ? accepted.promise : Promise.resolve({ suggestions: [] }),
    );
    const client = createTestGatewayClient(request);
    let recoveryReady = source === "client";
    Object.defineProperties(client, {
      recoveryScope: { get: () => (source === "unknown" ? "" : "principal-a") },
      recoveryScopeReady: { get: () => recoveryReady },
    });
    const { pane, container, draw, query } = createTestChatPane(client);
    const snapshot = pane.context.gateway.snapshot;
    const hello = snapshot.hello!;
    snapshot.hello = {
      ...hello,
      auth: { ...hello.auth, recoveryScope: source === "hello" ? "principal-a" : undefined },
    };
    snapshot.selfUser = { id: "operator-a", name: "Operator A" };
    const pending = pane.resolveTaskSuggestion(suggestion, "accept");
    recoveryReady = false;
    pane.applyGatewaySnapshot({
      ...snapshot,
      hello: { ...hello, auth: { ...hello.auth, recoveryScope: "principal-a" } },
    });
    draw();
    expect(query(".task-suggestion")).toBeNull();
    pane.applyGatewaySnapshot({
      ...snapshot,
      hello: { ...hello, auth: { ...hello.auth, recoveryScope: "principal-b" } },
    });
    draw();
    expect(container.textContent).not.toContain(suggestion.prompt);
    accepted.resolve({ taskId: suggestion.id, key: "agent:main:old-owner" });
    await pending;
    draw();
    expect(pane.tasks.suggestions).toEqual([]);
    expect(query(".task-suggestion__open")).toBeNull();
    expect(acceptCalls(request)).toHaveLength(1);
  },
);

it.each(
  (["starting", "failed", "started"] as const).flatMap((phase) =>
    [true, false].map((initiallyKnown) => ({ phase, initiallyKnown })),
  ),
)(
  "retires a $phase suggestion after physical session replacement (initially known: $initiallyKnown)",
  async ({ phase, initiallyKnown }) => {
    const accepted = createDeferred<TaskSuggestionsAcceptResult>();
    const { pane, state, request, container, draw, query } = createAcceptancePane(
      () => accepted.promise,
    );
    state.currentSessionId = initiallyKnown ? "physical-original" : undefined;
    state.loadAssistantIdentity = vi.fn(async () => {});
    const navigate = vi.fn();
    pane.onPaneSessionChange = navigate;
    const pending = pane.resolveTaskSuggestion(suggestion, "accept");
    if (phase === "failed") {
      accepted.reject(new Error("Acceptance response unavailable"));
      await pending;
    } else if (phase === "started") {
      accepted.resolve({ taskId: suggestion.id, key: "agent:main:task" });
      await pending;
    }
    draw();
    expect(Boolean(query(".task-suggestion"))).toBe(phase === "failed");
    state.currentSessionId = "physical-original";
    const originalProps = draw();
    expect(Boolean(query(".task-suggestion"))).toBe(phase === "failed");

    state.currentSessionId = "physical-replacement";
    draw();
    expect(container.textContent).not.toContain(suggestion.prompt);
    expect(query(".task-suggestion__open")).toBeNull();
    expect(query(".task-suggestion__retry")).toBeNull();
    pane.applyGatewaySnapshot({ ...pane.context.gateway.snapshot });
    await pane.refreshTaskSuggestions();
    expect(pane.tasks.suggestions).toEqual([]);
    // Retained handlers cannot revive a retired operation after reconciliation removes it.
    originalProps.onAcceptTaskSuggestion?.(suggestion, "local");
    expect(navigate).not.toHaveBeenCalled();
    expect(acceptCalls(request)).toHaveLength(1);
    if (phase === "starting") {
      accepted.resolve({ taskId: suggestion.id, key: "agent:main:late-task" });
      await pending;
    }
    state.currentSessionId = "physical-original";
    draw();
    expect(container.textContent).not.toContain(suggestion.prompt);
    expect(pane.tasks.suggestions).toEqual([]);
  },
);

it.each(["accept", "list"] as const)(
  "drops a late %s response after a same-client reconnect",
  async (action) => {
    const response = createDeferred<TaskSuggestionsAcceptResult | TaskSuggestionsListResult>();
    const client = createTestGatewayClient(createGatewayRequestMock(() => response.promise));
    const { pane } = createTestChatPane(client);
    pane.tasks.suggestions = action === "accept" ? [suggestion] : [];
    const pending =
      action === "accept"
        ? pane.resolveTaskSuggestion(suggestion, "accept")
        : pane.refreshTaskSuggestions();
    pane.connectionGeneration += 1;
    response.resolve(
      action === "accept"
        ? { taskId: suggestion.id, key: "agent:main:stale" }
        : { suggestions: [suggestion] },
    );
    await pending;
    expect(pane.tasks.suggestions).toEqual(action === "accept" ? [suggestion] : []);
  },
);
