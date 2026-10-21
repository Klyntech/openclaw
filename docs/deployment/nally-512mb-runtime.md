# Nally 512 MiB runtime profile

## Goal

Run the Nally OpenClaw fork within a 512 MiB Render runtime without removing
required agent, Telegram, tool, media, voice, NVIDIA NIM, authentication, or
persistence behavior.

A successful Docker build is not evidence that runtime memory fits. The
acceptance metric is peak container memory/RSS during startup and representative
requests, including native/external allocations that are not part of V8 heap.

## First guardrail

`render.yaml` sets `NODE_OPTIONS=--max-old-space-size=256` as an initial
V8 old-space cap. This is a tunable starting point, not a claim that the
process fits 512 MiB. The cap can cause out-of-memory failures if the workload
needs more heap; monitor logs and peak RSS before treating it as stable.

Do not copy Docker build heap settings into the runtime. The Dockerfile's
`OPENCLAW_DOCKER_BUILD_NODE_OPTIONS` and `OPENCLAW_DOCKER_BUILD_TSDOWN_MAX_OLD_SPACE_MB`
apply to build stages, not the deployed gateway.

## Work plan

1. Record a baseline for the current lean branch: startup duration, peak RSS,
   process exit reason, and extension initialization logs.
2. Use Render's Docker build-argument forwarding to pass the manifest-verified
   `OPENCLAW_EXTENSIONS` selection in `render.yaml`. The initial selection is
   `telegram,nvidia,memory-core,document-extract,image-generation-core,senseaudio,azure-speech,fish-audio-speech,talk-voice`.
   This keeps the Telegram channel, NVIDIA provider, memory tools, document/media
   handling, and common voice integrations while excluding unrelated optional
   providers. Verify dependency closure and real feature behavior before merging;
   a manifest ID alone does not prove a feature works end to end.
3. Add a dedicated lean image/build CI lane. Verify selected extension manifests
   and fail if a required extension is missing.
4. Profile heap, external memory, loaded modules, worker threads, and concurrent
   requests. Lazy-load optional media/voice capabilities where supported.
5. Inventory file-backed and SQLite persistence before migrating each supported
   store to Neon Postgres. Keep transient media separate from durable metadata.
6. Exercise authenticated startup, Telegram round-trip, NVIDIA NIM tool use,
   media/document handling, voice paths, restart recovery, and session isolation.
7. Record peak RSS under realistic requests and keep headroom below the 512 MiB
   platform limit. If this cannot be met without disabling required features,
   report that honestly instead of declaring success.

## Acceptance criteria

- Container listens on the Render-provided port and `/startupz` becomes healthy.
- No restart loop, heap exhaustion, or platform OOM kill during the test suite.
- Telegram text exchange and a tool-using NVIDIA NIM turn succeed.
- Configured media and voice features work or report explicit provider/config
  requirements rather than silently disappearing.
- Authentication and session isolation remain enabled.
- Durable state survives restart after its migration is verified.
- Peak memory and startup timing are captured as test evidence.

## Rollback

Remove the `NODE_OPTIONS` environment entry if the 256 MiB old-space cap
causes heap exhaustion. Keep the previous deployable image available until
the lean profile passes its runtime acceptance tests.
