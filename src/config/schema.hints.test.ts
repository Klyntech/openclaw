import { SENSITIVE_URL_HINT_TAG } from "@openclaw/net-policy/redact-sensitive-url";
import { expect, it } from "vitest";
import { z } from "zod";
import { mapSensitivePaths, testApi } from "./schema.hints.js";
import { buildConfigSchemaCore } from "./schema.js";
import { OpenClawSchema } from "./zod-schema.js";
import { OpenClawSchemaShape } from "./zod-schema.root-shape.js";
import { sensitive } from "./zod-schema.sensitive.js";

const secret = () => z.string().register(sensitive);
const branches = () =>
  [
    z.object({ type: z.literal("none") }),
    z.object({ type: z.literal("token"), value: secret() }),
  ] as const;
function expectSensitive(hints: ReturnType<typeof mapSensitivePaths>, paths: string) {
  const fields = paths.trim().split(/\s+/);
  expect(hints).toMatchObject(
    Object.fromEntries(fields.map((path) => [path, { sensitive: true }])),
  );
}

const { SECTION_DOCS_URLS } = testApi;
// Root sections without beginner-worthy pages stay explicit. Adding a root config key
// requires choosing a docsUrl or listing it here.
const SECTIONS_WITHOUT_DOCS = ["$schema", "meta", "attachments"] as const;

it("accounts for every root config section", () => {
  const sectionsWithDocsDecisions = new Set([
    ...Object.keys(SECTION_DOCS_URLS),
    ...SECTIONS_WITHOUT_DOCS,
  ]);
  const undecidedSections = Object.keys(OpenClawSchemaShape).filter(
    (section) => !sectionsWithDocsDecisions.has(section),
  );

  expect(undecidedSections).toEqual([]);
});

it("describes omitted settings without adding them to authored config", () => {
  const { uiHints } = buildConfigSchemaCore();
  expect(uiHints["cron.enabled"]?.placeholder).toBe("Default: On");
  expect(uiHints["plugins.enabled"]?.placeholder).toBe("Default: On");

  const config = OpenClawSchema.parse({ cron: {}, plugins: {} });
  expect(config.cron).not.toHaveProperty("enabled");
  expect(config.plugins).not.toHaveProperty("enabled");
});

it("should detect sensitive fields nested inside all structural Zod types", () => {
  const GrandSchema = z.object({
    simple: secret().optional(),
    simpleReversed: z.string().optional().register(sensitive),
    nested: z.object({ nested: secret() }),
    list: z.array(secret()),
    listOfObjects: z.array(z.object({ nested: secret() })),
    headers: z.record(z.string(), secret()),
    headersNested: z.record(z.string(), z.object({ nested: secret() })),
    auth: z.union(branches()),
    merged: z.object({ id: z.string() }).and(z.object({ nested: secret() })),
    deferred: z.lazy(() => z.object({ value: secret() })),
    defaulted: secret().default("synthetic"),
    nullable: secret().nullable().readonly(),
    preprocessed: z.preprocess((value) => value, z.object({ value: secret() })),
    discriminated: z.discriminatedUnion("type", branches()),
  });

  const result = mapSensitivePaths(GrandSchema, "", {});

  expectSensitive(
    result,
    `
    simple simpleReversed nested.nested list[] listOfObjects[].nested headers.*
    headersNested.*.nested auth.value merged.nested deferred.value defaulted
    nullable preprocessed.value discriminated.value
  `,
  );
});

it("maps sensitive fields nested under object catchall schemas", () => {
  const schema = z.object({
    custom: z.object({}).catchall(z.object({ apiKey: secret(), label: z.string() })),
  });

  const result = mapSensitivePaths(schema, "", {});
  expect(result["custom.*.apiKey"]?.sensitive).toBe(true);
  expect(result["custom.*.label"]?.sensitive).toBe(undefined);
});

it("main schema yields correct hints (samples)", () => {
  const hints = mapSensitivePaths(OpenClawSchema, "", {});

  expectSensitive(
    hints,
    `
    memory.search.remote.apiKey agents.entries.*.memory.search.remote.apiKey gateway.auth.token
    models.providers.*.headers.* models.providers.*.localService.env.*
    models.providers.*.request.headers.* models.providers.*.request.proxy.tls.cert
    proxy.proxyUrl skills.entries.*.apiKey
  `,
  );
  expect(hints["proxy.tls.caFile"]?.sensitive).toBeUndefined();
});

it("tags base-config URL fields that may embed secrets", () => {
  const hints = mapSensitivePaths(OpenClawSchema, "", {});
  for (const path of [
    "mcp.servers.*.url",
    "models.providers.*.baseUrl",
    "models.providers.*.request.proxy.url",
    "tools.media.audio.request.proxy.url",
  ]) {
    expect(hints[path]?.tags, path).toContain(SENSITIVE_URL_HINT_TAG);
  }
});

it("preserves authored metadata without deriving tags from field names or tiers", () => {
  const { uiHints: hints } = buildConfigSchemaCore({
    plugins: [
      {
        id: "authored-metadata",
        configSchema: {
          type: "object",
          properties: {
            maxTokens: { type: "integer" },
            storagePath: { type: "string" },
            apiKey: { type: "string" },
          },
        },
        configUiHints: {
          maxTokens: { sensitive: false },
          storagePath: { tags: ["User-defined"], advanced: true },
          apiKey: { sensitive: true },
        },
      },
    ],
    channels: [
      {
        id: "authored-metadata-channel",
        configSchema: { type: "object", properties: { retryLimit: { type: "integer" } } },
        configUiHints: { retryLimit: { tags: ["Tuning"] } },
      },
    ],
  });
  expect(hints["gateway.auth.token"]?.tags).toBeUndefined();
  const plugin = (key: string) => hints[`plugins.entries.authored-metadata.config.${key}`];
  expect(plugin("maxTokens")).toMatchObject({ sensitive: false });
  expect(plugin("maxTokens")?.tags).toBeUndefined();
  expect(plugin("storagePath")).toMatchObject({
    tags: ["User-defined"],
    advanced: true,
  });
  expect(plugin("apiKey")?.sensitive).toBe(true);
  expect(plugin("apiKey")?.tags).toBeUndefined();
  expect(hints["channels.authored-metadata-channel.retryLimit"]?.tags).toEqual(["Tuning"]);
  expect(hints["mcp.servers.*.url"]?.tags).toContain(SENSITIVE_URL_HINT_TAG);
});
