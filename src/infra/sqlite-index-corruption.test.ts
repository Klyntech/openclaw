import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { flushLogger, resetLogger, setLoggerOverride } from "../logging/logger.js";
import { corruptSqliteIndexKey } from "./sqlite-index-corruption.test-support.js";
import { repairDoctorSqliteIndexCorruption as repairDoctor } from "./sqlite-index-recovery.js";
import { repairSqliteIndexCorruption as repair } from "./sqlite-index-schema.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.restoreAllMocks();
  setLoggerOverride(null);
  resetLogger();
});

const rows = (database: DatabaseSync, sql: string) => database.prepare(sql).all();
const image = (database: DatabaseSync) => ({
  findings: rows(database, "PRAGMA integrity_check"),
  rows: rows(database, "SELECT * FROM audit_events NOT INDEXED"),
  links: rows(database, "SELECT event_id FROM audit_links"),
});

function fixture(replacement = "bravo") {
  const pathname = path.join(tempDirs.make("index-corruption-"), "state.sqlite");
  const database = new DatabaseSync(pathname);
  database.exec(`
    CREATE TABLE audit_events (id INTEGER PRIMARY KEY, event_id TEXT UNIQUE, value TEXT);
    CREATE INDEX audit_value ON audit_events(value);
    INSERT INTO audit_events VALUES (1, 'alpha', 'first'), (2, 'omega', 'later');
    CREATE TABLE audit_links (event_id TEXT REFERENCES audit_events(event_id));
    INSERT INTO audit_links VALUES ('alpha');
  `);
  database.close();
  corruptSqliteIndexKey(pathname, "sqlite_autoindex_audit_events_1", "alpha", replacement);
  const reopened = new DatabaseSync(pathname);
  return { pathname, database: reopened, [Symbol.dispose]: () => reopened.close() };
}

it.each(["bravo", "omega"])(
  "preserves table rows and backs up before UNIQUE index repair (%s)",
  async (replacement) => {
    using state = fixture(replacement);
    const { pathname, database } = state;
    const file = path.join(path.dirname(pathname), "repair.log");
    setLoggerOverride({ level: "info", consoleLevel: "silent", file });
    let clock = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    const before = rows(database, "SELECT * FROM audit_events NOT INDEXED");
    const backup = vi.fn(() => {
      clock += 1_200;
      expect(database.prepare("PRAGMA integrity_check").get()?.integrity_check).not.toBe("ok");
      expect(rows(database, "SELECT * FROM audit_events NOT INDEXED")).toEqual(before);
    });
    expect(repair(database, pathname, { backup, assertCurrent: () => {} })).toEqual([
      "sqlite_autoindex_audit_events_1",
    ]);
    expect(backup).toHaveBeenCalledOnce();
    await flushLogger();
    const holds = fs
      .readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((record) => record.message === "slow SQLite transaction hold");
    expect(holds).toContainEqual(
      expect.objectContaining({
        "1": expect.objectContaining({
          database: pathname,
          operation: "sqlite.index-corruption-repair",
          mode: "immediate",
          elapsedMs: 1_200,
        }),
      }),
    );
    expect(database.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    expect(rows(database, "PRAGMA foreign_key_check")).toEqual([]);
    expect(rows(database, "SELECT event_id FROM audit_links")).toEqual([{ event_id: "alpha" }]);
    expect(rows(database, "SELECT * FROM audit_events NOT INDEXED")).toEqual(before);
    expect(database.prepare("SELECT id FROM audit_events WHERE event_id = 'alpha'").get()).toEqual({
      id: 1,
    });
    expect(() => database.exec("INSERT INTO audit_events(event_id) VALUES ('alpha')")).toThrow(
      /UNIQUE/,
    );
  },
);

it.each([
  ["backup", "", "backup full"],
  // The missing key admits a duplicate that REINDEX must not discard.
  ["UNIQUE constraint", "INSERT INTO audit_events(event_id) VALUES ('alpha')", /UNIQUE/],
  [
    "foreign-key check",
    "PRAGMA foreign_keys=OFF; INSERT INTO audit_links VALUES ('absent')",
    /foreign_key_check failed/,
  ],
] as const)("rolls back and preserves the image after %s failure", (failure, sql, error) => {
  using state = fixture();
  const { pathname, database } = state;
  if (sql) {
    database.exec(sql);
  }
  const before = image(database);
  const backup = vi.fn(() => {
    if (failure === "backup") {
      throw new Error("backup full");
    }
  });
  expect(() => repair(database, pathname, { backup, assertCurrent: () => {} })).toThrow(error);
  expect(backup).toHaveBeenCalledOnce();
  expect(image(database)).toEqual(before);
  expect(database.isTransaction).toBe(false);
});

it("preserves the backup and rolls back when maintenance authority is lost during REINDEX", () => {
  using state = fixture();
  const { pathname, database } = state;
  const authority = new AbortController();
  const exec = database.exec.bind(database);
  vi.spyOn(database, "exec").mockImplementation((sql) => {
    exec(sql);
    if (sql.startsWith("REINDEX ")) {
      authority.abort(new Error("maintenance authority lost after rebuild"));
    }
  });
  const before = image(database);
  expect(() =>
    repairDoctor(database, pathname, {
      label: "audit",
      assertCurrent: () => authority.signal.throwIfAborted(),
    }),
  ).toThrow("maintenance authority lost after rebuild");
  expect(database.isTransaction).toBe(false);
  expect(image(database)).toEqual(before);
  const recovery = fs
    .readdirSync(path.dirname(pathname))
    .find((name) => name.startsWith("openclaw-index-recovery-"));
  expect(recovery).toBeDefined();
  using backup = new DatabaseSync(path.join(path.dirname(pathname), recovery!, "database.sqlite"), {
    readOnly: true,
  });
  expect(image(backup)).toEqual(before);
});

it("refuses structural damage mixed with an index finding without attempting repair", () => {
  const { pathname, database } = fixture();
  database.exec("CREATE TABLE damaged (value TEXT); INSERT INTO damaged VALUES ('intact');");
  const pageSize = Number(database.prepare("PRAGMA page_size").get()?.page_size);
  const rootPage = Number(
    database.prepare("SELECT rootpage FROM sqlite_schema WHERE name = 'damaged'").get()?.rootpage,
  );
  database.close();
  const bytes = fs.readFileSync(pathname);
  bytes[(rootPage - 1) * pageSize] = 0;
  fs.writeFileSync(pathname, bytes);
  using damaged = new DatabaseSync(pathname);
  const backup = vi.fn();
  expect(() => repair(damaged, pathname, { backup, assertCurrent: () => {} })).toThrow(
    /malformed|Unrecognized SQLite integrity finding/,
  );
  expect(backup).not.toHaveBeenCalled();
  expect(fs.readFileSync(pathname)).toEqual(bytes);
});
