import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  cleanupPluginLoaderFixturesForTest,
  loadOpenClawPlugins,
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
  writePlugin,
} from "./loader.test-fixtures.js";
import { loadPluginManifestRegistryCore } from "./manifest-registry.js";
import { loadPluginManifest } from "./manifest.js";

afterEach(resetPluginLoaderTestStateForTest);
afterAll(cleanupPluginLoaderFixturesForTest);
const entry = "dist/control-ui/index.js";
const memoryViews = (...panels: string[]) => panels.map((panel) => ({ section: "memory", panel }));

function writeJson(dir: string, file: string, value: unknown) {
  fs.writeFileSync(path.join(dir, file), JSON.stringify(value));
}

function fixture(controlUi: unknown, uiCapabilities?: unknown, channels?: string[]) {
  const plugin = writePlugin({
    id: "native-ui",
    body: 'module.exports = { id: "native-ui", register() {} };',
  });
  writeJson(plugin.dir, "openclaw.plugin.json", {
    id: plugin.id,
    configSchema: { type: "object", additionalProperties: false },
    controlUi,
    uiCapabilities,
    channels,
  });
  return plugin;
}

function expectManifest(controlUi: unknown, channels?: string[]) {
  expect(loadPluginManifest(fixture(controlUi, undefined, channels).dir)).toMatchObject({
    ok: true,
    manifest: { controlUi },
  });
}

describe("native Control UI manifest", () => {
  it("admits channel detail presentations only for the manifest's declared channels", () => {
    const controlUi = {
      entry,
      activation: "settings-only",
      settingsViews: [{ section: "channels", panel: "detail", channelId: "custom" }],
    };
    expectManifest(controlUi, ["custom"]);
    const foreign = fixture(controlUi, undefined, ["other"]);
    expect(loadPluginManifest(foreign.dir)).toMatchObject({ ok: false });
    const duplicate = fixture(
      { ...controlUi, settingsViews: [controlUi.settingsViews[0], controlUi.settingsViews[0]] },
      undefined,
      ["custom"],
    );
    expect(loadPluginManifest(duplicate.dir)).toMatchObject({ ok: false });
  });

  it("carries normalized built entrypoints through discovery into runtime ownership", () => {
    useNoBundledPlugins();
    const plugin = fixture(
      {
        entry: "./dist/control-ui/index.js",
        styles: ["./dist/control-ui/theme.css", "dist/control-ui/theme.css"],
      },
      ["widget", "page", "widget"],
    );
    const registry = loadOpenClawPlugins({
      cache: false,
      workspaceDir: plugin.dir,
      config: { plugins: { load: { paths: [plugin.file] }, allow: [plugin.id] } },
      onlyPluginIds: [plugin.id],
    });
    expect(registry.plugins.find((record) => record.id === plugin.id)).toMatchObject({
      status: "loaded",
      uiCapabilities: ["page", "widget"],
      controlUi: { entry: "dist/control-ui/index.js", styles: ["dist/control-ui/theme.css"] },
    });
  });

  it.each([[["overview"]], [["memories"]], [["overview", "memories"]]])(
    "preserves settings-only presentation metadata through manifest discovery: %j",
    (panels) => {
      const controlUi = {
        entry,
        activation: "settings-only",
        settingsViews: memoryViews(...panels),
      };
      expectManifest(controlUi);
    },
  );

  it.each([
    [undefined, undefined],
    [[], []],
    [
      ["link-reader", "page", "link-reader"],
      ["page", "link-reader"],
    ],
  ])("reads static UI capabilities without a browser module: %j", (declaration, expected) => {
    const result = loadPluginManifest(fixture(undefined, declaration).dir);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.uiCapabilities).toEqual(expected);
      expect(result.manifest.controlUi).toBeUndefined();
    }
  });

  it.each([[null], ["page"], [["pages"]], [["page", 1]]])(
    "keeps an installed plugin discoverable with invalid optional UI metadata %j",
    (declaration) => {
      const plugin = fixture(undefined, declaration);
      const result = loadPluginManifest(plugin.dir);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.manifest.uiCapabilities).toBeUndefined();
      }
      const registry = loadPluginManifestRegistryCore({
        installRecords: {},
        candidates: [
          {
            idHint: plugin.id,
            rootDir: plugin.dir,
            source: plugin.file,
            origin: "global",
          },
        ],
      });
      expect(registry.plugins).toEqual([
        expect.objectContaining({ id: plugin.id, uiCapabilities: undefined }),
      ]);
      expect(registry.diagnostics).toContainEqual(
        expect.objectContaining({
          level: "warn",
          pluginId: plugin.id,
          source: path.join(plugin.dir, "openclaw.plugin.json"),
          message: expect.stringContaining("ignoring invalid plugin manifest uiCapabilities"),
        }),
      );
      expect(registry.diagnostics.some((diagnostic) => diagnostic.level === "error")).toBe(false);
    },
  );

  it.each([
    { activation: "settings-only" },
    { settingsViews: [] },
    { settingsViews: memoryViews("memories", "memories") },
    { activation: "on-startup" },
    { settingsViews: [{ section: "memory", panel: "search" }] },
    { settingsViews: memoryViews("overview", "overview") },
    { entry: "src/index.ts" },
    { entry: "dist/index.js" },
    { entry: "../dist/control-ui/index.js" },
    { entry: "/dist/control-ui/index.js" },
    { entry: "dist/control-ui/../server.js" },
    { entry: "dist\\control-ui\\index.js" },
    { styles: ["dist/server.css"] },
    { styles: ["dist/control-ui/.secret.css"] },
    { styles: ["dist/control-ui/code.js"] },
    { root: "/private" },
  ])("rejects unsafe or source declarations %j", (overrides) => {
    expect(loadPluginManifest(fixture({ entry, ...overrides }).dir)).toMatchObject({
      ok: false,
      error: expect.stringContaining("controlUi"),
    });
  });

  it("rejects unsafe generated browser paths instead of falling back to authored assets", () => {
    const plugin = fixture({ entry: "dist/control-ui/previous/index.js" });
    writeJson(plugin.dir, "package.json", { openclaw: { controlUi: "./browser.ts" } });
    fs.mkdirSync(path.join(plugin.dir, "dist"));
    writeJson(plugin.dir, "dist/openclaw.plugin.json", {
      controlUi: { entry: "../another-plugin/dist/control-ui/index.js" },
    });
    expect(loadPluginManifest(plugin.dir)).toMatchObject({
      ok: false,
      error: expect.stringContaining("controlUi.entry"),
    });
  });

  it("keeps authored prebuilt assets when a preceding browser build is no longer declared", () => {
    const controlUi = { entry: "dist/control-ui/prebuilt/index.js" };
    const plugin = fixture(controlUi);
    writeJson(plugin.dir, "package.json", { openclaw: {} });
    fs.mkdirSync(path.join(plugin.dir, "dist"));
    writeJson(plugin.dir, "dist/openclaw.plugin.json", {
      controlUi: { entry: "dist/control-ui/previous/index.js" },
    });
    expect(loadPluginManifest(plugin.dir)).toMatchObject({ ok: true, manifest: { controlUi } });
  });
});
