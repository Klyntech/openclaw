import { expectDefined } from "@openclaw/normalization-core";
import { formatErrorMessage } from "@openclaw/normalization-core/error-coercion";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loseFirstCronMutationReply } from "../../test/helpers/cron/runtime-mutation.js";
import { createCronRegressionState } from "../../test/helpers/cron/service-regression-fixtures.js";
import { createDeferred } from "../../test/helpers/promise.js";
import type { EngineConnection } from "../infra/sql-connection.js";
import { SqliteCoordinatorError } from "../infra/sqlite-lifecycle-errors.js";
import { writeConfigMachineState } from "../state/config-machine-state-write.js";
import {
  closeOpenClawStateDatabaseByPathAsync,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import * as stateWorker from "../state/openclaw-state-worker-store.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { clearCronJobActive, markCronJobActive } from "./active-jobs.js";
import { createCronMutationCompletion } from "./mutation-completion.js";
import { CronService } from "./service.js";
import * as runtimeMutation from "./service/runtime-mutation.js";
import * as sessionReaper from "./session-reaper.js";
import {
  CronJobsStoreChangedError,
  getCronJobsStoreRevision,
  loadCronJobsStoreWithConfigJobs,
  noteCronJobsStoreCommit,
  saveCronJobsStore,
  saveCronJobsStoreChanges,
  saveCronJobsStoreWithRevision,
} from "./store.js";
import { prepareCronJobNameResolver } from "./store/job-name.js";
import { serializeCronLoadError } from "./store/load-error.js";
import type { CronStoreWorkerOperations } from "./store/load-worker.types.js";
import { serializeCronSaveError } from "./store/save-error.js";
import type { CronStoreSaveWorkerOperations } from "./store/save-worker.types.js";
import type { CronJob, CronJobCreate, CronStoreFile } from "./types.js";

function cronWorkerFixture(): CronStoreFile {
  return {
    version: 1,
    jobs: ["first", "second"].map((id) => ({
      id,
      name: id,
      enabled: true,
      createdAtMs: 1,
      updatedAtMs: 2,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: "scheduled café 🦞" },
      state: { nextRunAtMs: 60_001 },
    })),
  };
}

function createService(
  storePath: string,
  options: Partial<Parameters<typeof createCronRegressionState>[0]> = {},
) {
  return new CronService(
    createCronRegressionState({
      storePath,
      runIsolatedAgentJob: async () => ({ status: "skipped" }),
      ...options,
    }).deps,
  );
}

function peerJobs(jobs: CronJob[]) {
  return jobs
    .filter((job) => job.id !== "first")
    .map(({ id, name, agentId, runtimeAuthorityRecoveryRequired, state }) => ({
      id,
      name,
      agentId,
      runtimeAuthorityRecoveryRequired,
      state,
    }));
}

