import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { RecoveryCleanupReport } from "../../commands/doctor-session-sqlite-recovery-inventory.js";
import { resolveUpdateCaptureRoot } from "../../infra/update-capture-paths.js";
import {
  UPDATE_CAPTURE_PRIVACY_MARKER,
  UPDATE_CAPTURE_PRIVACY_MARKER_CONTENT,
} from "../../infra/update-capture-privacy-marker.js";
import { createUpdateRun, finishUpdateRun } from "../../infra/update-run-ledger.js";
import { defaultRuntime } from "../../runtime.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { updateCleanupCommand } from "./cleanup.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(async () => {
  await cleanupSessionStateForTest();
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
});

function writeCapture(root: string, name: string, sealed: boolean, marked = true): string {
  const directory = path.join(root, name);
  fs.mkdirSync(path.join(directory, "payload"), { recursive: true });
  fs.mkdirSync(path.join(directory, "database.databases"));
  if (marked) {
    fs.writeFileSync(
      path.join(directory, UPDATE_CAPTURE_PRIVACY_MARKER),
      UPDATE_CAPTURE_PRIVACY_MARKER_CONTENT,
    );
  }
  fs.writeFileSync(path.join(directory, "payload", "0"), Buffer.alloc(1000));
  if (sealed) {
    fs.writeFileSync(path.join(directory, "manifest.json"), "{}\n");
  }
  return directory;
}

/** Finished updates, one failed baseline, the latest update, a live run, and unattributed entries. */
async function withCaptureHistory(
  run: (captures: Record<string, string>, root: string) => Promise<void>,
  location: "current" | "pre-migration",
) {
  // Both current and pre-migration captures are siblings of their state directories.
  const home = fs.realpathSync(dirs.make("update-capture-cleanup-"));
  const stateDir = path.join(home, ".openclaw");
  fs.mkdirSync(stateDir);
  const env = {
    HOME: home,
    OPENCLAW_HOME: undefined,
    OPENCLAW_PROFILE: undefined,
    OPENCLAW_STATE_DIR: undefined,
    OPENCLAW_CONFIG_PATH: undefined,
  };
  await withEnvAsync(env, async () => {
    const root = resolveUpdateCaptureRoot(
      location === "pre-migration" ? path.join(home, ".clawdbot") : stateDir,
    );
    fs.mkdirSync(root);
    fs.writeFileSync(
      path.join(root, UPDATE_CAPTURE_PRIVACY_MARKER),
      UPDATE_CAPTURE_PRIVACY_MARKER_CONTENT,
    );
    const clock = vi.spyOn(Date, "now");
    const captures: Record<string, string> = {};
    let now = Date.UTC(2026, 8, 30);
    for (const [label, status, sealed] of [
      ["superseded", "succeeded", true],
      ["unsealed", "failed", false],
      ["alreadyCurrent", "skipped", true],
      ["failedBaseline", "failed", true],
      ["latest", "succeeded", false],
      ["unfinished", undefined, true],
    ] as const) {
      clock.mockReturnValue((now += 60_000));
      const { runId } = createUpdateRun({ trigger: "cli" }, { env });
      if (status) {
        clock.mockReturnValue((now += 60_000));
        finishUpdateRun(runId, { status }, { env });
      }
      captures[label] = writeCapture(root, runId, sealed);
    }
    clock.mockRestore();
    captures.unattributed = writeCapture(root, "doctor-unrecorded", true);
    captures.unmarked = writeCapture(root, "c0ffee00-0000-4000-8000-000000000000", true, false);
    closeOpenClawStateDatabaseForTest();
    await run(captures, root);
  });
}

async function runCleanup(options: { dryRun?: boolean; yes?: boolean }) {
  const writeJson = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
  const exit = vi.spyOn(defaultRuntime, "exit").mockImplementation(() => undefined as never);
  await updateCleanupCommand({ ...options, json: true });
  expect(exit).not.toHaveBeenCalled();
  const report = writeJson.mock.calls.at(-1)?.[0] as RecoveryCleanupReport;
  return {
    status: report.status,
    captures: Object.fromEntries(
      report.artifacts
        .filter((item) => item.kind === "update-capture")
        .map(({ path: directory, outcome, reason, bytes }) => [
          directory,
          { outcome, reason, bytes },
        ]),
    ),
  };
}

