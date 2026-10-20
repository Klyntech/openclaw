import type { Page } from "playwright";
import { expect as expectBrowser } from "playwright/test";
import { afterEach, expect, it } from "vitest";
import {
  controlUiSessionUrl,
  installMockGateway,
  pauseVirtualClock,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite, tooltipTitleText } from "./control-ui-e2e-suite.test-support.ts";
import { replaceGatewayClient } from "./new-session-page.test-support.ts";
import {
  collaborativeSessionsList,
  draftSessionsList,
  sessionsList,
} from "./session-ownership-fixtures.test-support.ts";
import {
  captureSessionOwnerPageProof,
  captureSessionOwnerProof,
  captureUiProof,
  captureUiProofEnabled,
  createSessionOwnershipProofContext,
  openSidebarSortMenu,
  routeAvatarFixtures,
} from "./session-ownership-visuals.test-support.ts";
import {
  chooseSidebarOwner,
  chooseSidebarMenuOption,
  closeSidebarMenu,
  openSidebarMenu,
} from "./sidebar-session-menu.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI session ownership",
});

let activePage: Page | undefined;
const capture = captureSessionOwnerProof.bind(undefined, suite);
const captureSurface = captureSessionOwnerPageProof.bind(undefined, suite);
const captureDraft = captureUiProof.bind(undefined, suite);

function ownerSessions(visibility: "draft" | "shared", single = false) {
  const sessions = visibility === "draft" ? draftSessionsList() : sessionsList();
  const active = sessions.sessions[0];
  if (!active) {
    throw new Error("expected owner session fixture");
  }
  Object.assign(active, { visibility, sharingRole: "owner" });
  if (single) {
    sessions.count = 1;
    sessions.owners = [active.owner.actor];
    sessions.sessions = [active];
  }
  return sessions;
}

async function newPage(directory?: "drafts-ux" | "session-owner-stack", width = 1200) {
  const context = directory
    ? await createSessionOwnershipProofContext(suite, directory)
    : await suite.browser.newContext({ viewport: { height: 800, width } });
  activePage = await context.newPage();
  return activePage;
}