describe("worker load result publication", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    { ok: true, repairCommits: 2 },
    { ok: false, repairCommits: 2 },
    { ok: false, repairCommits: 0 },
  ])(
    "publishes completed or uncertain load repairs before settling success=$ok count=$repairCommits",
    async ({ ok, repairCommits }) => {
      const storePath = `/synthetic/cron-repair-result-${ok}-${repairCommits}/jobs.json`;
      const native = Object.assign(new Error("database busy"), { code: "SQLITE_BUSY" });
      const failure = Object.assign(new SqliteCoordinatorError("later load stage failed", native), {
        code: "SQLITE_ERROR",
      });
      const result: CronStoreWorkerOperations["cron.loadMutable"]["output"] = ok
        ? {
            ok: true,
            storeKey: storePath,
            repairCommits,
            loaded: {
              store: { version: 1, jobs: [] },
              configJobs: [],
              configJobIndexes: [],
              configJobRuntimeEntries: [],
              invalidConfigRows: [],
            },
          }
        : {
            ok: false,
            storeKey: storePath,
            repairCommits,
            error: serializeCronLoadError(failure),
          };
      vi.spyOn(stateWorker, "runOpenClawStateWorkerOperation").mockImplementation(
        async (_context, operation) => operation({ execute: vi.fn().mockResolvedValue(result) }),
      );
      noteCronJobsStoreCommit(storePath);
      const before = getCronJobsStoreRevision(storePath);
      if (ok) {
        await expect(loadCronJobsStoreWithConfigJobs(storePath)).resolves.toHaveProperty(
          "store.jobs",
          [],
        );
      } else {
        const load = loadCronJobsStoreWithConfigJobs(storePath);
        await expect(load).rejects.toMatchObject({
          name: failure.name,
          message: "later load stage failed",
          code: "SQLITE_ERROR",
          cause: { message: "database busy", code: "SQLITE_BUSY" },
        });
        await load.catch((error: unknown) => {
          expect(formatErrorMessage(error, { redact: (text) => text })).toBe(
            formatErrorMessage(failure, { redact: (text) => text }),
          );
        });
      }
      expect(getCronJobsStoreRevision(storePath)).toBe(before + Math.max(1, repairCommits));
    },
  );

  it.each(["load", "save"])(
    "invalidates when transport cannot provide a %s result",
    async (operation) => {
      const storePath = `/synthetic/cron-unavailable-${operation}/jobs.json`;
      const failure = new Error("worker result unavailable");
      vi.spyOn(stateWorker, "runOpenClawStateWorkerOperation").mockRejectedValue(failure);
      const before = getCronJobsStoreRevision(storePath);
      const result =
        operation === "load"
          ? loadCronJobsStoreWithConfigJobs(storePath)
          : saveCronJobsStore(storePath, { version: 1, jobs: [] });
      await expect(result).rejects.toBe(failure);
      expect(getCronJobsStoreRevision(storePath)).toBeGreaterThan(before);
    },
  );

  it("invalidates retained stores when a default-partition load loses its result", async () => {
    const storePath = "/synthetic/cron-default-unavailable/jobs.json";
    noteCronJobsStoreCommit(storePath);
    const before = getCronJobsStoreRevision(storePath);
    const failure = new Error("worker result unavailable");
    vi.spyOn(stateWorker, "runOpenClawStateWorkerOperation").mockRejectedValue(failure);

    await expect(loadCronJobsStoreWithConfigJobs()).rejects.toBe(failure);

    expect(getCronJobsStoreRevision(storePath)).toBeGreaterThan(before);
  });
});

it("loads the current default cron partition after in-process writes without host SQL", async () => {
  await withOpenClawTestState({ label: "cron-worker-default" }, async (state) => {
    const firstPath = state.statePath("first", "jobs.json");
    const secondPath = state.statePath("second", "jobs.json");
    const first = cronWorkerFixture();
    const second = { ...first, jobs: first.jobs.slice(1) };
    await saveCronJobsStore(firstPath, first);
    await saveCronJobsStore(secondPath, second);
    const sql = observeMainThreadSql();
    try {
      for (const [storePath, expected] of [
        [firstPath, ["first", "second"]],
        [secondPath, ["second"]],
      ] as const) {
        writeConfigMachineState("cron.store", storePath);
        sql.clear();

        const loaded = await loadCronJobsStoreWithConfigJobs();

        expect(loaded.store.jobs.map((job) => job.id)).toEqual(expected);
        sql.expectIdle();
      }
    } finally {
      sql.restore();
    }
  });
});

it("persists full, changed, and runtime-only cron saves off the host through reopen", async () => {
  await withOpenClawTestState({ label: "cron-worker-save" }, async (state) => {
    const storePath = state.statePath("cron", "jobs.json");
    const otherPath = state.statePath("other", "jobs.json");
    const original = cronWorkerFixture();
    const sql = observeMainThreadSql();
    try {
      await saveCronJobsStore(storePath, original);
      await saveCronJobsStore(otherPath, original);
      const updated = structuredClone(original);
      updated.jobs[0]!.name = "changed configuration";
      updated.jobs[0]!.state.nextRunAtMs = 90_001;
      const committed = await saveCronJobsStoreChanges(storePath, original, updated);
      expect(committed.jobs[0]).toMatchObject({
        name: "changed configuration",
        state: { nextRunAtMs: 90_001 },
      });
      const runtime = structuredClone(committed);
      runtime.jobs[0]!.name = "runtime-only must not replace this name";
      runtime.jobs[0]!.state.nextRunAtMs = 120_001;
      await saveCronJobsStore(storePath, runtime, { stateOnly: true });
      const loaded = await loadCronJobsStoreWithConfigJobs(storePath);
      expect(loaded.store.jobs[0]).toMatchObject({
        name: "changed configuration",
        state: { nextRunAtMs: 120_001 },
      });
      expect((await loadCronJobsStoreWithConfigJobs(otherPath)).store.jobs[0]?.name).toBe("first");
      sql.expectIdle();
      await closeOpenClawStateDatabaseByPathAsync(resolveOpenClawStateSqlitePath(state.env));
      sql.clear();
      expect(await loadCronJobsStoreWithConfigJobs(storePath)).toEqual(loaded);
      sql.expectIdle();
    } finally {
      sql.restore();
    }
  });
});

