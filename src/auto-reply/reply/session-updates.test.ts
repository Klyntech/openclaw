import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createReplySessionEntryHandle } from "./session-entry-handle.js";

const TEST_WORKSPACE_DIR = path.resolve("/tmp/workspace");

const {
  buildWorkspaceSkillSnapshotMock,
  ensureSkillsWatcherMock,
  getSkillsSnapshotVersionMock,
  shouldRefreshSnapshotForVersionMock,
  getRemoteSkillEligibilityMock,
  updateSessionEntryMock,
} = vi.hoisted(() => ({
  buildWorkspaceSkillSnapshotMock: vi.fn((..._args: unknown[]) => ({
    prompt: "",
    skills: [] as unknown[],
    resolvedSkills: [] as unknown[],
  })),
  ensureSkillsWatcherMock: vi.fn(),
  getSkillsSnapshotVersionMock: vi.fn(() => 0),
  shouldRefreshSnapshotForVersionMock: vi.fn((_cached?: number, _next?: number) => false),
  getRemoteSkillEligibilityMock: vi.fn(() => ({
    platforms: [],
    hasBin: () => false,
    hasAnyBin: () => false,
  })),
  updateSessionEntryMock: vi.fn(),
}));

// mock-isolation: Session classification is outside skill snapshot publication.
vi.mock("../../agents/sandbox/runtime-status.js", () => ({
  resolveSandboxRuntimeStatus: () => ({ sandboxed: false, sandboxRequired: false }),
  withSandboxRuntimeStatusInWorker: async (
    _params: unknown,
    source: { assertCurrent: () => void },
    consume: (sandbox: { sandboxed: boolean; sandboxRequired: boolean }) => Promise<unknown>,
  ) => {
    source.assertCurrent();
    const result = await consume({ sandboxed: false, sandboxRequired: false });
    source.assertCurrent();
    return result;
  },
}));

// mock-isolation: Use a fixed policy while testing skill ownership and publication.
vi.mock("../../infra/exec-approvals-store.js", () => ({
  loadExecApprovalsReadOnlyAsync: async () => ({ version: 1, agents: {} }),
}));

vi.mock("../../skills/runtime/remote.js", () => ({
  getRemoteSkillEligibility: getRemoteSkillEligibilityMock,
}));

vi.mock("../../skills/loading/workspace-skill-prompt.js", () => ({
  buildSkillSnapshot: buildWorkspaceSkillSnapshotMock,
}));

vi.mock("../../skills/runtime/refresh.js", () => ({
  ensureSkillsWatcher: ensureSkillsWatcherMock,
}));

vi.mock("../../skills/runtime/refresh-state.js", () => ({
  getSkillsSnapshotVersion: getSkillsSnapshotVersionMock,
  getSkillsSourceVersion: getSkillsSnapshotVersionMock,
  shouldRefreshSnapshotForVersion: shouldRefreshSnapshotForVersionMock,
}));

vi.mock("../../config/sessions.js", () => ({
  updateSessionStore: vi.fn(),
  resolveSessionFilePathCore: vi.fn(),
  resolveSessionFilePathOptions: vi.fn(),
}));

// mock-isolation: Skill-refresh cases control persistence acknowledgments without opening SQLite.
vi.mock("../../config/sessions/session-accessor.sqlite-entry.js", () => ({
  applySessionEntryOperation: (...args: unknown[]) => updateSessionEntryMock(...args),
}));

const { ensureSkillSnapshot } = await import("./session-updates.js");

const sessionKey = "agent:main:main";
function skillFixture(
  sessionEntry: NonNullable<Parameters<typeof ensureSkillSnapshot>[0]["sessionEntry"]>,
) {
  const sessionStore = { [sessionKey]: sessionEntry };
  return {
    agentId: "main",
    sessionEntry,
    sessionStore,
    sessionKey,
    sessionId: sessionEntry.sessionId,
    storePath: "/tmp/sessions.json",
    isFirstTurnInSession: true,
    workspaceDir: TEST_WORKSPACE_DIR,
    cfg: {},
  };
}

describe("ensureSkillSnapshot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("OPENCLAW_TEST_FAST", "0");
    buildWorkspaceSkillSnapshotMock.mockReturnValue({ prompt: "", skills: [], resolvedSkills: [] });
    getSkillsSnapshotVersionMock.mockReturnValue(0);
    shouldRefreshSnapshotForVersionMock.mockReturnValue(false);
    getRemoteSkillEligibilityMock.mockReturnValue({
      platforms: [],
      hasBin: () => false,
      hasAnyBin: () => false,
    });
    updateSessionEntryMock.mockReset();
    updateSessionEntryMock.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("does not keep a deleted first-turn session entry when persisting skills", async () => {
    const fixture = skillFixture({ sessionId: "deleted-session", updatedAt: 10 });
    const sessionEntryHandle = createReplySessionEntryHandle(fixture);
    const result = await ensureSkillSnapshot({ ...fixture, sessionEntryHandle });

    expect(updateSessionEntryMock).toHaveBeenCalledWith(
      {
        storePath: "/tmp/sessions.json",
        sessionKey,
      },
      expect.objectContaining({ kind: "fields" }),
      expect.any(Object),
    );
    expect(result.sessionEntry).toBeUndefined();
    expect(result.systemSent).toBe(false);
    expect(sessionEntryHandle.getCurrent()).toBeUndefined();
    expect(fixture.sessionStore[sessionKey]).toBeUndefined();
  });

  it.each([true, false])(
    "persists only owned skill fields as a partial update (first turn: %s)",
    async (isFirstTurnInSession) => {
      const sessionEntry = {
        sessionId: "session-1",
        updatedAt: 10,
        modelOverride: "gpt-5.5",
        label: "Before rename",
        pinnedAt: 100,
      };
      const fixture = skillFixture(sessionEntry);
      const { sessionStore } = fixture;
      updateSessionEntryMock.mockImplementationOnce(async (_scope, operation) => {
        const concurrentEntry = {
          sessionId: sessionEntry.sessionId,
          updatedAt: 20,
          modelOverride: "sonnet-4.6",
          label: "After rename",
          sendPolicy: "deny",
        };
        const patch = operation.patch;
        expect(patch).not.toHaveProperty("sessionId");
        if (isFirstTurnInSession) {
          expect(patch).toHaveProperty("systemSent", true);
        } else {
          expect(patch).not.toHaveProperty("systemSent");
        }
        expect(patch).not.toHaveProperty("modelOverride");
        expect(patch).not.toHaveProperty("label");
        expect(patch).not.toHaveProperty("pinnedAt");
        expect(patch).not.toHaveProperty("sendPolicy");
        return { ...concurrentEntry, ...patch };
      });

      const result = await ensureSkillSnapshot({ ...fixture, isFirstTurnInSession });

      expect(result.sessionEntry?.modelOverride).toBe("sonnet-4.6");
      expect(sessionStore[sessionKey]?.modelOverride).toBe("sonnet-4.6");
      expect(result.sessionEntry).toMatchObject({ label: "After rename", sendPolicy: "deny" });
      expect(result.sessionEntry?.pinnedAt).toBeUndefined();
      expect(sessionStore[sessionKey]).toEqual(result.sessionEntry);
    },
  );
});
