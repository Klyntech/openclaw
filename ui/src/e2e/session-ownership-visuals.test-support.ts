import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Browser, Locator, Page } from "playwright";
import { expect } from "vitest";
import {
  takeControlUiElementScreenshot,
  takeControlUiViewportScreenshot,
  waitForControlUiProofSurface,
} from "../test-helpers/control-ui-e2e-screenshot.ts";
import { openSidebarMenu } from "./sidebar-session-menu.test-support.ts";

export const captureUiProofEnabled = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";

export function createSessionOwnershipProofContext(
  owner: { readonly artifactDir: string; readonly browser: Browser },
  directory: "drafts-ux" | "session-owner-stack",
) {
  const viewport = { height: 800, width: 1200 };
  return owner.browser.newContext({
    viewport,
    ...(captureUiProofEnabled
      ? { recordVideo: { dir: path.join(owner.artifactDir, directory), size: viewport } }
      : {}),
  });
}

type AvatarFixture = {
  id: string;
  background: string;
  label: string;
};

export async function routeAvatarFixtures(page: Page, fixtures: readonly AvatarFixture[]) {
  await Promise.all(
    fixtures.map(({ id, background, label }) =>
      page.route(`**/api/users/${id}/avatar*`, (route) =>
        route.fulfill({
          // Static input assets must not depend on browser screenshot availability.
          body: `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><rect width="64" height="64" fill="${background}"/><text x="32" y="32" text-anchor="middle" dominant-baseline="central" fill="white" style="font:700 26px system-ui">${label}</text></svg>`,
          contentType: "image/svg+xml",
          status: 200,
        }),
      ),
    ),
  );
}

type ProofOwner = { readonly artifactDir: string };
type SurfaceProof = (
  owner: ProofOwner,
  surface: Locator,
  fileName: string,
  content: readonly Locator[],
) => Promise<void>;

async function writeProof(
  owner: ProofOwner,
  directory: string,
  fileName: string,
  capture: () => Promise<Buffer>,
) {
  if (!captureUiProofEnabled) {
    return;
  }
  const output = path.join(owner.artifactDir, directory);
  await mkdir(output, { recursive: true });
  await writeFile(path.join(output, fileName), await capture());
}

export const captureUiProof: SurfaceProof = (owner, surface, fileName, content) =>
  writeProof(owner, "drafts-ux", fileName, () =>
    takeControlUiViewportScreenshot(surface.page(), surface, content),
  );

export function captureSessionOwnerProof(owner: ProofOwner, page: Page, fileName: string) {
  return writeProof(owner, "session-owner-stack", fileName, () =>
    takeControlUiElementScreenshot(page, page.locator(".sidebar-sessions"), [
      page.locator(".sidebar-recent-session").first(),
    ]),
  );
}

export const captureSessionOwnerPageProof: SurfaceProof = (owner, surface, fileName, content) =>
  writeProof(owner, "session-owner-stack", fileName, () =>
    takeControlUiViewportScreenshot(surface.page(), surface, content),
  );

export async function openSidebarSortMenu(page: Page) {
  const filterAndSort = page.getByRole("button", { name: "Filter & sort", exact: true });
  await expect.poll(() => filterAndSort.count(), { timeout: 2_000 }).toBe(1);
  const menu = await openSidebarMenu(page);
  await waitForControlUiProofSurface(menu.locator(".sidebar-session-filter-panel"), [
    menu.getByRole("radio").first(),
  ]);
  return menu;
}