it("preserves the cron conflict error class across an actual worker save", async () => {
  await withOpenClawTestState({ label: "cron-worker-save-conflict" }, async (state) => {
    const storePath = state.statePath("cron", "jobs.json");
    const previous = cronWorkerFixture();
    await saveCronJobsStore(storePath, previous);
    const authoritative = structuredClone(previous);
    authoritative.jobs[0]!.name = "current definition";
    await saveCronJobsStore(storePath, authoritative);
    const staleEdit = structuredClone(previous);
    staleEdit.jobs[0]!.name = "stale definition";
    await expect(saveCronJobsStoreChanges(storePath, previous, staleEdit)).rejects.toBeInstanceOf(
      CronJobsStoreChangedError,
    );
    expect((await loadCronJobsStoreWithConfigJobs(storePath)).store.jobs[0]?.name).toBe(
      "current definition",
    );
  });
});

it.each([false, true])(
  "publishes native saves with ordered hooks before observer failure=%s",
  async (fail) => {
    await withOpenClawTestState({ label: "cron-native-save-hooks" }, async (state) => {
      const storePath = state.statePath("cron", "jobs.json");
      const store = cronWorkerFixture();
      const order: string[] = [];
      let beforeDatabase: EngineConnection | undefined;
      let afterDatabase: EngineConnection | undefined;
      const before = getCronJobsStoreRevision(storePath);
      const failure = new Error("post-commit observer failed");
      const save = saveCronJobsStore(storePath, store, {
        transactionHooks: {
          beforeWrite: (db) => {
            beforeDatabase = db;
            store.jobs[0]!.name = "changed by native hook";
            order.push("before");
          },
          afterWrite: (db) => {
            afterDatabase = db;
            order.push("after");
          },
          afterCommit: () => {
            order.push("committed");
            if (fail) {
              throw failure;
            }
          },
        },
      });
      if (fail) {
        await expect(save).rejects.toBe(failure);
      } else {
        await save;
      }
      expect(beforeDatabase).toBeDefined();
      expect(afterDatabase).toBe(beforeDatabase);
      expect(order).toEqual(["before", "after", "committed"]);
      expect(getCronJobsStoreRevision(storePath)).toBeGreaterThan(before);
      const loaded = (await loadCronJobsStoreWithConfigJobs(storePath)).store.jobs;
      expect(loaded[0]?.name).toBe("changed by native hook");
      expect(loaded.map((job) => job.id)).toEqual(["first", "second"]);
    });
  },
);