const expectedPreview = (captures: Record<string, string>) =>
  Object.fromEntries(
    (
      [
        ["superseded", "candidate", "superseded-update-capture", 1038],
        ["unsealed", "candidate", "unsealed-update-capture", 1035],
        ["alreadyCurrent", "candidate", "superseded-update-capture", 1038],
        ["failedBaseline", "protected", "unresolved-failed-update", 1038],
        ["latest", "protected", "awaiting-later-completed-update", 1035],
        ["unfinished", "protected", "unfinished-update-run", 1038],
        ["unattributed", "protected", "unmanifested-update-capture", 1038],
        ["unmarked", "protected", "unmanifested-update-capture", 1003],
      ] as const
    ).map(
      ([label, outcome, reason, bytes]) => [captures[label], { outcome, reason, bytes }] as const,
    ),
  );

it.each([
  ["current", true],
  ["current", false],
  ["pre-migration", true],
  ["pre-migration", false],
] as const)(
  "classifies %s captures and removes only candidates (dry-run=%s)",
  async (location, dryRun) => {
    await withCaptureHistory(async (captures, root) => {
      using stderr = vi.spyOn(process.stderr, "write").mockImplementation((text) => {
        if (!String(text).startsWith("Removing capture ")) {
          return true;
        }
        const directory = Object.values(captures).find((item) => String(text).includes(item));
        expect(directory).toBeDefined();
        expect(fs.existsSync(directory!)).toBe(true);
        return true;
      });
      const result = await runCleanup({ dryRun, yes: !dryRun });
      const progress = stderr.mock.calls
        .map(([text]) => String(text))
        .filter((text) => text.startsWith("Removing capture "));
      expect(progress).toHaveLength(dryRun ? 0 : 3);
      for (const [index, text] of progress.entries()) {
        expect(text).toMatch(
          new RegExp(`^Removing capture ${index + 1}/3: .+ \\(103[58] bytes\\)\\n$`),
        );
      }
      const expected = Object.entries(expectedPreview(captures)).map(([directory, item]) => {
        const remove = !dryRun && item.outcome === "candidate";
        expect(fs.existsSync(directory)).toBe(!remove);
        return [
          directory,
          remove
            ? { outcome: "removed", reason: "update-capture-retired", bytes: item.bytes }
            : item,
        ];
      });
      expect(result).toEqual({
        status: dryRun ? "preview" : "complete",
        captures: Object.fromEntries(expected),
      });
      expect(fs.existsSync(path.join(root, UPDATE_CAPTURE_PRIVACY_MARKER))).toBe(true);
    }, location);
  },
);

it.each(["current", "pre-migration"] as const)(
  "lists standalone Doctor captures and retires only older %s captures through cleanup",
  async (location) => {
    await withCaptureHistory(async (_captures, root) => {
      const now = Date.now();
      const configPath = path.join(root, "config.json");
      const doctors = [5, 4, 3, 2, 1].map((age) => {
        const runId = `doctor-${randomUUID()}`;
        const directory = writeCapture(root, runId, true);
        const manifest = {
          schemaVersion: 2,
          kind: "update-recovery",
          generation: { kind: "baseline" },
          databases: [],
          runId,
          installRoot: root,
          stateDir: path.dirname(root),
          configPath,
          configPaths: [configPath],
          creator: { host: "fixture", pid: 1, startIdentity: "1" },
          drivers: [],
          createdAt: new Date(now - age * 86_400_000).toISOString(),
          roots: [configPath],
          excludedRoots: [],
          protectedPaths: [configPath],
          entries: [{ kind: "missing", sourcePath: configPath, sqlite: false, directory: false }],
        };
        fs.writeFileSync(path.join(directory, "manifest.json"), JSON.stringify(manifest));
        return directory;
      });
      const preview = await runCleanup({ dryRun: true });
      for (const [index, directory] of doctors.entries()) {
        expect(preview.captures[directory]).toMatchObject({
          outcome: index < 2 ? "candidate" : "protected",
          reason: index < 2 ? "superseded-doctor-capture" : "retained-doctor-capture",
        });
        expect(preview.captures[directory]!.bytes).toBeGreaterThan(1000);
        expect(fs.existsSync(directory)).toBe(true);
      }
      await runCleanup({ yes: true });
      expect(doctors.map(fs.existsSync)).toEqual([false, false, true, true, true]);
    }, location);
  },
);
