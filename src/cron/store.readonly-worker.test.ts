import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { expect, it } from "vitest";
import { observeSqliteReadSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { collectLegacyCronStoreHealthFindings } from "../commands/doctor/cron/index.js";
import { withArtifactPreservingStateReads } from "../state/openclaw-state-db-readonly.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { makeCronJob } from "./delivery.test-helpers.js";
import {
  loadCronJobsStoreWithConfigJobsReadOnly,
  resolveCronJobsStorePath,
  saveCronJobsStore,
  saveCronQuarantinedJobs,
} from "./store.js";
import type { CronStoreFile } from "./types.js";

it.each([false, true])(
  "reports persisted quarantine through Doctor without caller-thread queries (cold=%s)",
  async (cold) => {
    await withOpenClawTestState({ label: "cron-quarantine-doctor" }, async (state) => {
      await saveCronQuarantinedJobs({
        storePath: resolveCronJobsStorePath(),
        entries: [{ sourceIndex: 0, reason: "missing-schedule", job: { id: "quarantined-job" } }],
        nowMs: 123,
      });
      if (cold) {
        await closeOpenClawStateDatabaseByPathAsync(resolveOpenClawStateSqlitePath(state.env));
      }
      const observation = observeSqliteReadSql(StatementSync.prototype);
      try {
        const findings = await collectLegacyCronStoreHealthFindings({ cfg: {} });
        expect(findings).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              requirement: "quarantined-cron-rows",
              message: expect.stringContaining("1 quarantined cron job row"),
            }),
          ]),
        );
        expect(observation.queries.filter((sql) => sql.includes('"diagnostic_events"'))).toEqual(
          [],
        );
      } finally {
        observation.restore();
      }
    });
  },
);

it.each([false, true])(
  "loads cold readonly cron state off the host with artifact preservation=%s",
  async (preserveArtifacts) => {
    await withOpenClawTestState({ label: "cron-readonly-worker" }, async (state) => {
      const storePath = state.statePath("cron", "jobs.json");
      const databasePath = resolveOpenClawStateSqlitePath(state.env);
      const store: CronStoreFile = {
        version: 1,
        jobs: [
          makeCronJob({
            id: "readonly-job",
            name: "scheduled café 🦞",
            createdAtMs: 1,
            updatedAtMs: 2,
            sessionTarget: "main",
            payload: { kind: "systemEvent", text: "persisted event" },
            state: { nextRunAtMs: 60_001 },
          }),
        ],
      };
      await saveCronJobsStore(storePath, store);
      await closeOpenClawStateDatabaseByPathAsync(databasePath);
      const before = await fs.readFile(databasePath);
      const sql = observeMainThreadSql({ includeClose: true });
      try {
        const read = () => loadCronJobsStoreWithConfigJobsReadOnly(storePath, state.env);
        const loaded = await (preserveArtifacts ? withArtifactPreservingStateReads(read) : read());
        expect(loaded.store).toEqual(store);
        expect(loaded.configJobIndexes).toEqual([0]);
        expect(loaded.configJobRuntimeEntries[0]?.state).toEqual({ nextRunAtMs: 60_001 });
        expect(loaded.jobsFingerprint).toBeUndefined();
        expect(loaded.invalidConfigRows).toEqual([]);
        sql.expectIdle();
        expect(await fs.readFile(databasePath)).toEqual(before);
      } finally {
        sql.restore();
      }
    });
  },
);

it("leaves missing databases absent and legacy layouts unmigrated", async () => {
  await withOpenClawTestState({ label: "cron-readonly-legacy" }, async (state) => {
    const storePath = state.statePath("cron", "jobs.json");
    const databasePath = resolveOpenClawStateSqlitePath(state.env);
    const empty = await loadCronJobsStoreWithConfigJobsReadOnly(storePath, state.env);
    expect(empty.store).toEqual({ version: 1, jobs: [] });
    await expect(fs.stat(databasePath)).rejects.toMatchObject({ code: "ENOENT" });
    await fs.mkdir(path.dirname(databasePath), { recursive: true });
    const db = new DatabaseSync(databasePath);
    db.exec("CREATE TABLE legacy_marker(value TEXT); PRAGMA user_version = 1;");
    db.close();
    const before = await fs.readFile(databasePath);
    expect(
      await withArtifactPreservingStateReads(() =>
        loadCronJobsStoreWithConfigJobsReadOnly(storePath, state.env),
      ),
    ).toEqual(empty);
    expect(await fs.readFile(databasePath)).toEqual(before);
    expect(await loadCronJobsStoreWithConfigJobsReadOnly(storePath, state.env)).toEqual(empty);
    expect(await fs.readFile(databasePath)).toEqual(before);
  });
});

it("preserves native diagnostic errors without repairing an incompatible cron table", async () => {
  await withOpenClawTestState({ label: "cron-readonly-diagnostic" }, async (state) => {
    const databasePath = resolveOpenClawStateSqlitePath(state.env);
    await fs.mkdir(path.dirname(databasePath), { recursive: true });
    const db = new DatabaseSync(databasePath);
    db.exec("CREATE TABLE cron_jobs(legacy_column TEXT)");
    db.close();
    const before = await fs.readFile(databasePath);
    await expect(
      loadCronJobsStoreWithConfigJobsReadOnly(state.statePath("cron", "jobs.json"), state.env),
    ).rejects.toMatchObject({
      code: "ERR_SQLITE_ERROR",
      message: expect.stringContaining("no such column"),
    });
    expect(await fs.readFile(databasePath)).toEqual(before);
  });
});