it.each([true, false])(
  "commits guarded service mutations off the host with scheduler enabled=%s",
  async (cronEnabled) => {
    await withOpenClawTestState({ label: "cron-callback-save" }, async (state) => {
      const storePath = state.statePath("cron", "jobs.json");
      const store = cronWorkerFixture();
      for (const job of store.jobs) {
        job.enabled = false;
        job.state = {};
      }
      store.jobs[0]!.declarationKey = "agent:main:callback-save";
      store.jobs.push({ ...store.jobs[0]!, id: "broken", name: "Broken metadata" });
      store.jobs.push({ ...store.jobs[1]!, id: "legacy", name: "Legacy JSON name" });
      await saveCronJobsStore(storePath, store);
      runOpenClawStateWriteTransaction(({ db }) => {
        db.prepare("UPDATE cron_jobs SET job_json = ? WHERE store_key = ? AND job_id = ?").run(
          "{",
          storePath,
          "broken",
        );
        db.prepare(
          "UPDATE cron_jobs SET name = ?, job_json = json_set(job_json, '$.delivery', json(?)) WHERE store_key = ? AND job_id = ?",
        ).run("  Legacy metadata  ", JSON.stringify({ mode: "unsupported" }), storePath, "legacy");
      });
      const resolveName = await prepareCronJobNameResolver(
        ["first", "second", "guarded", "captured-\ud800", "broken", "legacy"],
        storePath,
      );
      const service = createService(storePath, {
        cronEnabled,
        defaultAgentId: "main",
        log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      });
      const input: CronJobCreate = {
        name: "callback save",
        enabled: false,
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "ordinary saved event" },
      };
      const mutationStep = (
        name: string,
        invoke: (callback: () => undefined) => Promise<unknown>,
        expectedNames: [string, string | undefined][],
        singleUse = false,
      ) => ({ name, invoke, expectedNames, singleUse });
      const options = (callback: () => undefined, captured: boolean) =>
        captured ? { captureRuntimeAuthority: callback } : { commitGuard: callback };
      const add =
        (job: CronJobCreate, captured = false) =>
        (callback: () => undefined) =>
          service.add(job, options(callback, captured));
      const update =
        (patch: Parameters<CronService["update"]>[1], captured = false) =>
        (callback: () => undefined) =>
          service.update("first", patch, options(callback, captured));
      const steps = [
        mutationStep("guarded add", add({ ...input, id: " guarded " }), [
          ["guarded", "callback save"],
          ["first", "first"],
          ["second", "second"],
        ]),
        mutationStep(
          "captured add",
          add({ ...input, id: "captured-\ud800", name: "callback \ud800" }, true),
          [["captured-\ud800", "callback \ufffd"]],
          true,
        ),
        mutationStep(
          "guarded convergence",
          add({ ...input, declarationKey: "agent:main:callback-save" }),
          [["first", "first"]],
        ),
        mutationStep("guarded update", update({ name: "guarded update" }), [
          ["first", "guarded update"],
        ]),
        mutationStep(
          "captured update",
          update({ name: "captured update" }, true),
          [["first", "captured update"]],
          true,
        ),
        mutationStep(
          "guarded owner update",
          update({
            agentId: "other",
            sessionTarget: "isolated",
            payload: { kind: "agentTurn", message: "owner update" },
          }),
          [["first", "captured update"]],
        ),
        mutationStep(
          "captured owner update",
          update({ agentId: "main" }, true),
          [["first", "captured update"]],
          true,
        ),
        mutationStep(
          "precondition update",
          (callback) =>
            service.updateWithPrecondition("first", { name: "precondition update" }, callback),
          [["first", "precondition update"]],
          true,
        ),
        mutationStep(
          "guarded remove",
          (callback) => service.remove("second", { commitGuard: callback }),
          [["second", undefined]],
        ),
      ];
      const sql = observeMainThreadSql();
      try {
        await service.list({ includeDisabled: true });
        sql.calibrate();
        for (const step of steps) {
          sql.clear();
          const callback = vi.fn(() => {
            if (step.name === "guarded remove") {
              expect(service.getJob("second")).toBeDefined();
            }
            return undefined;
          });
          await step.invoke(callback);
          expect(resolveName("broken")).toBe(cronEnabled ? undefined : "Broken metadata");
          expect(resolveName("legacy")).toBe("Legacy metadata");
          for (const [jobId, expectedName] of step.expectedNames) {
            expect(resolveName(jobId), `${step.name}: ${jobId}`).toBe(expectedName);
          }
          if (step.singleUse) {
            expect(callback, step.name).toHaveBeenCalledTimes(1);
          } else {
            expect(callback, step.name).toHaveBeenCalled();
          }
          expect.soft(sql.count(), step.name).toBe(0);
        }
        const persisted = (await loadCronJobsStoreWithConfigJobs(storePath)).store.jobs;
        expect(persisted.map((job) => job.id).toSorted()).toEqual([
          "captured-\ufffd",
          "first",
          "guarded",
          "legacy",
        ]);
        expect(persisted.find((job) => job.id === "first")?.name).toBe("precondition update");
        expect(persisted.every((job) => !job.enabled)).toBe(true);
      } finally {
        sql.restore();
        service.stop();
      }
    });
  },
);

