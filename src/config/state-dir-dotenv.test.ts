import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const logWarnSpy = vi.hoisted(() => vi.fn());

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({ warn: logWarnSpy }),
}));

import { readStateDirDotEnvFromStateDir } from "./state-dir-dotenv.js";

describe("readStateDirDotEnvFromStateDir", () => {
  afterEach(() => {
    logWarnSpy.mockClear();
  });

  async function withDir<T>(run: (dir: string) => T | Promise<T>): Promise<T> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-dotenv-test-"));
    try {
      return await run(dir);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }

  async function readEntries(content: string) {
    return withDir(async (dir) => {
      await fs.writeFile(path.join(dir, ".env"), content, "utf8");
      return readStateDirDotEnvFromStateDir(dir).entries;
    });
  }

  it("skips values that are unresolved shell variable references", async () => {
    const content = [
      'SUPERMEMORY_OPENCLAW_API_KEY="${SUPERMEMORY_OPENCLAW_KEY}"',
      "QUOTED_SUPERMEMORY_OPENCLAW_API_KEY='\"$SUPERMEMORY_OPENCLAW_KEY\"'",
      "QUOTED_CURLY_KEY=\"'${ANOTHER_VAR}'\"",
      "BRACE_DEFAULT_KEY=${ANOTHER_VAR:-fallback}",
      "QUOTED_BRACE_DEFAULT_KEY='\"${ANOTHER_VAR:-fallback}\"'",
      'BRACE_TRIM_KEY="${ANOTHER_VAR#prefix}"',
      "BRACE_REPLACE_KEY=${ANOTHER_VAR/pattern/replacement}",
      "BRACE_CASE_KEY=${ANOTHER_VAR^^}",
      'COMMAND_KEY="$(hostname)"',
      "OTHER_KEY=$SOME_SHELL_VAR",
      "CURLY_KEY=${ANOTHER_VAR}",
      "REAL_KEY=actual_value_here",
    ].join("\n");

    expect(await readEntries(content)).toEqual({ REAL_KEY: "actual_value_here" });
  });

  it("preserves credential values that merely contain a dollar sign", async () => {
    const content = [
      "PASSWORD=abc$2!xyz",
      "TOKEN=tok_$prod_v2",
      "PRICE=\\$100",
      "QUOTED_PASSWORD='\"abc$2!xyz\"'",
      "QUOTED_PRICE='\"$100\"'",
      "LEADING_DOLLAR_PASSWORD=$ecret123",
      "LEADING_DOLLAR_TOKEN=$token_1",
      "LOWERCASE_BRACE=${lowercase_literal}",
      "PURE_REF=$SOME_VAR",
    ].join("\n");

    expect(await readEntries(content)).toEqual({
      PASSWORD: "abc$2!xyz",
      TOKEN: "tok_$prod_v2",
      PRICE: "\\$100",
      QUOTED_PASSWORD: '"abc$2!xyz"',
      QUOTED_PRICE: '"$100"',
      LEADING_DOLLAR_PASSWORD: "$ecret123",
      LEADING_DOLLAR_TOKEN: "$token_1",
      LOWERCASE_BRACE: "${lowercase_literal}",
    });
  });

  it("returns empty object when .env is missing", async () => {
    await withDir((dir) => {
      expect(readStateDirDotEnvFromStateDir(dir).entries).toEqual({});
    });
  });

  it("reads a symlinked .env file", async () => {
    await withDir(async (dir) => {
      const realPath = path.join(dir, "real.env");
      await fs.writeFile(realPath, "REAL_KEY=from_symlink_target\n", "utf8");
      await fs.symlink(realPath, path.join(dir, ".env"));
      const result = readStateDirDotEnvFromStateDir(dir).entries;
      expect(result["REAL_KEY"]).toBe("from_symlink_target");
    });
  });

  it("warns when an oversized .env is skipped", async () => {
    await withDir(async (dir) => {
      const large = Buffer.alloc(2 * 1024 * 1024, "x");
      large.write("KEY=value\n", 0, "utf8");
      await fs.writeFile(path.join(dir, ".env"), large);
      const result = readStateDirDotEnvFromStateDir(dir).entries;
      expect(result).toEqual({});
      expect(logWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining("skipping oversized state-directory .env file"),
      );
    });
  });
});
