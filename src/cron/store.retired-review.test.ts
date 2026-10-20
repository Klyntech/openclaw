import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { runDoctorConfigPreflight } from "../commands/doctor-config-preflight.js";
import { prepareCronOwnerWriteRefusal } from "../config/io.cron-owner-refusal.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { makeCronJob } from "./delivery.test-helpers.js";
import { writeCronJobScratch } from "./scratch-store.js";
import {
  loadCronJobsStoreWithConfigJobs,
  loadCronJobsStoreWithConfigJobsReadOnly,
  saveCronJobsStore,
} from "./store.js";
import { cronStoreKey } from "./store/key.js";

function job(id: string) {
  return makeCronJob({
    id,
    name: id,
    agentId: "main",
    createdAtMs: 1,
    updatedAtMs: 1,
    sessionTarget: "main",
    payload: { kind: "systemEvent", text: "tick" },
  });
}

function legacyReviewJob() {
  return {
    ...job("retired"),
    name: "skill-collection-review-main",
    declarationKey: "skill-collection-review:main",
    systemOwned: true,
    payload: { kind: "skillCollectionReview" },
  };
}

function curatorJob() {
  return {
    ...legacyReviewJob(),
    sessionTarget: "isolated",
    payload: { kind: "agentTurn", message: "Weekly Skill Workshop curator pass." },
    delivery: { mode: "none" },
  };
}

describe("retired Workshop cron jobs", () => {
  it.each(["both", "json-only", "column-only", "curator"])(
    "retires %s legacy rows on an already-current database through mutable load",
    async (shape) => {
      await withOpenClawTestState({ label: "retired-workshop-cron" }, async (state) => {
        const storePath = state.statePath("cron", "jobs.json");
        const otherStorePath = state.statePath("other-cron", "jobs.json");
        const retired = legacyReviewJob();
        await saveCronJobsStore(storePath, { version: 1, jobs: [job("retired"), job("keep")] });
        await saveCronJobsStore(otherStorePath, { version: 1, jobs: [job("retired")] });
        for (const target of [storePath, otherStorePath]) {
          await writeCronJobScratch({
            storePath: target,
            jobId: "retired",
            content: "old scratch",
            nowMs: 1,
          });
        }
        const db = openOpenClawStateDatabase().db;
        const version = db.prepare("PRAGMA user_version").get();
        db.prepare(
          "UPDATE cron_jobs SET payload_kind = ?, job_json = ?, declaration_key = ? WHERE job_id = ?",
        ).run(
          shape === "curator"
            ? "agentTurn"
            : shape === "json-only"
              ? "systemEvent"
              : "skillCollectionReview",
          JSON.stringify(
            shape === "curator" ? curatorJob() : shape === "column-only" ? job("retired") : retired,
          ),
          shape === "curator" ? "skill-collection-review:main" : null,
          "retired",
        );
        const counts = (target: string) =>
          ["cron_jobs", "cron_job_scratch"].map((table) =>
            db
              .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE store_key = ? AND job_id = ?`)
              .get(cronStoreKey(target), "retired"),
          );

        const readOnly = await loadCronJobsStoreWithConfigJobsReadOnly(storePath, state.env);
        expect(readOnly.invalidConfigRows).toEqual([]);
        expect(readOnly.store.jobs.map((entry) => entry.id)).toEqual(["keep"]);
        expect(readOnly.configJobs.map((entry) => entry.id)).toEqual(["keep"]);
        const guard = await prepareCronOwnerWriteRefusal({}, { storePath, env: state.env });
        await guard.recheck();
        expect(counts(storePath)).toEqual([{ count: 1 }, { count: 1 }]);
        const loaded = (await loadCronJobsStoreWithConfigJobs(storePath)).store;
        expect(loaded.jobs.map((entry) => entry.id)).toEqual(["keep"]);
        expect(counts(storePath)).toEqual([{ count: 0 }, { count: 0 }]);
        expect(counts(otherStorePath)).toEqual([{ count: 1 }, { count: 1 }]);
        expect(db.prepare("PRAGMA user_version").get()).toEqual(version);
        expect((await loadCronJobsStoreWithConfigJobs(storePath)).invalidConfigRows).toEqual([]);
      });
    },
  );

  it("allows writable-update Doctor to persist config repair while the retired row remains on disk", async () => {
    await withOpenClawTestState(
      {
        label: "retired-workshop-doctor",
        env: {
          OPENCLAW_UPDATE_IN_PROGRESS: "1",
          OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE: "1",
        },
      },
      async (state) => {
        await state.writeConfig({
          meta: { lastTouchedAt: "2026-09-01T00:00:00.000Z" },
          gateway: { mode: "local" },
          agents: { list: [{ id: "main", default: true }] },
        });
        const storePath = state.statePath("cron", "jobs.json");
        await saveCronJobsStore(storePath, { version: 1, jobs: [job("retired")] });
        const db = openOpenClawStateDatabase().db;
        db.prepare("UPDATE cron_jobs SET payload_kind = ?, job_json = ? WHERE job_id = ?").run(
          "skillCollectionReview",
          JSON.stringify(legacyReviewJob()),
          "retired",
        );

        await expect(
          prepareCronOwnerWriteRefusal({}, { storePath, env: state.env }),
        ).resolves.toHaveProperty("recheck");
        const result = await runDoctorConfigPreflight({
          migrateState: false,
          migrateLegacyConfig: false,
          repairPrefixedConfig: true,
          invalidConfigNote: false,
        });

        expect(result.snapshot.valid).toBe(true);
        const persisted = JSON.parse(await fs.readFile(state.configPath, "utf8"));
        expect(persisted.agents.entries).toHaveProperty("main");
        expect(persisted.agents).not.toHaveProperty("list");
        expect(
          db.prepare("SELECT job_json FROM cron_jobs WHERE job_id = ?").get("retired"),
        ).toEqual({
          job_json: JSON.stringify(legacyReviewJob()),
        });
      },
    );
  });
});
