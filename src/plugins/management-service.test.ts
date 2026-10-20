import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginsReloadParams } from "../../packages/gateway-protocol/src/schema/plugins.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { assertConfigWriteAllowedInCurrentMode } from "../config/config-write-guard.js";
import { buildPluginCapabilitySummary, computeDeclaredSurfaceHash } from "./capability-summary.js";
import { hashStableJson } from "./installed-plugin-index-hash.js";
import { recordInstalledPluginIndexInstallOwner } from "./installed-plugin-index-install-owner.js";
import type { PluginLifecycleRuntimeApply } from "./lifecycle.js";
import { ManagedPluginLifecycleError } from "./management-lifecycle-error.js";
import {
  configSnapshot,
  emptyMetadataSnapshot,
  metadataSnapshot,
  pluginConfig,
} from "./management-service.test-helpers.js";

const mocks = vi.hoisted(() => ({
  applyUninstall: vi.fn(),
  commitRecords: vi.fn(),
  installRecords: vi.fn(),
  metadata: vi.fn(),
  officialCatalog: vi.fn(),
  preflight: vi.fn(),
  readConfig: vi.fn(),
  readPersistedRecords: vi.fn(),
  refreshRegistry: vi.fn(),
  replaceConfig: vi.fn(),
  selectWriteOptions: vi.fn((writeOptions: unknown) => writeOptions),
}));

vi.mock("../config/config.js", () => ({
  assertConfigWriteAllowedInCurrentMode: (params?: { env?: NodeJS.ProcessEnv }) => {
    assertConfigWriteAllowedInCurrentMode(params);
  },
  readConfigFileSnapshot: async () => (await mocks.readConfig()).snapshot,
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

vi.mock("./install-config-mutation.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./install-config-mutation.js")>()),
  resolveInstallConfigMutationPreflights: mocks.preflight,
  selectInstallMutationWriteOptions: mocks.selectWriteOptions,
}));

vi.mock("./registry-refresh.js", () => ({
  refreshPluginRegistryAfterConfigMutation: mocks.refreshRegistry,
}));

vi.mock("./plugin-metadata-snapshot.js", () => ({
  loadPluginMetadataSnapshot: mocks.metadata,
  resolvePluginMetadataSnapshot: mocks.metadata,
}));

vi.mock("./installed-plugin-index-records.js", async (importOriginal) => ({
  // Keep the pure config/record helpers real; only record IO is stubbed.
  ...(await importOriginal<typeof import("./installed-plugin-index-records.js")>()),
  loadInstalledPluginIndexInstallRecords: mocks.installRecords,
  readPersistedInstalledPluginIndexInstallRecordsAsync: mocks.readPersistedRecords,
}));

vi.mock("./uninstall.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./uninstall.js")>()),
  applyPluginUninstallDirectoryRemoval: mocks.applyUninstall,
}));

vi.mock("./install-record-commit.js", () => ({
  commitPluginInstallRecordsWithConfig: mocks.commitRecords,
}));

vi.mock("./official-external-plugin-catalog.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./official-external-plugin-catalog.js")>()),
  loadConfiguredHostedOfficialExternalPluginCatalogEntries: mocks.officialCatalog,
}));

const { clearManagedPluginCatalogCache } = await import("./management-catalog.js");
const { listManagedPlugins } = await import("./management-service.js");
const { setManagedPluginEnabled, reloadManagedPlugin } = await import("./management-mutations.js");
const { uninstallManagedPlugin } = await import("./management-uninstall.js");

const enableWorkboard = () =>
  setManagedPluginEnabled({ pluginId: "workboard", enabled: true, env: {} });
const reload = (
  plugins: PluginsReloadParams["plugins"],
  applyRuntime: PluginLifecycleRuntimeApply,
  options: { waitForDrain?: boolean; signal?: AbortSignal } = {},
) => reloadManagedPlugin({ plugins, applyRuntime, env: {}, ...options });
function expectNoWrites() {
  expect([mocks.commitRecords.mock.calls, mocks.replaceConfig.mock.calls]).toEqual([[], []]);
}

