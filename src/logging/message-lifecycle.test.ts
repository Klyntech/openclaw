import { beforeEach, describe, expect, it, vi } from "vitest";

const diagnosticMocks = vi.hoisted(() => ({
  logMessageProcessed: vi.fn(),
  logMessageQueued: vi.fn(),
  logSessionStateChange: vi.fn(),
}));

vi.mock("./diagnostic.js", () => diagnosticMocks);

import { createDiagnosticMessageLifecycle } from "./message-lifecycle.js";

function expectProcessed(event: Record<string, unknown>) {
  expect(diagnosticMocks.logMessageProcessed).toHaveBeenCalledWith({
    chatId: undefined,
    messageId: undefined,
    sessionId: undefined,
    sessionKey: undefined,
    reason: undefined,
    error: undefined,
    ...event,
  });
}

describe("createDiagnosticMessageLifecycle", () => {
  beforeEach(() => {
    for (const mock of Object.values(diagnosticMocks)) {
      mock.mockReset();
    }
  });

  it("emits queued, state, and processed events through one lifecycle", () => {
    const initialRef = { sessionId: "initial-session", sessionKey: "cron:job" };
    const finalRef = { ...initialRef, sessionId: "final-session" };
    const lifecycle = createDiagnosticMessageLifecycle({
      enabled: true,
      channel: "cron",
      source: "cron-isolated",
      ...initialRef,
      trackSessionState: true,
    });

    lifecycle.markProcessing();
    lifecycle.markIdle(undefined, finalRef);
    lifecycle.markProcessed("completed", { ...finalRef, durationMs: 42 });

    expect(diagnosticMocks.logMessageQueued).toHaveBeenCalledWith({
      ...initialRef,
      channel: "cron",
      source: "cron-isolated",
    });
    expect(diagnosticMocks.logSessionStateChange.mock.calls).toEqual([
      [{ ...initialRef, state: "processing", reason: undefined }],
      [{ ...finalRef, state: "idle", reason: undefined }],
    ]);
    expectProcessed({
      channel: "cron",
      ...finalRef,
      durationMs: 42,
      outcome: "completed",
    });
  });

  it("keeps processed events independent of session-state tracking", () => {
    const lifecycle = createDiagnosticMessageLifecycle({
      enabled: true,
      channel: "whatsapp",
      source: "dispatch",
      chatId: "chat-1",
      messageId: "msg-1",
      trackSessionState: false,
    });

    lifecycle.markProcessing();
    lifecycle.markIdle("message_completed");
    lifecycle.markProcessed("skipped", { durationMs: 7, reason: "duplicate" });

    expect(diagnosticMocks.logMessageQueued).not.toHaveBeenCalled();
    expect(diagnosticMocks.logSessionStateChange).not.toHaveBeenCalled();
    expectProcessed({
      channel: "whatsapp",
      chatId: "chat-1",
      messageId: "msg-1",
      durationMs: 7,
      outcome: "skipped",
      reason: "duplicate",
    });
  });

  it("emits nothing when disabled", () => {
    const lifecycle = createDiagnosticMessageLifecycle({
      enabled: false,
      channel: "slack",
      source: "dispatch",
      sessionKey: "agent:main",
      trackSessionState: true,
    });

    lifecycle.markProcessing();
    lifecycle.markIdle("message_completed");
    lifecycle.markProcessed("completed", { durationMs: 1 });

    expect(diagnosticMocks.logMessageQueued).not.toHaveBeenCalled();
    expect(diagnosticMocks.logSessionStateChange).not.toHaveBeenCalled();
    expect(diagnosticMocks.logMessageProcessed).not.toHaveBeenCalled();
  });
});