suite.define(() => {
  afterEach(async () => {
    await activePage
      ?.context()
      .close()
      .catch(() => {});
    activePage = undefined;
  });

  it("keeps collaborative owner stacks legible without shifting session rows", async () => {
    const page = await newPage();
    await routeAvatarFixtures(page, [
      { id: "profile-ada", background: "#3f6f76", label: "A" },
      { id: "profile-bob", background: "#985b42", label: "B" },
    ]);
    await installMockGateway(page, {
      hasMultipleSessionSharingIdentities: true,
      sessionKey: "agent:main:collaboration",
      historyMessages: [{ role: "assistant", content: [{ type: "text", text: "Ready." }] }],
      methodResponses: { "sessions.list": collaborativeSessionsList() },
    });

    await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:collaboration"));
    const collaborativeRow = page.locator('[data-session-key="agent:main:collaboration"]');
    const overflowRow = page.locator('[data-session-key="agent:main:release-planning"]');
    const singleOwnerRow = page.locator('[data-session-key="agent:main:single-owner"]');
    await collaborativeRow.waitFor();
    await overflowRow.waitFor();
    await singleOwnerRow.waitFor();
    await expect.poll(() => collaborativeRow.locator(".session-owner-stack img").count()).toBe(2);
    await expect
      .poll(() =>
        collaborativeRow
          .locator(".session-owner-stack img")
          .evaluateAll((images) =>
            images.every(
              (image) =>
                image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0,
            ),
          ),
      )
      .toBe(true);

    const geometry = await collaborativeRow.evaluate((row) => {
      const stack = row.querySelector<HTMLElement>(".session-owner-stack");
      const back = row.querySelector<HTMLElement>(".session-owner-stack__back .viewer-avatar");
      const front = row.querySelector<HTMLElement>(".session-owner-stack__front");
      const slot = row.querySelector<HTMLElement>(".sidebar-session-indicator");
      const text = row.querySelector<HTMLElement>(".sidebar-recent-session__text");
      if (!stack || !back || !front || !slot || !text) {
        throw new Error("expected complete collaborative session row");
      }
      const stackBounds = stack.getBoundingClientRect();
      const backBounds = back.getBoundingClientRect();
      const frontBounds = front.getBoundingClientRect();
      const slotBounds = slot.getBoundingClientRect();
      const textBounds = text.getBoundingClientRect();
      return {
        backSize: [Math.round(backBounds.width), Math.round(backBounds.height)],
        centerDelta:
          stackBounds.left + stackBounds.width / 2 - (slotBounds.left + slotBounds.width / 2),
        frontSize: [Math.round(frontBounds.width), Math.round(frontBounds.height)],
        overlap: backBounds.right - frontBounds.left,
        reveal: frontBounds.left - backBounds.left,
        slotWidth: slotBounds.width,
        stackSize: [Math.round(stackBounds.width), Math.round(stackBounds.height)],
        textGap: textBounds.left - stackBounds.right,
      };
    });
    expect(geometry).toEqual({
      backSize: [18, 18],
      centerDelta: 0,
      frontSize: [18, 18],
      overlap: 8,
      reveal: 10,
      slotWidth: 20,
      stackSize: [28, 20],
      textGap: 4,
    });
    await expectBrowser(overflowRow.locator(".session-owner-stack__overflow")).toHaveText("+2");
    const rowHeights = await Promise.all(
      [collaborativeRow, singleOwnerRow].map((row) =>
        row.evaluate((element) => element.getBoundingClientRect().height),
      ),
    );
    expect(rowHeights[0]).toBeCloseTo(rowHeights[1] ?? 0, 5);
    const titleLefts = await Promise.all(
      [collaborativeRow, singleOwnerRow].map((row) =>
        row
          .locator(".sidebar-recent-session__text")
          .evaluate((text) => text.getBoundingClientRect().left),
      ),
    );
    expect(titleLefts[0]).toBeCloseTo(titleLefts[1] ?? 0, 5);

    if (captureUiProofEnabled) {
      await page.evaluate(() => document.documentElement.setAttribute("data-theme-mode", "dark"));
      await capture(page, "02-after-dark.png");
      await page.evaluate(() => document.documentElement.setAttribute("data-theme-mode", "light"));
      await capture(page, "03-after-light.png");
    }
  });

  it("derives People controls and owner filtering from current session owners", async () => {
    const page = await newPage("session-owner-stack");
    await routeAvatarFixtures(page, [
      { id: "profile-patrick", background: "#27496d", label: "P" },
      { id: "profile-ada", background: "#3f6f76", label: "A" },
      { id: "profile-bob", background: "#985b42", label: "B" },
    ]);
    const gateway = await installMockGateway(page, {
      hasMultipleSessionSharingIdentities: false,
      sessionKey: "agent:main:ada",
      presenceUsers: [
        {
          self: true,
          id: "profile-patrick",
          name: "Patrick",
          avatarUrl: "/api/users/profile-patrick/avatar?v=1",
        },
      ],
      historyMessages: [{ role: "assistant", content: [{ type: "text", text: "Ready." }] }],
      methodResponses: { "sessions.list": sessionsList(["profile-ada", "profile-bob"], true) },
    });

    await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:ada"));
    await chooseSidebarOwner(page, "all");
    await closeSidebarMenu(page);
    await page.getByText("Ada research", { exact: true }).first().waitFor();
    await page.getByText("Bob operations", { exact: true }).first().waitFor();
    await page.locator('[data-session-key="agent:main:ada"] a').click();
    await page.getByText("Ready.", { exact: true }).waitFor();
    await expect.poll(() => page.locator("openclaw-session-owner-chip").count()).toBe(3);

    const ownerMenu = await openSidebarSortMenu(page);
    await ownerMenu.locator("#sidebar-sessions-group").click();
    await expectBrowser(
      ownerMenu.getByRole("option", { name: "Person", exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await ownerMenu.locator("#sidebar-sessions-sort").click();
    await expectBrowser(
      ownerMenu.getByRole("option", { name: "Owners", exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    const ownerSelect = page.locator("#sidebar-session-owner-title");
    await ownerSelect.click();
    const ownerRows = page.locator(
      '.sidebar-session-owner-filter [role="option"][data-value^="owner:"]',
    );
    await expectBrowser(ownerRows).toHaveCount(3);
    await expectBrowser(ownerRows.first()).toHaveAttribute("data-value", "owner:profile-patrick");
    await expectBrowser(ownerRows.first()).toContainText("My sessions");
    await captureDraft(
      page.locator(".sidebar-shell"),
      "00-people-controls-from-session-owners.png",
      [ownerSelect],
    );
    await page.keyboard.press("Escape");
    await chooseSidebarMenuOption(ownerMenu.page(), "Group by", "Person");
    await closeSidebarMenu(page);
    await expectBrowser(
      page.locator('[data-session-section="person:profile:profile-ada"]'),
    ).toContainText("Ada research");
    await expectBrowser(
      page.locator('[data-session-section="person:profile:profile-bob"]'),
    ).toContainText("Bob operations");

    const groupedMenu = await openSidebarSortMenu(page);
    await expectBrowser(groupedMenu.locator("#sidebar-sessions-group")).toHaveAccessibleName(
      "Group by: Person",
    );
    await chooseSidebarMenuOption(groupedMenu.page(), "Group by", "Custom groups");
    await closeSidebarMenu(page);

    const sortableMenu = await openSidebarSortMenu(page);
    await chooseSidebarMenuOption(sortableMenu.page(), "Sort by", "Owners");
    await closeSidebarMenu(page);
    const peopleMenu = await openSidebarSortMenu(page);
    await expectBrowser(peopleMenu.locator("#sidebar-sessions-sort")).toHaveAccessibleName(
      "Sort by: Owners",
    );
    await captureDraft(
      peopleMenu.locator(".sidebar-session-filter-panel"),
      "01-people-sort-selected.png",
      [peopleMenu.locator("#sidebar-sessions-sort")],
    );
    const expectOwnerFilter = async (after: number) => {
      // The chat title survives a sidebar refresh; wait for the filtered row itself.
      await expectBrowser(page.locator('[data-session-section="category:Research"]')).toContainText(
        "Ada research",
      );
      await expectBrowser(page.locator('[data-session-key="agent:main:ada"]')).toBeVisible();
      await expectBrowser(page.locator('[data-session-key="agent:main:bob"]')).toHaveCount(0);
      await expectBrowser(page.locator('[data-session-section="category:Operations"]')).toHaveCount(
        0,
      );
      // The shared roster may also refresh, so the filtered request need not be last.
      await expect
        .poll(async () => (await gateway.getRequests("sessions.list")).slice(after))
        .toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              params: expect.objectContaining({ ownerId: "profile-ada" }),
            }),
          ]),
        );
    };
    const beforeSelection = (await gateway.getRequests("sessions.list")).length;
    await openSidebarMenu(page);
    await chooseSidebarOwner(page, "owner:profile-ada");
    await closeSidebarMenu(page);
    await expectOwnerFilter(beforeSelection);
    await capture(page, "04-owner-filter-selected.png");

    const initialConnections = (await gateway.getRequests("connect")).length;
    const beforeReconnect = (await gateway.getRequests("sessions.list")).length;
    await gateway.closeLatest(1012, "owner filter reconnect proof");
    await expect
      .poll(async () => (await gateway.getRequests("connect")).length)
      .toBeGreaterThan(initialConnections);
    await expectOwnerFilter(beforeReconnect);
    await expectBrowser(page.locator("#sidebar-session-owner-title")).toHaveAccessibleName(
      "Owners: Ada",
    );

    await page.reload();
    // Reload starts a new in-page request log, so no earlier traffic can satisfy this.
    await expectOwnerFilter(0);
    await expectBrowser(page.locator("#sidebar-session-owner-title")).toHaveAccessibleName(
      "Owners: Ada",
    );
    await captureSurface(
      page.locator(".sidebar-shell"),
      "05-owner-filter-restored-after-reload.png",
      [page.locator("#sidebar-session-owner-title")],
    );
  });

  it("keeps unrelated active sessions out of the involving-me filter", async () => {
    const page = await newPage("session-owner-stack");
    const allSessions = sessionsList(["profile-ada", "profile-bob"]);
    const gateway = await installMockGateway(page, {
      hasMultipleSessionSharingIdentities: true,
      sessionKey: "agent:main:ada",
      presenceUsers: [{ self: true, id: "profile-ada", name: "Ada" }],
      historyMessages: [{ role: "assistant", content: [{ type: "text", text: "Ready." }] }],
      methodResponses: {
        "config.get": { config: {}, hash: "owner-filter-fixture" },
        "sessions.list": {
          cases: [
            {
              match: { involvingMe: true },
              response: {
                ...allSessions,
                count: 1,
                sessions: allSessions.sessions.filter(
                  (session) => session.key === "agent:main:ada",
                ),
              },
            },
            { response: allSessions },
          ],
        },
      },
    });

    await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:ada"));
    await chooseSidebarOwner(page, "all");
    await closeSidebarMenu(page);
    await page.getByText("Bob operations", { exact: true }).first().waitFor();
    await chooseSidebarOwner(page, "involving-me");
    await closeSidebarMenu(page);
    await expect.poll(() => page.locator('[data-session-key="agent:main:bob"]').count()).toBe(0);
    await expect
      .poll(async () =>
        (await gateway.getRequests("sessions.list")).some(
          (request) =>
            (request.params as { involvingMe?: unknown } | undefined)?.involvingMe === true,
        ),
      )
      .toBe(true);
    await capture(page, "02-involving-me-before-active-event.png");

    await gateway.emitGatewayEvent("session.message", {
      sessionKey: "agent:main:bob",
      key: "agent:main:bob",
      kind: "direct",
      updatedAt: 3,
      archived: false,
      hasActiveRun: true,
      status: "running",
      owner: { actor: { type: "human", id: "profile-bob", label: "Bob" } },
      participants: [],
      participantCount: 0,
    });

    await expect.poll(() => page.locator('[data-session-key="agent:main:bob"]').count()).toBe(0);
    await expectBrowser(page.locator('[data-session-key="agent:main:ada"]')).toBeVisible();
    await expectBrowser(page.locator("#sidebar-session-owner-title")).toHaveAccessibleName(
      "Owners: Involving me",
    );
    await capture(page, "03-involving-me-after-active-event.png");
    await page.reload();
    await expectBrowser(page.locator('[data-session-key="agent:main:ada"]')).toBeVisible();
    await expect
      .poll(async () =>
        (await gateway.getRequests("sessions.list")).some((request) => {
          const params = request.params as { involvingMe?: unknown; ownerId?: unknown } | undefined;
          return params?.involvingMe === true && params.ownerId === undefined;
        }),
      )
      .toBe(true);
    await expectBrowser(page.locator('[data-session-key="agent:main:bob"]')).toHaveCount(0);
    await expectBrowser(page.locator("#sidebar-session-owner-title")).toHaveAccessibleName(
      "Owners: Involving me",
    );
  });

  it("hides owner avatars with one human and agents, then reveals them for another human", async () => {
    const page = await newPage();
    const solo = sessionsList(["profile-ada", "profile-ada"]);
    const agent = {
      type: "agent" as const,
      id: "research",
      identity: { type: "agent" as const, id: "research" },
      label: "Research",
    };
    const result = {
      ...solo,
      owners: [...solo.owners, agent],
      sessions: solo.sessions.map((session) =>
        Object.assign({}, session, {
          participants: [{ identity: agent.identity, label: agent.label }],
          participantCount: 5,
        }),
      ),
    };
    const gateway = await installMockGateway(page, {
      sessionKey: "agent:main:ada",
      presenceUsers: [{ self: true, id: "profile-ada", name: "Ada" }],
      historyMessages: [{ role: "assistant", content: [{ type: "text", text: "Ready." }] }],
      methodResponses: { "sessions.list": result },
    });
    await page.clock.install();
    await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:ada"));
    await chooseSidebarOwner(page, "all");
    await closeSidebarMenu(page);
    const row = page.locator('[data-session-key="agent:main:ada"]');
    await expectBrowser(row).toBeVisible();
    await page.getByText("Ready.", { exact: true }).waitFor();
    await capture(page, "one-human-with-agents.png");
    await expectBrowser(row.locator("openclaw-session-owner-chip")).toHaveCount(0);

    await pauseVirtualClock(page);
    await page.evaluate(() => {
      Math.random = () => 0;
    });
    const rosterMatch = { includeGlobal: true };
    const initialRequests = (await gateway.getRequests("sessions.list", rosterMatch)).length;
    await gateway.setMethodResponse("sessions.list", sessionsList(["profile-ada", "profile-bob"]));
    await gateway.emitGatewayEvent("sessions.changed", {});
    await page.clock.runFor(4_999);
    expect(await gateway.getRequests("sessions.list", rosterMatch)).toHaveLength(initialRequests);
    await expectBrowser(row.locator("openclaw-session-owner-chip")).toHaveCount(0);
    // Cross the event window and deliver the nested mock response timer.
    await page.clock.runFor(2);
    expect(await gateway.getRequests("sessions.list", rosterMatch)).toHaveLength(
      initialRequests + 1,
    );
    await page.clock.resume();
    await expectBrowser(row.locator("openclaw-session-owner-chip")).toHaveCount(1);
    await capture(page, "multiple-humans.png");
  });

  it("keeps global session actions accessible to keyboard users", async () => {
    const page = await newPage();
    await installMockGateway(page, {
      sessionKey: "agent:main:ada",
      featureMethods: ["chat.metadata", "chat.startup", "sessions.create"],
      historyMessages: [{ role: "assistant", content: [{ type: "text", text: "Ready." }] }],
      methodResponses: { "sessions.list": sessionsList(["profile-ada", "profile-ada"]) },
    });

    await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:ada"));
    await page.getByText("Ada research", { exact: true }).first().waitFor();
    await page.getByText("Bob operations", { exact: true }).first().waitFor();

    const filterAndSort = page.getByRole("button", { name: "Filter & sort", exact: true });
    await filterAndSort.focus();
    await page.keyboard.press("Enter");

    const menu = page.locator(".sidebar-session-sort-menu");
    await menu.getByRole("dialog").waitFor();
    expect(await menu.locator("#sidebar-sessions-owner").count()).toBe(0);
    await menu.locator("#sidebar-sessions-group").click();
    expect(await menu.getByRole("option", { name: "Person", exact: true }).count()).toBe(0);
    await page.keyboard.press("Escape");
    await menu.locator("#sidebar-sessions-sort").click();
    expect(await menu.getByRole("option", { name: "Owners", exact: true }).count()).toBe(0);
    await page.keyboard.press("Escape");
    await chooseSidebarMenuOption(menu.page(), "Group by", "None");
    await closeSidebarMenu(page);

    await expect.poll(() => page.locator('[data-session-section^="category:"]').count()).toBe(0);
    const threads = page.locator('[data-session-section="ungrouped"]');
    await expect.poll(() => threads.locator(".sidebar-recent-session").count()).toBe(2);

    const newThread = page.locator(".sidebar-rail").getByRole("link", { name: "New conversation" });
    await newThread.focus();
    await page.keyboard.press("Enter");
    await expect.poll(() => new URL(page.url()).pathname).toBe("/new");
  });

  it("keeps own drafts subtle and fades admin-visible drafts from other people", async () => {
    const page = await newPage("drafts-ux");
    await installMockGateway(page, {
      sessionKey: "agent:main:ada",
      presenceUsers: [{ self: true, id: "profile-ada", name: "Ada" }],
      methodResponses: { "sessions.list": draftSessionsList() },
    });

    await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:ada"));
    await chooseSidebarOwner(page, "all");
    await closeSidebarMenu(page);
    const ownDraft = page.locator('[data-session-key="agent:main:ada"]');
    const otherDraft = page.locator('[data-session-key="agent:main:bob"]');
    await ownDraft.waitFor();
    await otherDraft.waitFor();
    await expect
      .poll(() => ownDraft.getAttribute("class"))
      .toContain("session-row-host--draft-owner");
    await expect
      .poll(() => otherDraft.getAttribute("class"))
      .toContain("session-row-host--draft-other");
    expect(await page.locator(".session-row-draft-indicator").count()).toBe(2);
    await captureDraft(page.locator(".shell"), "01-sidebar-draft-treatment.png", [
      ownDraft,
      otherDraft,
    ]);
    await page.evaluate(() => document.documentElement.setAttribute("data-theme-mode", "dark"));
    await captureDraft(page.locator(".shell"), "01-sidebar-draft-treatment-dark.png", [
      ownDraft,
      otherDraft,
    ]);
  });

  it("creates a draft atomically from the multi-person new-session flow", async () => {
    const page = await newPage("drafts-ux");
    const gateway = await installMockGateway(page, {
      allowedSessionVisibilities: ["shared", "draft"],
      featureMethods: ["chat.metadata", "chat.startup", "sessions.create"],
      hasMultipleSessionSharingIdentities: true,
      methodResponses: {
        "sessions.list": sessionsList(["profile-ada", "profile-bob"]),
        "sessions.create": { key: "agent:main:new-draft", runStarted: true },
      },
    });

    await page.goto(`${suite.server?.baseUrl ?? ""}new`);
    // Playwright check()/isChecked() support role="switch" buttons via aria-checked.
    const draftToggle = page.getByRole("switch", { name: "Draft", exact: true });
    await page.locator(".new-session-page__composer .agent-chat__composer-footer").hover();
    await draftToggle.waitFor();
    await captureDraft(draftToggle, "02-create-draft-available.png", [draftToggle]);
    await draftToggle.check();
    await expectBrowser(draftToggle).toBeChecked();
    await page.locator(".new-session-page__message").fill("work privately first");
    await captureDraft(draftToggle, "03-create-draft-selected.png", [
      page.locator(".new-session-page__message"),
    ]);
    await page.getByRole("button", { name: "Start session" }).click();

    const create = await gateway.waitForRequest("sessions.create");
    expect(create.params).toMatchObject({
      agentId: "main",
      message: "work privately first",
      visibility: "draft",
    });
  });

  it("keeps rejected visibility-only sharing changes visible after the menu closes", async () => {
    const page = await newPage();
    const sessions = ownerSessions("draft");
    const gateway = await installMockGateway(page, {
      sessionKey: "agent:main:ada",
      allowedSessionVisibilities: ["shared", "draft"],
      deferredMethods: ["session.visibility.set"],
      featureMethods: ["chat.metadata", "chat.startup", "session.visibility.set"],
      operatorScopes: ["operator.write"],
      historyMessages: [{ role: "assistant", content: [{ type: "text", text: "Ready." }] }],
      methodResponses: { "sessions.list": sessions },
    });

    await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:ada"));
    await page.getByText("Ready.", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Session sharing" }).click();
    const dropdown = page.locator(".chat-pane__sharing-menu");
    const panel = dropdown.locator(".chat-pane__sharing-panel");
    await expect
      .poll(() => panel.evaluate((element) => element.matches(":popover-open")))
      .toBe(true);
    await expectBrowser(dropdown.locator(".chat-pane__sharing-title")).toHaveCount(3);
    await page.getByText("Publish draft", { exact: true }).click();
    await gateway.waitForRequest("session.visibility.set");
    await expect
      .poll(() => panel.evaluate((element) => element.matches(":popover-open")))
      .toBe(false);
    expect(await gateway.getRequests("session.members.listEvidence")).toHaveLength(0);

    const message = "visibility change rejected";
    await gateway.rejectDeferred("session.visibility.set", {
      code: "INVALID_REQUEST",
      message,
    });
    const alert = page.locator(".chat-error[role=alert]").filter({ hasText: message });
    await expectBrowser(alert).toBeVisible();

    await page.getByRole("button", { name: "Session sharing" }).click();
    await expectBrowser(dropdown.getByRole("alert").filter({ hasText: message })).toBeVisible();
  });

  it("lets a read-scoped owner inspect sharing but blocks mutations", async () => {
    const page = await newPage();
    const sessions = ownerSessions("draft");
    const gateway = await installMockGateway(page, {
      sessionKey: "agent:main:ada",
      featureMethods: [
        "chat.metadata",
        "chat.startup",
        "session.visibility.set",
        "session.members.listEvidence",
        "session.members.add",
        "session.members.remove",
      ],
      operatorScopes: ["operator.read"],
      historyMessages: [{ role: "assistant", content: [{ type: "text", text: "Ready." }] }],
      methodResponses: {
        "sessions.list": sessions,
        "session.members.listEvidence": {
          sessionKey: "agent:main:ada",
          members: [],
          identities: [{ type: "human", id: "profile-bob", label: "Bob" }],
          role: "owner",
          allowedVisibilities: ["shared", "draft"],
        },
      },
    });

    await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:ada"));
    await page.getByText("Ready.", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Session sharing", exact: true }).click();
    await gateway.waitForRequest("session.members.listEvidence");
    const dropdown = page.locator(".chat-pane__sharing-menu");
    const publish = dropdown.locator('button[value="visibility:shared"]');
    const member = dropdown.locator('button[value="member:profile-bob"]');
    await expectBrowser(publish).toBeVisible();
    await expectBrowser(publish).toBeDisabled();
    await expectBrowser(member).toBeVisible();
    await expectBrowser(member).toBeDisabled();
    await dropdown.evaluate((element) => {
      element.querySelector<HTMLButtonElement>('button[value="visibility:shared"]')?.click();
      element.querySelector<HTMLButtonElement>('button[value="member:profile-bob"]')?.click();
    });

    expect(await gateway.getRequests("session.visibility.set")).toHaveLength(0);
    expect(await gateway.getRequests("session.members.add")).toHaveLength(0);
  });

  it("scrolls the complete sharing directory through one compact menu", async () => {
    const page = await newPage(undefined, 1280);
    const sessions = ownerSessions("shared", true);
    const longMemberLabel =
      "Alexandria Montgomery-Santiago from the International Collaboration Working Group";
    const longMemberId = `profile:${"member-without-a-display-name-".repeat(6)}`;
    const humanIdentities = [
      { type: "human" as const, id: "profile-long-name", label: longMemberLabel },
      { type: "human" as const, id: longMemberId },
      ...Array.from({ length: 28 }, (_, index) => ({
        type: "human" as const,
        id: `profile-member-${index}`,
        label: `Member ${index + 1}`,
      })),
    ];
    const nonHumanIdentities = [
      { type: "agent" as const, id: "agent-design", label: "Design" },
      { type: "system" as const, id: "system-operations", label: "Operations" },
    ];
    const gateway = await installMockGateway(page, {
      sessionKey: "agent:main:ada",
      hasMultipleSessionSharingIdentities: true,
      featureMethods: [
        "chat.metadata",
        "chat.startup",
        "session.members.listEvidence",
        "session.members.add",
        "session.members.remove",
        "session.visibility.set",
      ],
      operatorScopes: ["operator.read", "operator.write"],
      historyMessages: [{ role: "assistant", content: [{ type: "text", text: "Ready." }] }],
      methodResponses: {
        "sessions.list": sessions,
        "session.members.listEvidence": {
          sessionKey: "agent:main:ada",
          members: [{ identityId: longMemberId, addedBy: "profile-ada", addedAt: 1 }],
          identities: [...humanIdentities, ...nonHumanIdentities],
          role: "owner",
          allowedVisibilities: ["shared", "read-only", "suggest", "draft"],
        },
      },
    });

    await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:ada"));
    await page.getByText("Ready.", { exact: true }).waitFor();
    await page.locator(".chat-pane__sharing-trigger").click();
    await gateway.waitForRequest("session.members.listEvidence");
    const dropdown = page.locator(".chat-pane__sharing-menu");
    await dropdown.locator('button[value="member:profile-member-0"]').waitFor();
    await dropdown.evaluate(async (element) => {
      const menu = element.querySelector<HTMLElement>(".chat-pane__sharing-panel");
      const animations = [...element.getAnimations(), ...(menu?.getAnimations() ?? [])];
      await Promise.all(animations.map((animation) => animation.finished.catch(() => {})));
    });
    const longNameItem = dropdown.locator('button[value="member:profile-long-name"]');
    const longIdItem = dropdown.locator(`button[value="member:${longMemberId}"]`);

    await longIdItem.scrollIntoViewIfNeeded();
    const selectedIndicator = longIdItem.locator(".session-menu__check");
    await expectBrowser(selectedIndicator).toBeVisible();
    const selectedIndicatorContained = await longIdItem.evaluate((item) => {
      const indicator = item.querySelector<HTMLElement>(".session-menu__check");
      const itemRect = item.getBoundingClientRect();
      const indicatorRect = indicator?.getBoundingClientRect();
      return Boolean(
        indicatorRect &&
        indicatorRect.left >= itemRect.left &&
        indicatorRect.right <= itemRect.right,
      );
    });
    expect(selectedIndicatorContained).toBe(true);

    const beforeScroll = await dropdown.evaluate((element) => {
      const query = (part: string) =>
        element.querySelector<HTMLElement>(`.chat-pane__sharing-${part}`);
      const menu = query("panel");
      if (menu) {
        menu.scrollTop = 0;
      }
      const visibilityTitle = query("visibility-title");
      const membersTitle = query("members-title");
      const firstMember = query("member");
      const style = (node: HTMLElement | null) => (node ? getComputedStyle(node) : undefined);
      const visibilityRects = [
        ...element.querySelectorAll(".chat-pane__sharing-visibility-item"),
      ].map((item) => item.getBoundingClientRect());
      const longLabels = [
        ...element.querySelectorAll<HTMLElement>(".chat-pane__sharing-member-label"),
      ].slice(0, 2);
      const menuRect = menu?.getBoundingClientRect();
      const previousVisibilityRect = visibilityRects.at(-2);
      const lastVisibilityRect = visibilityRects.at(-1);
      const membersTitleRect = membersTitle?.getBoundingClientRect();
      return {
        menuHeight: menuRect?.height ?? 0,
        menuTop: menuRect?.top ?? 0,
        scrollHeight: menu?.scrollHeight ?? 0,
        clientHeight: menu?.clientHeight ?? 0,
        scrollWidth: menu?.scrollWidth ?? 0,
        clientWidth: menu?.clientWidth ?? 0,
        longLabelsContained: longLabels.every((label) => {
          const rect = label.getBoundingClientRect();
          return menuRect ? rect.left >= menuRect.left && rect.right <= menuRect.right : false;
        }),
        longLabelsOverflow: longLabels.every((label) => label.scrollWidth > label.clientWidth),
        firstMemberTop: firstMember?.getBoundingClientRect().top ?? 0,
        groupGap:
          membersTitleRect && lastVisibilityRect
            ? membersTitleRect.top - lastVisibilityRect.bottom
            : 0,
        rowGap:
          previousVisibilityRect && lastVisibilityRect
            ? lastVisibilityRect.top - previousVisibilityRect.bottom
            : 0,
        membersTitleInset: Number.parseFloat(style(membersTitle)?.paddingInlineStart ?? "0"),
        firstMemberInset: Number.parseFloat(style(firstMember)?.paddingInlineStart ?? "0"),
        visibilityTitlePosition: style(visibilityTitle)?.position ?? "",
        membersTitlePosition: style(membersTitle)?.position ?? "",
        nestedScrollers: [...(menu?.children ?? [])].filter(
          (node) =>
            node.scrollHeight > node.clientHeight &&
            ["auto", "scroll"].includes(getComputedStyle(node).overflowY),
        ).length,
      };
    });
    const afterScroll = await dropdown.evaluate(async (element) => {
      const query = (part: string) =>
        element.querySelector<HTMLElement>(`.chat-pane__sharing-${part}`);
      const menu = query("panel");
      if (menu) {
        menu.scrollTop = menu.scrollHeight;
      }
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
      });
      return {
        scrollTop: menu?.scrollTop ?? 0,
        visibilityTitleBottom: query("visibility-title")?.getBoundingClientRect().bottom ?? 0,
        membersTitleTop: query("members-title")?.getBoundingClientRect().top ?? 0,
        firstMemberTop: query("member")?.getBoundingClientRect().top ?? 0,
      };
    });

    expect(beforeScroll.menuHeight).toBeLessThanOrEqual(421);
    expect(beforeScroll.scrollHeight).toBeGreaterThan(beforeScroll.clientHeight);
    expect(beforeScroll.scrollWidth).toBe(beforeScroll.clientWidth);
    expect(beforeScroll.longLabelsContained).toBe(true);
    expect(beforeScroll.longLabelsOverflow).toBe(true);
    expect(beforeScroll.membersTitleInset).toBe(beforeScroll.firstMemberInset);
    expect(beforeScroll.groupGap).toBeGreaterThanOrEqual(8);
    expect(beforeScroll.groupGap).toBeGreaterThan(beforeScroll.rowGap + 6);
    expect(beforeScroll.visibilityTitlePosition).not.toBe("sticky");
    expect(beforeScroll.membersTitlePosition).not.toBe("sticky");
    expect(beforeScroll.nestedScrollers).toBe(0);
    expect(afterScroll.scrollTop).toBeGreaterThan(0);
    expect(afterScroll.visibilityTitleBottom).toBeLessThan(beforeScroll.menuTop);
    expect(afterScroll.membersTitleTop).toBeLessThan(beforeScroll.menuTop);
    expect(afterScroll.firstMemberTop).toBeLessThan(beforeScroll.firstMemberTop);
    await expectBrowser(
      dropdown.locator(".chat-pane__sharing-member openclaw-session-owner-chip"),
    ).toHaveCount(30);
    await expect
      .poll(() => tooltipTitleText(longNameItem.locator(".chat-pane__sharing-member-label")))
      .toBe(longMemberLabel);
    await expect
      .poll(() => tooltipTitleText(longIdItem.locator(".chat-pane__sharing-member-label")))
      .toBe(longMemberId);
    await expectBrowser(selectedIndicator).toHaveCount(1);
    expect(await selectedIndicator.getAttribute("aria-label")).not.toBeNull();
    // All identities share one list; owner-chip presentation remains human-only.
    await expectBrowser(dropdown.locator(".chat-pane__sharing-member-icon > svg")).toHaveCount(2);
    await expectBrowser(dropdown.getByRole("button", { name: "Next", exact: true })).toHaveCount(0);
    await expectBrowser(
      dropdown.getByRole("button", { name: "Previous", exact: true }),
    ).toHaveCount(0);
  });

  it("clears a selected draft mode when sharing policy becomes unavailable", async () => {
    const page = await newPage();
    const gateway = await installMockGateway(page, {
      allowedSessionVisibilities: ["shared", "draft"],
      hasMultipleSessionSharingIdentities: true,
      methodResponses: { "sessions.list": sessionsList(["profile-ada", "profile-bob"]) },
    });

    await page.goto(`${suite.server?.baseUrl ?? ""}new`);
    const draftToggle = page.getByRole("switch", { name: "Draft", exact: true });
    await page.locator(".new-session-page__composer .agent-chat__composer-footer").hover();
    await draftToggle.check();
    await gateway.setSessionSharingPolicy({
      allowedSessionVisibilities: ["shared"],
      hasMultipleSessionSharingIdentities: false,
    });
    await replaceGatewayClient(page);
    await expect
      .poll(() => page.getByRole("button", { name: "Draft", exact: true }).count())
      .toBe(0);

    await gateway.setSessionSharingPolicy({
      allowedSessionVisibilities: ["shared", "draft"],
      hasMultipleSessionSharingIdentities: true,
    });
    await replaceGatewayClient(page);
    await page.locator(".new-session-page__composer .agent-chat__composer-footer").hover();
    await draftToggle.waitFor();
    expect(await draftToggle.isChecked()).toBe(false);
  });

  it("aligns the Share trigger with the neighboring Layout trigger", async () => {
    const page = await newPage();
    const sessions = ownerSessions("shared");
    await installMockGateway(page, {
      sessionKey: "agent:main:ada",
      featureMethods: ["chat.metadata", "chat.startup", "session.visibility.set"],
      operatorScopes: ["operator.write"],
      historyMessages: [{ role: "assistant", content: [{ type: "text", text: "Ready." }] }],
      methodResponses: { "sessions.list": sessions },
    });

    await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:ada"));
    await page.getByText("Ready.", { exact: true }).waitFor();
    const share = page.locator(".chat-pane__sharing-trigger");
    const layout = page.locator(".chat-pane__layout-trigger");
    await share.waitFor();
    await layout.waitFor();
    const measure = (trigger: typeof share) =>
      trigger.evaluate((button) => {
        const bounds = button.getBoundingClientRect();
        const icon = button.querySelector("svg")!.getBoundingClientRect();
        const range = document.createRange();
        const label = document.createTreeWalker(button, NodeFilter.SHOW_TEXT, (node) =>
          node.textContent?.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP,
        );
        range.selectNodeContents(label.nextNode()!);
        const text = range.getBoundingClientRect();
        return {
          height: bounds.height,
          gap: text.left - icon.right,
          iconOffset: icon.top + icon.height / 2 - (bounds.top + bounds.height / 2),
        };
      });
    const [shareMetrics, layoutMetrics] = await Promise.all([measure(share), measure(layout)]);
    expect(shareMetrics.height).toBeCloseTo(layoutMetrics.height, 1);
    expect(shareMetrics.gap).toBeCloseTo(layoutMetrics.gap, 1);
    expect(shareMetrics.iconOffset).toBeCloseTo(layoutMetrics.iconOffset, 1);
  });
});
