import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import {
  readSqliteBusyTimeout as readTimeout,
  runWithSqliteBusyTimeout as withTimeout,
  setSqliteBusyTimeout as writeTimeout,
  shouldReportSqliteLockFailure as reportsLocks,
} from "./sqlite-busy-timeout.js";
import { runSqliteImmediateTransactionSync } from "./sqlite-transaction.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => vi.restoreAllMocks());
const timeoutOf = (database: DatabaseSync) => database.prepare("PRAGMA busy_timeout").get();
const suppress = { lockFailureReporting: "suppress" } as const;

it("adopts an omitted constructor timeout and restores it after success and failure", () => {
  using database = openNodeSqliteDatabase(":memory:");
  database.exec("PRAGMA busy_timeout = 5000");

  expect(withTimeout(database, 0, () => timeoutOf(database))).toEqual({ timeout: 0 });
  expect(timeoutOf(database)).toEqual({ timeout: 5000 });

  expect(() =>
    withTimeout(database, 25, () => {
      throw new Error("operation failed");
    }),
  ).toThrow("operation failed");
  expect(timeoutOf(database)).toEqual({ timeout: 5000 });
});

it.each([
  [-1, 0],
  [0, 0],
  [37, 37],
])("retains explicit constructor timeout %s as %s without SQL", (timeout, expected) => {
  using database = openNodeSqliteDatabase(":memory:", { timeout });
  const prepare = vi.spyOn(database, "prepare");
  const exec = vi.spyOn(database, "exec");
  expect(readTimeout(database)).toBe(expected);
  writeTimeout(database, expected);
  expect([prepare.mock.calls, exec.mock.calls]).toEqual([[], []]);
  prepare.mockRestore();
  exec.mockRestore();
  expect(timeoutOf(database)).toEqual({ timeout: expected });
  withTimeout(database, 25, () => {
    expect(timeoutOf(database)).toEqual({ timeout: 25 });
  });
  expect(timeoutOf(database)).toEqual({ timeout: expected });
});

it("restores timeout and lock reporting before the admitted operation finishes", () => {
  using database = new DatabaseSync(":memory:");
  database.exec("PRAGMA busy_timeout = 5000");
  const exec = vi.spyOn(database, "exec");
  const restoreEarly = (restore: () => void) => {
    expect(reportsLocks(database)).toBe(false);
    restore();
    expect([timeoutOf(database), reportsLocks(database)]).toEqual([{ timeout: 5000 }, true]);
  };
  withTimeout(database, 25, restoreEarly, suppress);
  expect([timeoutOf(database), reportsLocks(database)]).toEqual([{ timeout: 5000 }, true]);
  expect(exec.mock.calls).toEqual([["PRAGMA busy_timeout = 25"], ["PRAGMA busy_timeout = 5000"]]);
});

it.each([undefined, { timeout: 19 }, { timeout: 37, open: false }])(
  "discards changed policy across close/reopen with constructor options %j",
  (options) => {
    using database = options
      ? openNodeSqliteDatabase(":memory:", options)
      : new DatabaseSync(":memory:");
    if (!database.isOpen) {
      database.open();
    }
    const timeout = options?.timeout ?? 0;
    expect(readTimeout(database)).toBe(timeout);
    writeTimeout(database, 73);
    database.close();
    database.open();
    expect(readTimeout(database)).toBe(timeout);
    withTimeout(database, 25, () => undefined);
    expect(timeoutOf(database)).toEqual({ timeout });
  },
);

it("rejects an invalid timeout", () => {
  using database = new DatabaseSync(":memory:");
  expect(() => withTimeout(database, -1, () => undefined)).toThrow(
    "busyTimeoutMs must be a non-negative integer",
  );
});

it("suppresses expected lock warnings only for the scoped attempt", () => {
  const databasePath = path.join(tempDirs.make("sqlite-busy-timeout-"), "state.sqlite");
  using database = new DatabaseSync(databasePath);
  using contender = new DatabaseSync(databasePath);
  const logger = { warn: vi.fn() };
  database.exec("PRAGMA journal_mode = WAL; CREATE TABLE entries (id TEXT PRIMARY KEY)");
  contender.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");

  const attempt = () =>
    runSqliteImmediateTransactionSync(database, () => undefined, {
      busyTimeoutMs: 0,
      logger,
    });
  expect(() => withTimeout(database, 0, attempt, suppress)).toThrow();
  expect(logger.warn).not.toHaveBeenCalled();
});
