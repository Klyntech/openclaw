import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { flushLogger, resetLogger, setLoggerOverride } from "../logging/logger.js";
import { corruptSqliteIndexKey } from "./sqlite-index-corruption.test-support.js";
import { repairDoctorSqliteIndexCorruption } from "./sqlite-index-recovery.js";
import { repairSqliteIndexCorruption } from "./sqlite-index-schema.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.restoreAllMocks();
  setLoggerOverride(null);
  resetLogger();
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

describe("explicit index corruption repair", () => {
  it.each(["bravo", "omega"])(
    "preserves table rows and backs up before UNIQUE index repair (%s)",
    async (replacement) => {
      using state = fixture(replacement);
      const { pathname, database } = state;
      const file = path.join(path.dirname(pathname), "repair.log");
      setLoggerOverride({ level: "info", consoleLevel: "silent", file });
      let clock = Date.now();
      vi.spyOn(Date, "now").mockImplementation(() => clock);
      const before = database.prepare("SELECT * FROM audit_events NOT INDEXED").all();
      const backup = vi.fn(() => {
        clock += 1_200;
        expect(database.prepare("PRAGMA integrity_check").get()?.integrity_check).not.toBe("ok");
        expect(database.prepare("SELECT * FROM audit_events NOT INDEXED").all()).toEqual(before);
      });
      expect(
        repairSqliteIndexCorruption(database, pathname, { backup, assertCurrent: () => {} }),
      ).toEqual(["sqlite_autoindex_audit_events_1"]);
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
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(database.prepare("SELECT event_id FROM audit_links").all()).toEqual([
        { event_id: "alpha" },
      ]);
      expect(database.prepare("SELECT * FROM audit_events NOT INDEXED").all()).toEqual(before);
      expect(
        database.prepare("SELECT id FROM audit_events WHERE event_id = 'alpha'").get(),
      ).toEqual({ id: 1 });
      expect(() => database.exec("INSERT INTO audit_events(event_id) VALUES ('alpha')")).toThrow(
        /UNIQUE/,
      );
    },
  );

  it.each([
    { failure: "backup", sql: "", error: "backup full" },
    {
      failure: "UNIQUE constraint",
      // The missing key admits a duplicate that REINDEX must not discard.
      sql: "INSERT INTO audit_events(event_id) VALUES ('alpha')",
      error: /UNIQUE/,
    },
    {
      failure: "foreign-key check",
      sql: "PRAGMA foreign_keys=OFF; INSERT INTO audit_links VALUES ('absent')",
      error: /foreign_key_check failed/,
    },
  ])(
    "preserves the damaged image and rolls back after $failure failure",
    ({ failure, sql, error }) => {
      using state = fixture();
      const { pathname, database } = state;
      if (sql) {
        database.exec(sql);
      }
      const findings = database.prepare("PRAGMA integrity_check").all();
      const rows = database.prepare("SELECT * FROM audit_events NOT INDEXED").all();
      const links = database.prepare("SELECT event_id FROM audit_links").all();
      const backup = vi.fn(() => {
        if (failure === "backup") {
          throw new Error("backup full");
        }
      });
      expect(() =>
        repairSqliteIndexCorruption(database, pathname, { backup, assertCurrent: () => {} }),
      ).toThrow(error);
      expect(backup).toHaveBeenCalledOnce();
      expect(database.prepare("PRAGMA integrity_check").all()).toEqual(findings);
      expect(database.prepare("SELECT * FROM audit_events NOT INDEXED").all()).toEqual(rows);
      expect(database.prepare("SELECT event_id FROM audit_links").all()).toEqual(links);
      expect(database.isTransaction).toBe(false);
    },
  );

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
    const findings = database.prepare("PRAGMA integrity_check").all();
    const rows = database.prepare("SELECT * FROM audit_events NOT INDEXED").all();
    expect(() =>
      repairDoctorSqliteIndexCorruption(database, pathname, {
        label: "audit",
        assertCurrent: () => authority.signal.throwIfAborted(),
      }),
    ).toThrow("maintenance authority lost after rebuild");
    expect(database.isTransaction).toBe(false);
    expect(database.prepare("PRAGMA integrity_check").all()).toEqual(findings);
    expect(database.prepare("SELECT * FROM audit_events NOT INDEXED").all()).toEqual(rows);
    const recovery = fs
      .readdirSync(path.dirname(pathname))
      .find((name) => name.startsWith("openclaw-index-recovery-"));
    expect(recovery).toBeDefined();
    using backup = new DatabaseSync(
      path.join(path.dirname(pathname), recovery!, "database.sqlite"),
      {
        readOnly: true,
      },
    );
    expect(backup.prepare("PRAGMA integrity_check").all()).toEqual(findings);
    expect(backup.prepare("SELECT * FROM audit_events NOT INDEXED").all()).toEqual(rows);
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
    expect(() =>
      repairSqliteIndexCorruption(damaged, pathname, { backup, assertCurrent: () => {} }),
    ).toThrow(/malformed|Unrecognized SQLite integrity finding/);
    expect(backup).not.toHaveBeenCalled();
    expect(fs.readFileSync(pathname)).toEqual(bytes);
  });
});
