# NallyClaw Render 512 MiB profile

## Status

This is a conservative, reversible reduction profile for the Render Free web service. It selects optional extensions at Docker build time; it does not delete upstream source files. The 512 MiB memory target is **not yet proven**: it requires a successful image build and measured peak container RSS during representative traffic.

## Verified starting point

- Repository: `Klyntech/openclaw`
- Base commit: `4abf1eab9181ae1f31b6aa56fa5221b1ed782716`
- Branch: `fix/render-gateway-binding`
- The branch was created from the current `main` commit with no initial diff.

## Included Docker extension selection

The Dockerfile defaults `OPENCLAW_EXTENSIONS` to:

```text
telegram,memory-core,document-extract,azure-speech,elevenlabs
```

These directory/manifest IDs were checked in the source tree:

- `telegram`: Telegram channel and voice-message transport.
- `memory-core`: memory search and persistence integration.
- `document-extract`: local document extraction for attachments.
- `azure-speech`: hosted speech services.
- `elevenlabs`: hosted speech, media understanding, and realtime transcription providers.

The NVIDIA NIM extension is omitted from this Render profile because it is not needed for the requested Telegram + hosted voice path. This removes an optional provider integration, not native/core agent tools.

The OpenClaw agent runtime, gateway, and built-in/native tools are core runtime code rather than being removed by this optional-extension selection. The selection helper validates IDs during the Docker build. If a selected extension or dependency is missing, the build should fail rather than silently fall back to a different profile.

## Render binding fix

OpenClaw defaults to a loopback bind unless configured otherwise. That is unsuitable for a public Render web service, which must listen on `0.0.0.0`. The Render command now explicitly uses `--bind lan --port 8080`, and both `PORT` and `OPENCLAW_GATEWAY_PORT` are set to `8080` so Render's port detection and the gateway listener agree.

The supplied log reached `starting HTTP server...` shortly before Render's port scan timed out. This change addresses the confirmed bind-configuration gap, but it does **not** prove slow initialization is solved. Startup logs must show the gateway reaches readiness and the `/startupz` health check passes.

## Excluded from this lean profile

Other optional channel adapters, provider plugins, and media integrations are not selected by default. Their source files remain in the repository. Do not add extra extensions until a concrete required capability and its runtime cost are established.

## Render runtime guardrail

`render.yaml` sets `NODE_OPTIONS=--max-old-space-size=256` as an initial V8 old-space cap. This is **not** a 256 MiB total-process limit: native allocations, buffers, workers, stacks, and other processes contribute to total memory. If the cap causes heap exhaustion, tune it using evidence rather than treating it as a guaranteed value.

The service currently uses an ephemeral filesystem unless persistent storage is configured. Durable session/config/database behavior must be verified separately; this profile does not claim to migrate all local state to Neon or that data survives a restart.

## Required validation before merge/deploy

1. Build the Docker image with the default extension selection; confirm the selection helper resolves all five IDs and the dependency-pruning/build stages succeed.
2. Run repository CI and relevant unit/extension tests on this branch.
3. Start the built container with the generated gateway token; confirm it listens on `0.0.0.0:8080` and `/startupz` becomes healthy without a restart loop.
4. Test Telegram text and a tool-using agent turn.
5. Test a Telegram voice message through configured transcription, and voice output through both configured hosted providers where supported. Verify real delivery, not just provider initialization.
6. Test document extraction and memory behavior.
7. Measure peak container memory/RSS during cold startup, text, tool, and voice requests, including repeated/concurrent requests. Record startup time and any OOM/heap errors. Do not claim the 512 MiB target is met without evidence and meaningful headroom.
8. Verify gateway authentication, sender access policy, tool approvals, session isolation, and restart/persistence behavior.
9. Keep a known deployable image available for rollback. Do not merge or deploy until the applicable checks pass.

## Changes on this branch

- Render blueprint: explicitly bind the gateway to LAN/public container interfaces on port 8080; align Render's `PORT` with `OPENCLAW_GATEWAY_PORT`.
- Dockerfile: remove the unused NVIDIA NIM extension from the default list while preserving Telegram, memory, document extraction, Azure Speech, and ElevenLabs.
- No source files were deleted, and no deployment was triggered by these changes.
