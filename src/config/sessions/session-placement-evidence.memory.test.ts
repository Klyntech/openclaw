import { afterEach, expect, it, vi } from "vitest";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { memorySessionActorOwners } from "./session-actor-memory-owner.js";
import { runWithSessionActorStorage } from "./session-actor-storage-binding.js";
import { readPlacementSessionIdentityEvidence } from "./session-placement-evidence.js";

vi.mock("node:sqlite", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:sqlite")>()),
  DatabaseSync: vi.fn(function () {
    throw new Error("Memory placement evidence opened SQLite");
  }),
}));
vi.mock("node:worker_threads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:worker_threads")>()),
  Worker: vi.fn(function () {
    throw new Error("Memory placement evidence allocated a worker");
  }),
}));

const env = { OPENCLAW_STATE_DIR: "/synthetic/memory-placement-evidence" };
const authority = { assertCurrent() {}, authorize() {} };
const lifetime = { assertCurrent() {}, assertReadable() {} };
afterEach(() => {
  memorySessionActorOwners.reset();
  vi.unstubAllEnvs();
});

it("resolves current and ambiguous memory identities without creating missing owners", async () => {
  vi.stubEnv("OPENCLAW_STATE_DIR", env.OPENCLAW_STATE_DIR);
  const location = {
    agentId: "main",
    path: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env }),
  };
  const owner = memorySessionActorOwners.get(location);
  const key = "agent:main:dashboard:incognito-current";
  const alias = "agent:main:dashboard:incognito-alias";
  const unknown = "agent:main:dashboard:incognito-unknown";
  const unique = "agent:main:dashboard:incognito-unique";
  const actors = await Promise.all(
    [key, alias, unique].map((sessionKey) =>
      owner.acquire({ database: owner.identity, sessionKey }, lifetime),
    ),
  );
  try {
    for (const actor of actors) {
      const entry = {
        sessionId: actor.target.sessionKey === unique ? "unique-id" : "shared-id",
        updatedAt: 1,
        incognito: true,
      };
      const result = await actor.storage!.mutate(
        { type: "session.entry.create", input: { entry } },
        authority,
      );
      expect(result.kind).toBe("committed");
    }
    const probe = (sessionId: string, sessionKey = unknown, agentId = "main") => ({
      agentId,
      sessionKey,
      sessionId,
    });
    const probes = [
      probe("shared-id", key),
      probe("shared-id"),
      probe("unique-id"),
      probe("missing-id"),
      probe("shared-id", "agent:missing:dashboard:incognito-unknown", "missing"),
    ];
    const expected = [
      { status: "current", sessionKey: key },
      { status: "unknown", reason: "ambiguous" },
      { status: "current", sessionKey: unique },
      { status: "absent" },
      { status: "absent" },
    ];
    expect(await readPlacementSessionIdentityEvidence({}, probes)).toEqual(expected);
    expect(
      await runWithSessionActorStorage({ ...location, actor: actors[0]!, authority }, () =>
        readPlacementSessionIdentityEvidence({}, probes),
      ),
    ).toEqual(expected);
    expect(memorySessionActorOwners.list()).toEqual([owner]);
    owner.closeSession(unique);
    expect(await readPlacementSessionIdentityEvidence({}, [probes[2]!])).toEqual([
      { status: "absent" },
    ]);
    vi.stubEnv("OPENCLAW_STATE_DIR", "/synthetic/another-placement-root");
    expect(await readPlacementSessionIdentityEvidence({}, [probes[0]!])).toEqual([
      { status: "absent" },
    ]);
    expect(memorySessionActorOwners.list()).toEqual([owner]);
  } finally {
    await Promise.all(actors.map((actor) => actor.release()));
  }
});
