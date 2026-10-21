# Nally lean deployment profile

This fork is being narrowed to one product: **Nally**, an agent running on OpenClaw.

## Required capabilities

- Agent runtime and gateway
- Telegram channel
- Tool execution needed by the agent
- Image/document/media understanding and generation only where configured
- Voice input/output using configured providers
- NVIDIA NIM as the primary LLM provider
- Neon Postgres for durable application persistence
- Gateway authentication, authorization, and session isolation
- Health endpoint and operational logging

## Deployment rules

1. Do not remove features by deleting arbitrary files from OpenClaw core. Select optional extensions through the supported Docker extension-selection mechanism and verify dependency closure.
2. Keep Telegram and only the provider/tool/media/voice extensions required by the Nally deployment. Resolve exact extension IDs from each extension manifest before setting `OPENCLAW_EXTENSIONS`; do not guess names.
3. Configure NVIDIA NIM through OpenClaw's supported provider configuration and environment-secret mechanism. Do not bake API keys into the image or commit them.
4. Treat Neon migration as a separate data-layer change. The repository supports Postgres for selected database families, but that does not prove all OpenClaw state is already portable. Inventory SQLite/file-backed stores, define migrations and rollback, and test concurrency, restart recovery, session isolation, and backup/restore before disabling local persistence.
5. Keep transient media files on ephemeral storage only when safe; put durable blobs in an appropriate object store and durable metadata in Postgres. Do not assume Neon is a binary media store.
6. Preserve a full-featured build and test lane. The lean profile is an additional deployment target, not a reason to remove upstream functionality globally.

## Acceptance gates

- Docker image builds on CI with a pinned source commit.
- Container starts within the chosen platform's memory limit and binds to `0.0.0.0:$PORT`.
- `/startupz` passes after gateway readiness.
- Telegram receives and sends a text message.
- NVIDIA NIM completes a tool-using agent turn.
- Tool permissions and approval boundaries remain enforced.
- Image/document handling and voice input/output pass provider-backed tests or are explicitly marked unavailable when credentials are absent.
- Neon persistence survives process restart and deployment; migration and rollback are tested.
- No cross-session or cross-user data leakage.
- Peak RSS and startup duration are recorded in CI or deployment evidence.

## Known constraint

The observed Render instance reports a 512 MiB memory limit. The previous startup reached session admission after roughly 92 seconds and was killed before a listening port was detected. This profile must be measured against that limit; it must not claim the full gateway fits until a real run proves it. If the process cannot fit, use a larger runtime instance rather than silently disabling required capabilities or weakening security.
