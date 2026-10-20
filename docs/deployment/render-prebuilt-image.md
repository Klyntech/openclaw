# Render prebuilt-image fallback

NallyClaw's Render Docker build currently runs on Render's Starter build pipeline, which has an 8 GB RAM limit. Lowering the Node heap helps only if the entire build stays under that limit. If Render still cancels the build for using over 8 GB, use this path instead of repeatedly retrying the same builder.

## What the fallback does

The `.github/workflows/publish-render-image.yml` workflow builds the fork's own `Dockerfile` on a GitHub-hosted runner and publishes two tags to GitHub Container Registry (GHCR):

- `ghcr.io/klyntech/openclaw:sha-<commit>` is immutable for that source revision.
- `ghcr.io/klyntech/openclaw:main` is the moving convenience tag.

The workflow targets `linux/amd64`, as required by Render's image-backed services. On a public GitHub repository, `ubuntu-latest` provides 16 GB RAM and standard hosted runner use is free; private repositories receive a smaller standard runner, so confirm the repository remains public if relying on this memory headroom.

## One-time Render setup

Do not replace the existing Git-backed service before the image-backed service has passed health checks. Render treats the service runtime as immutable, so create a **second** service for this migration.

1. Merge the PR containing the workflow, then wait for **Publish Render Docker image** to complete successfully on `main`.
2. Open the repository's `openclaw` package under GitHub Packages. GHCR packages may start private. Either make the package public (the image contains the public application, not deployment secrets) or create a Render container-registry credential with permission to read packages and attach it to the service.
3. In Render, create a new Web Service using **Existing Image** with `ghcr.io/klyntech/openclaw:main`. Choose the Free compute plan for the runtime if that is still the requirement.
4. Configure the service's Docker command as `node openclaw.mjs gateway --allow-unconfigured`, health check path as `/startupz`, and environment variable `OPENCLAW_GATEWAY_PORT=8080`. Generate a fresh `OPENCLAW_GATEWAY_TOKEN` in Render; never put it in the image or Git.
5. After the new image-backed service exists, copy its deploy hook URL from Render Settings. Add it in GitHub repository Settings → Secrets and variables → Actions as `RENDER_DEPLOY_HOOK_URL`. Do not commit the hook URL.
6. Push a commit to `main`. The workflow will build/push the commit-tagged image, then call the deploy hook with that exact immutable image tag. If the secret is absent, publishing still works and the image can be deployed manually.

Keep the original Render service running while validating the new one. Only retire the old service after the new service responds successfully and the gateway authentication and health check behave as expected.

## Limits and failure handling

- The workflow uses `ubuntu-latest`, which gives public repositories a 16 GB runner, not Render's 8 GB build host. It is a separate builder, not a way to increase Render's memory.
- If the GitHub Actions Docker build itself runs out of memory, check that the repository is public and that the workflow is using `ubuntu-latest`, not `ubuntu-slim`. The next step would be a larger/self-hosted builder or reducing the build's peak memory further.
- Render's image-backed service must be able to pull the image. For a private GHCR package, configure a valid registry credential in Render before deployment.
- Render requires `linux/amd64` images and a compressed image size no larger than 10 GB.
- The workflow publishes images only. It does not prove that the service starts; the Render health check and runtime logs remain the deployment validation.