describe("plugin management service", () => {
  beforeEach(() => {
    clearManagedPluginCatalogCache();
    for (const mock of Object.values(mocks)) {
      mock.mockReset();
    }
    mocks.selectWriteOptions.mockImplementation((writeOptions) => writeOptions);
    mocks.preflight.mockReturnValue({
      hookMutation: { mode: "allowed" },
      pluginMutation: { mode: "allowed" },
    });
    mocks.installRecords.mockResolvedValue({});
    mocks.applyUninstall.mockResolvedValue({ directoryRemoved: true, warnings: [] });
    mocks.officialCatalog.mockResolvedValue({ source: "hosted", entries: [] });
  });

  it.each(["batch", "cross-owner"] as const)(
    "validates current package owners before targeted reload: %s",
    async (mode) => {
      const acceptedSurface = buildPluginCapabilitySummary({
        manifest: {},
        origin: "global",
      }).declared;
      const record = (id: string) => ({
        source: "path",
        installPath: `/tmp/${id}`,
        acceptedSurface,
        acceptedSurfaceHash: computeDeclaredSurfaceHash(acceptedSurface),
      });
      const snapshot = (id: string) =>
        metadataSnapshot({
          enabled: true,
          id,
          origin: "global",
          installRecord: record(id),
        });
      const first = snapshot("first"),
        second = snapshot("second");
      const config = pluginConfig({ first: true, second: true });
      mocks.readConfig.mockResolvedValue(configSnapshot(config));
      mocks.readPersistedRecords.mockReturnValue({
        ...first.index.installRecords,
        ...second.index.installRecords,
      });
      mocks.metadata.mockReturnValue({
        ...first,
        index: {
          plugins: [...first.index.plugins, ...second.index.plugins],
          installRecords: { ...first.index.installRecords, ...second.index.installRecords },
        },
        plugins: [...first.plugins, ...second.plugins],
        byPluginId: new Map([...first.byPluginId, ...second.byPluginId]),
      });
      const application = {
        operationId: "reload",
        generation: 4,
        pluginIds: ["first", "second"],
      };
      const applyRuntime = vi.fn<PluginLifecycleRuntimeApply>(async (request) => {
        request.assertInvokerOwned?.();
        expect(request.config).toEqual(config);
        expect(request.pluginIds).toEqual(application.pluginIds);
        expect(request.expectedSourceDigests).toEqual({
          first: "a".repeat(64),
          second: "b".repeat(64),
        });
        return application;
      });
      const plugins: PluginsReloadParams["plugins"] = [
        {
          pluginId: "first",
          installHash: hashStableJson(first.index.installRecords.first),
          sourceDigests:
            mode === "cross-owner" ? { second: "a".repeat(64) } : { first: "a".repeat(64) },
        },
        {
          pluginId: "second",
          installHash: hashStableJson(second.index.installRecords.second),
          sourceDigests: { second: "b".repeat(64) },
        },
      ];
      const pending = reload(plugins, applyRuntime);
      if (mode === "cross-owner") {
        await expect(pending).rejects.toThrow("different package owner");
        expect(applyRuntime).not.toHaveBeenCalled();
      } else {
        await expect(pending).resolves.toMatchObject({ application });
        expect(applyRuntime).toHaveBeenCalledOnce();
      }
      expect(mocks.replaceConfig).not.toHaveBeenCalled();
    },
  );

  it.each([
    { origin: "config", retainedRecord: false },
    { origin: "bundled", retainedRecord: false },
    { origin: "bundled", retainedRecord: true },
  ] as const)("reloads a discovered plugin: %j", async ({ origin, retainedRecord }) => {
    const signal = new AbortController().signal;
    const metadata = metadataSnapshot({ enabled: true, id: "discovered", origin });
    const installRecords = retainedRecord
      ? {
          discovered: {
            source: "npm",
            spec: "@openclaw/discovered",
            installPath: "/tmp/registry/discovered",
          },
        }
      : {};
    mocks.metadata.mockReturnValue({
      ...metadata,
      index: {
        ...metadata.index,
        installRecords,
      },
    });
    mocks.readConfig.mockResolvedValue(configSnapshot());
    mocks.readPersistedRecords.mockReturnValue(installRecords);
    const applyRuntime = vi.fn<PluginLifecycleRuntimeApply>(async (request) => {
      request.assertInvokerOwned?.();
      return {
        operationId: "discovered-reload",
        generation: 4,
        pluginIds: [...request.pluginIds],
      };
    });
    await expect(
      reload(
        [{ pluginId: "discovered", sourceDigests: { discovered: "a".repeat(64) } }],
        applyRuntime,
        { waitForDrain: true, signal },
      ),
    ).resolves.toMatchObject({ pluginIds: ["discovered"], application: { generation: 4 } });
    expect(applyRuntime).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        pluginIds: ["discovered"],
        waitForDrain: true,
        drainSignal: signal,
        expectedSourceDigests: { discovered: "a".repeat(64) },
      }),
    );
    if (retainedRecord) {
      await expect(
        reload(
          [{ pluginId: "discovered", installHash: hashStableJson(installRecords.discovered) }],
          applyRuntime,
        ),
      ).rejects.toThrow("changed after the installation batch");
      expect(applyRuntime).toHaveBeenCalledOnce();
    }
    expectNoWrites();
  });

  it.each([
    "install-hash-without-record",
    "ambiguous-owner",
    "missing-record",
    "record-id-without-owner",
    "record-path-without-owner",
    "conflicting-owner",
  ] as const)("rejects an invalid managed reload claim: %s", async (claim) => {
    const metadata = metadataSnapshot({ enabled: true, id: "discovered" });
    const plugin = { ...metadata.index.plugins[0]!, origin: "config" as const };
    const record = { source: "path", installPath: plugin.rootDir };
    const records: Record<string, typeof record> = {};
    if (claim === "ambiguous-owner") {
      recordInstalledPluginIndexInstallOwner(plugin, undefined, true);
    } else if (claim === "missing-record" || claim === "conflicting-owner") {
      recordInstalledPluginIndexInstallOwner(plugin, "package");
    }
    if (claim === "record-id-without-owner" || claim === "conflicting-owner") {
      records.discovered = record;
    }
    if (claim === "record-path-without-owner" || claim === "conflicting-owner") {
      records.package = record;
    }
    mocks.metadata.mockReturnValue({
      ...metadata,
      index: { plugins: [plugin], installRecords: records },
    });
    mocks.readConfig.mockResolvedValue(configSnapshot());
    mocks.readPersistedRecords.mockReturnValue(records);
    const applyRuntime = vi.fn<PluginLifecycleRuntimeApply>();
    await expect(
      reload(
        [
          {
            pluginId: "discovered",
            ...(claim === "install-hash-without-record" ? { installHash: "a".repeat(64) } : {}),
          },
        ],
        applyRuntime,
      ),
    ).rejects.toBeInstanceOf(ManagedPluginLifecycleError);
    expect(applyRuntime).not.toHaveBeenCalled();
    expectNoWrites();
  });

  it.each(["OPENCLAW_NIX_MODE", "OPENCLAW_CONFIG_READONLY"])(
    "refuses mutation in %s before reading or writing config",
    async (mode) => {
      await expect(
        setManagedPluginEnabled({
          pluginId: "workboard",
          enabled: true,
          env: { [mode]: "1" },
        }),
      ).rejects.toThrow(`${mode}=1`);
      expect(mocks.readConfig).not.toHaveBeenCalled();
      expect(mocks.replaceConfig).not.toHaveBeenCalled();
      mocks.metadata.mockReturnValue(emptyMetadataSnapshot());
      const catalog = await listManagedPlugins({
        config: {},
        env: { [mode]: "1" },
        officialCatalog: { entries: [] },
      });
      expect(catalog.mutationAllowed).toBe(false);
    },
  );

  it("blocks unsupported plugin includes before config mutation", async () => {
    mocks.readConfig.mockResolvedValue(configSnapshot());
    mocks.preflight.mockReturnValue({
      hookMutation: { mode: "allowed" },
      pluginMutation: { mode: "blocked", reason: "nested plugins include" },
    });

    await expect(enableWorkboard()).rejects.toThrow("nested plugins include");
    expect(mocks.replaceConfig).not.toHaveBeenCalled();
  });

  it("keeps an explicit deny authoritative for admin enablement", async () => {
    const config = pluginConfig(
      { workboard: false },
      { allow: ["memory-core"], deny: ["workboard"] },
    );
    mocks.readConfig.mockResolvedValue(configSnapshot(config));
    mocks.metadata.mockReturnValue(metadataSnapshot({ enabled: false }));

    await expect(enableWorkboard()).rejects.toThrow(
      'plugin "workboard" could not be enabled (blocked by denylist)',
    );
    expect(mocks.replaceConfig).not.toHaveBeenCalled();
  });

  it("does not turn an empty allowlist into a restrictive one", async () => {
    const config = pluginConfig({ workboard: false }, { allow: [] });
    mocks.readConfig.mockResolvedValue(configSnapshot(config));
    mocks.replaceConfig.mockResolvedValue({});
    mocks.refreshRegistry.mockResolvedValue(undefined);
    mocks.metadata
      .mockReturnValueOnce(metadataSnapshot({ enabled: false }))
      .mockReturnValueOnce(metadataSnapshot({ enabled: true }));

    await enableWorkboard();

    expect(mocks.replaceConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceConfig: pluginConfig({ workboard: true }, { allow: [] }),
      }),
    );
  });

  it("retains files and tracking when authority is revoked during drain", async () => {
    const config = pluginConfig({ diffs: true });
    const record = {
      source: "clawhub",
      spec: "clawhub:@openclaw/diffs",
      installPath: "/tmp/extensions/diffs",
    };
    mocks.readConfig.mockResolvedValue(configSnapshot(config));
    mocks.installRecords.mockResolvedValue({ diffs: record });
    mocks.metadata.mockReturnValue(
      metadataSnapshot({ enabled: true, id: "diffs", origin: "global", installRecord: record }),
    );
    mocks.replaceConfig.mockResolvedValue({ path: "/tmp/openclaw.json", nextConfig: config });
    const entered = createDeferred();
    const release = createDeferred();
    const revoked = new Error("authority revoked");
    let owned = true;
    const pending = uninstallManagedPlugin({
      pluginId: "diffs",
      env: {},
      applyRuntime: async () => {
        entered.resolve();
        await release.promise;
        owned = false;
        return { operationId: "uninstall", generation: 2, pluginIds: ["diffs"] };
      },
      beforePersistentApply: () => {
        if (!owned) {
          throw revoked;
        }
      },
    });
    try {
      await Promise.race([
        entered.promise,
        pending.then(() => {
          throw new Error("uninstall finished before drain");
        }),
      ]);
      expect(mocks.applyUninstall).not.toHaveBeenCalled();
      expect(mocks.commitRecords).not.toHaveBeenCalled();
      expect(mocks.replaceConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          writeOptions: expect.objectContaining({
            afterWrite: { mode: "none", reason: "plugin lifecycle applies runtime" },
          }),
        }),
      );
    } finally {
      release.resolve();
    }
    await expect(pending).rejects.toBe(revoked);
    expect(mocks.applyUninstall).not.toHaveBeenCalled();
    expect(mocks.commitRecords).not.toHaveBeenCalled();
  });

  it.each([
    ["workboard", "bundled plugin cannot be uninstalled"],
    ["ghost", "Plugin not found: ghost"],
  ])("rejects uninstalling %s before mutation", async (pluginId, message) => {
    mocks.readConfig.mockResolvedValue(configSnapshot());
    mocks.metadata.mockReturnValue(
      pluginId === "ghost" ? emptyMetadataSnapshot() : metadataSnapshot({ enabled: false }),
    );
    await expect(uninstallManagedPlugin({ pluginId, env: {} })).rejects.toThrow(message);
    expect([mocks.commitRecords.mock.calls, mocks.applyUninstall.mock.calls]).toEqual([[], []]);
  });
});
