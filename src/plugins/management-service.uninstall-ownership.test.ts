import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createTestConfigFileStore } from "../commands/test-runtime-config-helpers.js";
import { resolveConfigWriteFollowUp } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { recordInstalledPluginIndexInstallOwner } from "./installed-plugin-index-install-owner.js";
import { pluginConfig } from "./management-service.test-helpers.js";
import { recordPluginManifestInstallOwner } from "./manifest-install-owner.js";

const mocks = vi.hoisted(() => ({
  commitRecords: vi.fn(),
  installRecords: vi.fn(),
  metadata: vi.fn(),
  readConfig: vi.fn(),
  refreshRegistry: vi.fn(),
  replaceConfig: vi.fn(),
}));

vi.mock("../config/config.js", () => ({
  assertConfigWriteAllowedInCurrentMode: () => undefined,
  readConfigFileSnapshotForWrite: () => mocks.readConfig(),
  replaceConfigFile: mocks.replaceConfig,
}));

vi.mock("../config/io.factory.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/io.factory.js")>();
  return {
    ...actual,
    createConfigIO: (options: Parameters<typeof actual.createConfigIO>[0]) => ({
      ...actual.createConfigIO(options),
      readConfigFileSnapshotForWrite: () => mocks.readConfig(),
    }),
  };
});

vi.mock("./install-config.js", () => ({
  persistPluginInstall: vi.fn(),
}));

vi.mock("./install-config-mutation.js", () => ({
  resolveInstallConfigMutationPreflights: () => ({
    hookMutation: { mode: "allowed" },
    pluginMutation: { mode: "allowed" },
  }),
  selectInstallMutationWriteOptions: (writeOptions: unknown) => writeOptions,
}));

vi.mock("./installed-plugin-index-records.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./installed-plugin-index-records.js")>()),
  loadInstalledPluginIndexInstallRecords: mocks.installRecords,
}));

vi.mock("./plugin-metadata-snapshot.js", () => ({
  loadPluginMetadataSnapshot: mocks.metadata,
  resolvePluginMetadataSnapshot: mocks.metadata,
}));

vi.mock("./install-record-commit.js", () => ({
  commitPluginInstallRecordsWithConfig: mocks.commitRecords,
}));

vi.mock("./registry-refresh.js", () => ({
  refreshPluginRegistryAfterConfigMutation: mocks.refreshRegistry,
}));

const { uninstallManagedPlugin } = await import("./management-uninstall.js");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
type CommitRequest = Parameters<
  typeof import("./install-record-commit.js").commitPluginInstallRecordsWithConfig
>[0];

function expectCommit(nextConfig: unknown) {
  expect(mocks.commitRecords).toHaveBeenCalledWith(
    expect.objectContaining({ nextConfig, nextInstallRecords: {} }),
  );
}

function mockPackage(
  owner: string,
  record: PluginInstallRecord,
  plugins: Parameters<typeof packageMetadata>[2],
) {
  const records = { [owner]: record };
  mocks.installRecords.mockResolvedValue(records);
  mocks.metadata.mockReturnValue(packageMetadata(owner, records, plugins));
}

function mockOrphan(owner: string, record: PluginInstallRecord, plugins: object[]) {
  const installRecords = { [owner]: record };
  mocks.installRecords.mockResolvedValue(installRecords);
  mocks.metadata.mockReturnValue({
    index: { installRecords, plugins },
    byPluginId: new Map(),
    normalizePluginId: (id: string) => id,
  });
}

async function mutableConfig(
  configPath: string,
  config: OpenClawConfig,
  hash = "base-hash",
  replaceHash?: string,
) {
  const configFiles = createTestConfigFileStore();
  const state = {
    config,
    async write(next: OpenClawConfig, persistedHash?: string) {
      state.config = next;
      await fs.writeFile(configPath, JSON.stringify(next));
      return {
        ...configFiles.write(next, configPath),
        ...(persistedHash ? { persistedHash, persistedSourceConfig: next } : {}),
      };
    },
  };
  await fs.writeFile(configPath, JSON.stringify(config));
  mockConfig(configPath, () => state.config, hash);
  mocks.replaceConfig.mockImplementation(({ sourceConfig }: { sourceConfig: OpenClawConfig }) =>
    state.write(sourceConfig, replaceHash),
  );
  return state;
}