it.each([
  "add",
  "update",
  "remove",
  "authority invalidation",
  "runtime update",
  "target runtime update",
] as const)(
  "preserves a committed %s while a guarded scheduler edit awaits admission",
  async (peerMutation) => {
    await withOpenClawTestState({ label: "cron-guarded-peer-write" }, async (fixture) => {
      const storePath = fixture.statePath("cron", "jobs.json");
      const original = cronWorkerFixture();
      for (const job of original.jobs) {
        job.enabled = false;
        job.state = {};
        job.agentId = job.id === "first" ? "alpha" : "beta";
      }
      if (peerMutation === "authority invalidation") {
        const job = expectDefined(original.jobs[1], "authority owner");
        job.sessionTarget = "isolated";
        job.payload = {
          kind: "agentTurn",
          message: "scheduled continuation",
          toolsAllow: ["read", "cron"],
          toolsAllowIsDefault: true,
        };
        job.toolsAllowProvenance = { version: 1, source: "final-executable-surface" };
        job.runtimeAuthority = {
          version: 1,
          runtimeId: "codex",
          namespace: "codex.apps",
          payload: { apps: [{ id: "calendar" }] },
        };
      }
      await saveCronJobsStore(storePath, original);
      const beforePeer = await loadCronJobsStoreWithConfigJobs(storePath);
      expect(beforePeer.jobsFingerprint).toEqual(expect.any(String));
      if (peerMutation === "authority invalidation") {
        expect(beforePeer.store.jobs[1]?.runtimeAuthority).toEqual(
          original.jobs[1]?.runtimeAuthority,
        );
      }
      const service = createService(storePath);
      const entered = createDeferred();
      const release = createDeferred();
      const execute = runtimeMutation.runCronRuntimeMutation;
      const admission = vi
        .spyOn(runtimeMutation, "runCronRuntimeMutation")
        .mockImplementationOnce(async (params) => {
          entered.resolve();
          await release.promise;
          return execute(params);
        });
      const pending = service
        .update(
          "first",
          { name: "guarded edit" },
          { commitGuard: () => expect(service.getJob("first")?.name).toBe("first") },
        )
        .then(
          () => ({ committed: true as const }),
          (error: unknown) => ({ committed: false as const, error }),
        );
      try {
        await entered.promise;
        const peer = structuredClone(original);
        const second = expectDefined(peer.jobs[1], "peer job");
        if (peerMutation === "add") {
          peer.jobs.push({ ...structuredClone(second), id: "peer", name: "peer added" });
        } else if (peerMutation === "update") {
          second.name = "peer updated";
        } else if (peerMutation === "remove") {
          peer.jobs = peer.jobs.filter((job) => job.id !== second.id);
        } else if (peerMutation === "runtime update" || peerMutation === "target runtime update") {
          const target = peerMutation === "target runtime update" ? peer.jobs[0]! : second;
          target.updatedAtMs = 10_000;
          target.state = {
            runningAtMs: 10_000,
            runningReceiptId: "peer-run-receipt",
            nextRunAtMs: 70_000,
          };
        } else {
          second.runtimeAuthorityRecoveryRequired = true;
          delete second.runtimeAuthority;
        }
        // This independent worker write commits while the service retains its older draft.
        if (peerMutation === "runtime update" || peerMutation === "target runtime update") {
          await saveCronJobsStore(storePath, peer, { stateOnly: true });
        } else {
          await saveCronJobsStoreChanges(storePath, original, peer);
        }
        const readPeers = async () =>
          peerJobs((await loadCronJobsStoreWithConfigJobs(storePath)).store.jobs);
        const expectedPeers = peerJobs(peer.jobs);
        expect(await readPeers()).toEqual(expectedPeers);
        if (peerMutation === "authority invalidation" || peerMutation === "runtime update") {
          const invalidated = await loadCronJobsStoreWithConfigJobs(storePath);
          expect(invalidated.jobsFingerprint).toBe(beforePeer.jobsFingerprint);
          if (peerMutation === "authority invalidation") {
            expect(invalidated.store.jobs[1]?.runtimeAuthority).toBeUndefined();
          }
        }
        release.resolve();
        const result = await pending;
        if (!result.committed) {
          expect(result.error).toBeInstanceOf(CronJobsStoreChangedError);
        }
        const settledJobs = (await loadCronJobsStoreWithConfigJobs(storePath)).store.jobs;
        expect(peerJobs(settledJobs)).toEqual(expectedPeers);
        if (peerMutation === "target runtime update") {
          expect(settledJobs[0]?.state).toEqual(peer.jobs[0]?.state);
        }
        if (peerMutation === "authority invalidation") {
          expect(settledJobs[1]?.runtimeAuthority).toBeUndefined();
        }
        expect(settledJobs.find((job) => job.id === "first")?.name).toBe(
          result.committed ? "guarded edit" : "first",
        );
      } finally {
        release.resolve();
        await pending;
        admission.mockRestore();
        service.stop();
      }
    });
  },
);

