# NallyClaw Render 512 MiB profile

## Status

This is a conservative, reversible reduction profile for the Render Free web service. It selects optional extensions at Docker build time; it does not delete upstream source files. The 512 MiB memory target is **not yet proven**: it requires a successful image build and measured peak container RSS during representative traffic.

## Verified starting point

- Repository: `Klyntech/openclaw`
- Base commit: `6959579a703e32ad99bef92dd9044ca85a36559a`
- Branch: `nally/render-512mb-telegram-voice`
- The branch was created from the base commit with no initial diff.

## Included Docker extension selection

The Dockerfile defaults `OPENCLAW_EXTENSIONS` to:

```text
telegram,nvidia,memory-core,document-extract,azure-speech,elevenlabs
```

These directory/manifest IDs were checked in the source tree:

- `telegram`: Telegram channel and voice-message transport.
- `nvidia`: NVIDIA NIM model provider.
- `memory-core`: memory search and persistence integration.
- `document-extract`: local document extraction for attachments.
- `azure-speech`: hosted speech generation.
- `elevenlabs`: hosted speech, media understanding, and realtime transcription providers.

The OpenClaw agent runtime, gateway, and built-in/native tools are core runtime code rather than being removed by this optional-extension selection. The selection helper validates IDs during the Docker build. If a selected extension or dependency is missing, the build should fail rather than silently fall back to a different profile.

## Excluded from this lean profile

Other optional channel adapters, provider plugins, and media integrations are not selected by default. Their source files remain in the repository. Do not add extra extensions until a concrete required capability and its runtime cost are established.

The previous draft selection referenced `talk-voice`, which was not found at the expected extension path. This profile uses the checked `azure-speech` and `elevenlabs` extension directories instead. This is a build-time inclusion decision, not proof that credentials are configured or that every voice path works end to end.

## Render runtime guardrail

`render.yaml` sets `NODE_OPTIONS=--max-old-space-size=256` as an initial V8 old-space cap. This is **not** a 256 MiB total-process limit: native allocations, buffers, workers, stacks, and other processes contribute to total memory. If the cap causes heap exhaustion, tune it using evidence rather than treating it as a guaranteed value.

The service currently uses an ephemeral filesystem unless persistent storage is configured. Durable session/config/database behavior must be verified separately; this profile does not claim to migrate all local state to Neon or that data survives a restart.

## Required validation before merge/deploy

1. Build the Docker image with the default extension selection; confirm the selection helper resolves all six IDs and the dependency-pruning/build stages succeed.
2. Run repository CI and relevant unit/extension tests on this branch.
3. Start the built container with a valid gateway token and the Render port; confirm `/startupz` becomes healthy without a restart loop.
4. Test a Telegram text round-trip and a tool-using NVIDIA NIM turn.
5. Test a Telegram voice message through configured transcription, and voice output through both configured hosted providers where supported. Verify real delivery, not just provider initialization.
6. Test document extraction and memory behavior if enabled in the deployed configuration.
7. Measure peak container memory/RSS during cold startup, text, tool, and voice requests, including repeated/concurrent requests. Record startup time and any OOM/heap errors. Do not claim the 512 MiB target is met without evidence and meaningful headroom.
8. Verify gateway authentication, sender access policy, tool approvals, session isolation, and restart/persistence behavior.
9. Keep the current deployable image/branch available for rollback. Do not merge or deploy until the applicable checks pass.

## Changes made in this branch

- Dockerfile: set a focused default extension list for Telegram, NVIDIA NIM, memory, document extraction, Azure Speech, and ElevenLabs.
- Render blueprint: add a conservative V8 heap starting guardrail.
- No source files were deleted, no pull request was merged, and no deployment was triggered by these changes.