function mockConfig(
  configPath: string,
  source: OpenClawConfig | (() => OpenClawConfig | Promise<OpenClawConfig>),
  hash = "base-hash",
) {
  mocks.readConfig.mockImplementation(async () => {
    const config = typeof source === "function" ? await source() : source;
    return {
      snapshot: {
        valid: true,
        parsed: typeof source === "function" ? config : {},
        path: configPath,
        sourceConfig: config,
        hash,
      },
      writeOptions: { expectedConfigPath: configPath },
    };
  });
}

function packageMetadata(
  owner: string,
  records: Record<string, PluginInstallRecord>,
  plugins: { id: string; enabled?: boolean; channels?: string[]; source?: string }[],
) {
  return {
    index: {
      plugins: plugins.map(({ id, enabled }) =>
        recordInstalledPluginIndexInstallOwner(
          { pluginId: id, origin: "global", enabled, rootDir: records[owner]?.installPath },
          owner,
        ),
      ),
      installRecords: records,
    },
    byPluginId: new Map(
      plugins.map(({ id, channels = [], source }) => [
        id,
        recordPluginManifestInstallOwner({ id, channels, ...(source ? { source } : {}) }, owner),
      ]),
    ),
    normalizePluginId: (id: string) => id,
  };
}

describe("plugin management uninstall channel ownership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const configFiles = createTestConfigFileStore();
    mocks.commitRecords.mockImplementation(async ({ nextConfig, writeOptions }: CommitRequest) => {
      const configPath = expectDefined(
        writeOptions?.ownedConfigPathForWrite ?? writeOptions?.expectedConfigPath,
        "fixture config write path",
      );
      const afterWrite = writeOptions?.afterWrite ?? { mode: "auto" as const };
      return {
        configWrite: {
          ...configFiles.write(nextConfig, configPath),
          persistedHash: "committed",
          persistedSourceConfig: nextConfig,
          afterWrite,
          followUp: resolveConfigWriteFollowUp(afterWrite),
        },
      };
    });
  });

  it("preserves manifest channel ownership when uninstalling a disabled channel plugin", async () => {
    const root = tempDirs.make("openclaw-managed-linked-uninstall-");
    const configPath = path.join(root, "openclaw.json");
    const pluginId = "custom-plugin";
    const installPath = "/tmp/openclaw-managed-linked-custom-plugin";
    const installRecord = { source: "path", sourcePath: installPath, installPath } as const;
    const channels = {
      [pluginId]: { enabled: true },
      "owned-channel": { enabled: true },
      "owned-channel-backup": { enabled: true },
      discord: { enabled: true },
    };
    mockConfig(configPath, { ...pluginConfig({ [pluginId]: false }), channels });
    mockPackage(pluginId, installRecord, [
      { id: pluginId, enabled: false, channels: ["owned-channel", "owned-channel-backup"] },
    ]);

    const result = await uninstallManagedPlugin({
      pluginId,
      env: { OPENCLAW_STATE_DIR: root },
    });

    expectCommit(
      expect.objectContaining({
        channels: { [pluginId]: { enabled: true }, discord: { enabled: true } },
      }),
    );
    expect(result.removed).toEqual(["plugin settings", "install record", "channel config"]);
  });

  it.each(["missing children", "overlapping orphan"])("fails closed for %s", async (mode) => {
    const orphan = mode === "overlapping orphan";
    const pluginId = orphan ? "orphaned-plugin" : "custom-plugin";
    const installPath = "/tmp/openclaw-managed-missing-children";
    const installRecord = { source: "path", sourcePath: installPath, installPath } as const;
    mockConfig("/tmp/openclaw.json", orphan ? {} : pluginConfig({ [pluginId]: true }));
    mockOrphan(pluginId, installRecord, [
      orphan
        ? recordInstalledPluginIndexInstallOwner(
            { pluginId: "other", origin: "global", enabled: true, rootDir: installPath },
            "other",
          )
        : { pluginId, origin: "global", enabled: true, rootDir: installPath },
    ]);

    await expect(uninstallManagedPlugin({ pluginId, env: {} })).rejects.toThrow(
      orphan ? "no authoritative runtime child list" : "no authoritative package-owner metadata",
    );
    expect(mocks.commitRecords).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "preserves another channel owner during managed orphan uninstall: %s",
    async (claimed) => {
      const root = tempDirs.make("openclaw-managed-orphan-uninstall-");
      const configPath = path.join(root, "openclaw.json");
      const pluginId = "orphaned-plugin";
      const installRecord = {
        source: "path",
        sourcePath: path.join(root, "missing-orphan-source"),
        installPath: path.join(root, "missing-orphan-install"),
      } as const;
      await mutableConfig(configPath, {
        ...pluginConfig({ [pluginId]: true }),
        channels: { [pluginId]: { enabled: true }, unknown: { enabled: true } },
      });
      mockOrphan(
        pluginId,
        installRecord,
        claimed
          ? [
              {
                pluginId: "bridge",
                rootDir: "/tmp/bridge",
                startup: { agentHarnesses: [] },
                contributions: { channels: [pluginId] },
              },
            ]
          : [],
      );

      const result = await uninstallManagedPlugin({
        pluginId,
        env: { OPENCLAW_STATE_DIR: root },
      });

      expectCommit({
        channels: {
          ...(claimed ? { [pluginId]: { enabled: true } } : {}),
          unknown: { enabled: true },
        },
        ...pluginConfig({ [pluginId]: false }),
      });
      expect(result.pluginId).toBe(pluginId);
      expect(result.removed).toContain("install record");
    },
  );

  it("resolves a child request to one package owner and removes every sibling policy", async () => {
    const root = tempDirs.make("openclaw-managed-child-uninstall-");
    const configPath = path.join(root, "openclaw.json");
    const installPath = "/tmp/openclaw-managed-linked-pack";
    const installRecord = { source: "path", sourcePath: installPath, installPath } as const;
    mockConfig(
      configPath,
      pluginConfig(
        { "pack/one": true, "pack/two": false, other: true },
        { allow: ["pack/one", "pack/two", "other"] },
      ),
      "pack-hash",
    );
    mockPackage("pack", installRecord, [
      { id: "pack/one", enabled: true },
      { id: "pack/two", enabled: false },
    ]);

    const result = await uninstallManagedPlugin({
      pluginId: "pack/two",
      env: { OPENCLAW_STATE_DIR: root },
    });

    expectCommit({
      channels: undefined,
      ...pluginConfig({ other: true, "pack/one": false, "pack/two": false }, { allow: ["other"] }),
    });
    expect(result.pluginId).toBe("pack");
    expect(result.warnings).toContain(
      'Uninstalled package "pack" and all owned plugin entries: pack/one, pack/two.',
    );
  });

  it.each([true, false])(
    "retains uninstall ownership when runtime drain rejects (linked=%s)",
    async (linked) => {
      const root = await fs.realpath(tempDirs.make("uninstall-runtime-refusal-"));
      const configPath = path.join(root, "openclaw.json");
      const sourcePath = path.join(root, "source");
      const installPath = linked ? sourcePath : path.join(root, "extensions", "demo");
      await fs.mkdir(installPath, { recursive: true });
      await fs.writeFile(path.join(installPath, "index.js"), "export default {};\n");
      const installRecord = { source: "path" as const, sourcePath, installPath };
      let records: Record<string, PluginInstallRecord> = { demo: installRecord };
      const state = await mutableConfig(
        configPath,
        pluginConfig({ demo: true }, { load: { paths: [installPath] } }),
        "current",
        "disabled",
      );
      mocks.installRecords.mockImplementation(async () => records);
      mocks.commitRecords.mockImplementation(
        async ({ nextConfig, nextInstallRecords, writeOptions }: CommitRequest) => {
          records = nextInstallRecords;
          const afterWrite = writeOptions?.afterWrite ?? { mode: "auto" as const };
          return {
            configWrite: {
              ...(await state.write(nextConfig, "removed")),
              afterWrite,
              followUp: resolveConfigWriteFollowUp(afterWrite),
            },
          };
        },
      );
      mocks.metadata.mockImplementation(() =>
        packageMetadata(
          "demo",
          records,
          records.demo
            ? [
                {
                  id: "demo",
                  enabled: state.config.plugins?.entries?.demo?.enabled,
                  source: path.join(installPath, "index.js"),
                },
              ]
            : [],
        ),
      );
      const failure = new Error("synthetic runtime replacement refused");
      let generation = 0;
      const applyRuntime = vi
        .fn<NonNullable<Parameters<typeof uninstallManagedPlugin>[0]["applyRuntime"]>>(
          async () => ({ operationId: "uninstall", generation: ++generation, pluginIds: ["demo"] }),
        )
        .mockRejectedValueOnce(failure);
      const request = {
        pluginId: "demo",
        keepFiles: false,
        env: { OPENCLAW_STATE_DIR: root },
        applyRuntime,
      };
      await expect(uninstallManagedPlugin(request)).rejects.toBe(failure);
      expect(state.config.plugins?.entries?.demo?.enabled).toBe(false);
      expect(records.demo).toEqual(installRecord);
      expect(mocks.commitRecords).not.toHaveBeenCalled();
      expect((await fs.stat(installPath)).isDirectory()).toBe(true);

      const result = await uninstallManagedPlugin(request);
      expect(result.pluginId).toBe("demo");
      expect(records.demo).toBeUndefined();
      expect(state.config.plugins?.entries?.demo?.enabled).toBe(false);
      expect(state.config.plugins?.load?.paths ?? []).not.toContain(installPath);
      expect(mocks.commitRecords).toHaveBeenCalledOnce();
      if (linked) {
        expect((await fs.stat(installPath)).isDirectory()).toBe(true);
      } else {
        await expect(fs.stat(installPath)).rejects.toMatchObject({ code: "ENOENT" });
      }
    },
  );

  it("keeps config readable after removing an aliased package and preserves intervening edits", async () => {
    const root = await fs.realpath(tempDirs.make("openclaw-managed-uninstall-alias-"));
    const configPath = path.join(root, "openclaw.json");
    const configFiles = createTestConfigFileStore();
    const sourcePath = path.join(root, "source");
    const installPath = path.join(root, "extensions", "demo");
    const aliasPath = path.join(root, "alias");
    const unrelatedPath = path.join(root, "unrelated");
    const addedPath = path.join(root, "added");
    await Promise.all(
      [sourcePath, installPath, unrelatedPath, addedPath].map((dir) =>
        fs.mkdir(dir, { recursive: true }),
      ),
    );
    await fs.symlink(installPath, aliasPath, "dir");
    const installRecord = { source: "path" as const, sourcePath, installPath };
    let currentConfig: OpenClawConfig = pluginConfig(
      { demo: true },
      { load: { paths: [aliasPath, unrelatedPath] } },
    );
    await fs.writeFile(configPath, JSON.stringify(currentConfig));
    mockConfig(
      configPath,
      async () => {
        for (const loadPath of currentConfig.plugins?.load?.paths ?? []) {
          await fs.stat(loadPath);
        }
        return currentConfig;
      },
      "current-hash",
    );
    mocks.replaceConfig.mockImplementation(
      async ({ sourceConfig }: { sourceConfig: OpenClawConfig }) => {
        expect(sourceConfig.plugins?.load?.paths).toEqual([unrelatedPath]);
        currentConfig = {
          ...sourceConfig,
          logging: { level: "debug" },
          plugins: { ...sourceConfig.plugins, load: { paths: [unrelatedPath, addedPath] } },
        };
        await fs.writeFile(configPath, JSON.stringify(currentConfig));
        return configFiles.write(currentConfig, configPath);
      },
    );
    mockPackage("demo", installRecord, [
      {
        id: "demo",
        enabled: true,
        source: path.join(installPath, "index.js"),
      },
    ]);

    const cleanupWarning = "Previous plugin cleanup failed.";
    const finalApplication = { operationId: "final", generation: 2, pluginIds: ["demo"] };
    const applyRuntime = vi
      .fn()
      .mockResolvedValueOnce({
        operationId: "disable",
        generation: 1,
        pluginIds: ["demo"],
        warnings: [cleanupWarning],
      })
      .mockResolvedValueOnce(finalApplication);
    const result = await uninstallManagedPlugin({
      pluginId: "demo",
      env: { OPENCLAW_STATE_DIR: root },
      applyRuntime,
    });

    expect(result.application).toEqual({ ...finalApplication, warnings: [cleanupWarning] });
    expect(result.warnings).toContain(cleanupWarning);
    expect(result.removed).toContain("load path");
    expectCommit(
      expect.objectContaining({
        logging: { level: "debug" },
        ...pluginConfig({ demo: false }, { load: { paths: [unrelatedPath, addedPath] } }),
      }),
    );
    await expect(fs.stat(installPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await fs.stat(sourcePath)).isDirectory()).toBe(true);
  });
});