it.each(["rename", "disable", "remove", "add"] as const)(
  "reloads durable %s state after reply loss without claiming completion or replay",
  async (mutation) => {
    await withOpenClawTestState({ label: "cron-guarded-lost-reply" }, async (fixture) => {
      const storePath = fixture.statePath("cron", "jobs.json");
      const store = cronWorkerFixture();
      for (const job of store.jobs) {
        job.state.nextRunAtMs = Date.now() + 60_000;
      }
      await saveCronJobsStore(storePath, store);
      const resolveName = await prepareCronJobNameResolver(["first", "added"], storePath);
      const onEvent = vi.fn();
      const service = createService(storePath, { onEvent, defaultAgentId: "main" });
      const marker = expectDefined(markCronJobActive("first"), "active run");
      const method =
        mutation === "remove" ? "cron.remove" : mutation === "add" ? "cron.add" : "cron.update";
      const completion = expectDefined(createCronMutationCompletion(method), "mutation receipt");
      const dropped = loseFirstCronMutationReply("cron.mutateJobs");
      const commitGuard = () => {
        expect(service.getJob("first")?.name).toBe("first");
      };
      try {
        const result = await completion
          .run(async () => {
            if (mutation === "remove") {
              return await service.remove("first", { commitGuard });
            }
            if (mutation === "add") {
              return await service.add(
                {
                  id: "added",
                  name: "accepted add",
                  enabled: true,
                  schedule: { kind: "every", everyMs: 60_000 },
                  sessionTarget: "main",
                  wakeMode: "next-heartbeat",
                  payload: { kind: "systemEvent", text: "synthetic event" },
                },
                { commitGuard },
              );
            }
            return await service.update(
              "first",
              {
                name: "accepted edit",
                ...(mutation === "disable" ? { enabled: false } : {}),
              },
              { commitGuard },
            );
          })
          .then(
            () => "reported",
            () => "reply-lost",
          );
        expect(result).toBe("reply-lost");
        expect(dropped.wasDropped()).toBe(true);
        expect(dropped.attempts).toEqual(["cron.mutateJobs"]);
        expect(completion.isCommitted()).toBe(false);
        expect(() => resolveName(mutation === "add" ? "added" : "first")).toThrow("need refresh");
        expect(marker.jobRemoved).not.toBe(true);
        expect(marker.cancellation?.kind).not.toBe("requested");
        expect(onEvent).not.toHaveBeenCalled();
        await dropped.waitForExit();
        const persisted = (await loadCronJobsStoreWithConfigJobs(storePath)).store.jobs;
        const refreshed = await service.list({ includeDisabled: true });
        const byId = (left: { id: string }, right: { id: string }) =>
          left.id.localeCompare(right.id);
        expect(refreshed.toSorted(byId)).toEqual(persisted.toSorted(byId));
        const refreshedName = await prepareCronJobNameResolver(["first", "added"], storePath);
        expect(refreshedName(mutation === "add" ? "added" : "first")).toBe(
          mutation === "remove" ? undefined : mutation === "add" ? "accepted add" : "accepted edit",
        );
        if (mutation === "remove") {
          expect(persisted.some((job) => job.id === "first")).toBe(false);
          expect(service.getJob("first")).toBeUndefined();
        } else {
          const current = persisted.find(
            (job) => job.id === (mutation === "add" ? "added" : "first"),
          );
          expect(current?.name).toBe(mutation === "add" ? "accepted add" : "accepted edit");
          if (mutation === "disable") {
            expect(current?.enabled).toBe(false);
          }
          expect(service.getJob(current!.id)).toEqual(current);
        }
      } finally {
        await dropped.close();
        clearCronJobActive("first", marker);
        service.stop();
      }
    });
  },
);

it.each([false, true])(
  "does not claim removal cleanup after an unknown reply (active=%s)",
  async (active) => {
    await withOpenClawTestState({ label: "cron-removed-reply-cleanup" }, async (fixture) => {
      const storePath = fixture.statePath("cron", "jobs.json");
      const sessionStorePath = fixture.statePath("agents", "main", "sessions", "sessions.json");
      const store = cronWorkerFixture();
      const job = expectDefined(store.jobs[0], "removed job");
      job.sessionTarget = "isolated";
      job.payload = { kind: "agentTurn", message: "synthetic work" };
      await saveCronJobsStore(storePath, store);
      const service = createService(storePath, {
        cronEnabled: false,
        sessionStorePath,
        defaultAgentId: "main",
      });
      const cleanup = vi.spyOn(sessionReaper, "removeCronJobBaseSession").mockResolvedValue(true);
      const marker = active ? markCronJobActive(job.id) : undefined;
      const dropped = loseFirstCronMutationReply("cron.mutateJobs");
      try {
        await expect(service.remove(job.id)).rejects.toThrow();
        expect(dropped.wasDropped()).toBe(true);
        expect(dropped.attempts).toEqual(["cron.mutateJobs"]);
        await dropped.waitForExit();
        expect(
          (await loadCronJobsStoreWithConfigJobs(storePath)).store.jobs.some(
            (row) => row.id === job.id,
          ),
        ).toBe(false);
        await service.list({ includeDisabled: true });
        expect(service.getJob(job.id)).toBeUndefined();
        if (marker) {
          expect(marker.jobRemoved).not.toBe(true);
          clearCronJobActive(job.id, marker);
        }
        expect(cleanup).not.toHaveBeenCalled();
      } finally {
        await dropped.close();
        clearCronJobActive(job.id, marker);
        service.stop();
        cleanup.mockRestore();
      }
    });
  },
);

describe("worker save result publication", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    { ok: true, committed: true },
    { ok: false, committed: true },
    { ok: false, committed: false },
  ])(
    "publishes committed or uncertain saves before success=$ok committed=$committed",
    async ({ ok, committed }) => {
      const storePath = `/synthetic/cron-save-${ok}-${committed}/jobs.json`;
      const failure = new Error("save settlement failed", {
        cause: Object.assign(new Error("database busy"), { code: "SQLITE_BUSY" }),
      });
      const result: CronStoreSaveWorkerOperations["cron.save"]["output"] = ok
        ? {
            ok: true,
            committed,
            value: undefined,
            names: new Map(),
            jobsFingerprint: "synthetic-fingerprint",
            runtimeFingerprint: "synthetic-runtime-fingerprint",
          }
        : { ok: false, committed, error: serializeCronSaveError(failure, storePath) };
      vi.spyOn(stateWorker, "runOpenClawStateWorkerOperation").mockImplementation(
        async (_context, operation) => operation({ execute: vi.fn().mockResolvedValue(result) }),
      );
      const before = getCronJobsStoreRevision(storePath);
      if (ok) {
        await expect(
          saveCronJobsStore(storePath, { version: 1, jobs: [] }),
        ).resolves.toBeUndefined();
      } else {
        await expect(saveCronJobsStore(storePath, { version: 1, jobs: [] })).rejects.toMatchObject({
          message: "save settlement failed",
          cause: { message: "database busy", code: "SQLITE_BUSY" },
        });
      }
      expect(getCronJobsStoreRevision(storePath)).toBeGreaterThan(before);
    },
  );

  it.each(["unchanged", "intervening", "evicted before reply", "evicted after reply"] as const)(
    "returns an operation-bound save revision (%s)",
    async (change) => {
      const storePath = `/synthetic/cron-save-revision-${change}/jobs.json`;
      const pending = createDeferred<CronStoreSaveWorkerOperations["cron.save"]["output"]>();
      vi.spyOn(stateWorker, "runOpenClawStateWorkerOperation").mockImplementation(
        async (_context, operation) =>
          operation({ execute: vi.fn().mockReturnValue(pending.promise) }),
      );
      const evictPartition = () => {
        for (let index = 0; index < 65; index += 1) {
          noteCronJobsStoreCommit(`${storePath}/peer-${index}`);
        }
      };
      const before = getCronJobsStoreRevision(storePath);
      const save = saveCronJobsStoreWithRevision(storePath, { version: 1, jobs: [] });
      if (change !== "unchanged") {
        noteCronJobsStoreCommit(storePath);
      }
      if (change === "evicted before reply") {
        evictPartition();
      }
      pending.resolve({
        ok: true,
        committed: true,
        value: undefined,
        names: new Map(),
        jobsFingerprint: "synthetic-fingerprint",
        runtimeFingerprint: "synthetic-runtime-fingerprint",
      });
      const result = await save;
      const latest = getCronJobsStoreRevision(storePath);
      expect(latest).toBeGreaterThan(before);
      if (change === "unchanged") {
        expect(result.revision).toBe(latest);
      } else {
        expect(result.revision).toBeLessThan(0);
        expect(result.revision).not.toBe(latest);
      }
      if (change.startsWith("evicted")) {
        evictPartition();
        expect(result.revision).not.toBe(getCronJobsStoreRevision(storePath));
      }
    },
  );
});
