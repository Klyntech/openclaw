/* @vitest-environment jsdom */

import { expect, it, onTestFinished, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { sidebarPanelDefinitions } from "./chat-pane-embedded-panels.ts";
import {
  createPaneHeaderWorkspaceFixture,
  createSessionCapabilityFixture,
  createTestChatPane,
} from "./chat-pane.test-support.ts";
import {
  mountChatPaneHeader,
  openNativeMenu,
  renderPaneHeaderInto,
} from "./components/chat-pane-header.test-support.ts";
import { openSlot, promoteSidebarPanel, setSidebarOpen } from "./sidebar-layout.ts";

function layoutControls(container: HTMLElement) {
  const query = (selector: string) => container.querySelector<HTMLElement>(selector)!;
  const open = async () => {
    await openNativeMenu(query(".chat-pane__layout-menu"));
    return query(".oc-menu");
  };
  return { query, open, action: (label: string) => query(`[aria-label="${label}"]`) };
}

it("keeps Layout actions available across plugin panel swaps", async () => {
  const { pane, state } = createTestChatPane({
    client: { request: vi.fn() } as unknown as GatewayBrowserClient,
    sessions: createSessionCapabilityFixture(),
  });
  const slot = "plugin:fixture/notes";
  const definitions = sidebarPanelDefinitions();
  definitions.push({
    slot,
    label: "Fixture notes",
    icon: definitions[0]!.icon,
    available: true,
    content: "Notes",
    loading: { variant: "files", label: "Loading notes" },
    empty: { description: "No notes" },
  });
  state.sidebarLayout = promoteSidebarPanel(openSlot({ columns: [] }, slot), slot);
  const container = document.body.appendChild(document.createElement("div"));
  onTestFinished(() => container.remove());
  const paint = () => {
    renderPaneHeaderInto(
      pane.renderPaneHeader(
        createPaneHeaderWorkspaceFixture(state),
        { key: state.sessionKey, kind: "direct", updatedAt: 0 },
        false,
        undefined,
        false,
        null,
        state.sidebarLayout,
        definitions,
      ),
      container,
    );
    flush();
  };
  const { action, open, query } = layoutControls(container);
  const activate = async (label: string) => {
    const panel = await open();
    action(label).click();
    await waitForSolid(() => expect(panel.matches(":popover-open")).toBe(false));
  };

  paint();
  await open();
  expect(container.querySelectorAll(".chat-pane__header")).toHaveLength(1);
  expect(container.querySelectorAll(".chat-side-panel-toggle")).toHaveLength(1);
  expect(action("Swap Fixture notes and Chat")).not.toBeNull();
  await activate("Focus");
  expect(state.sidebarLayout.expanded).toBe(true);
  state.connected = false;
  paint();
  expect(query(".chat-panel-swap")).toBeNull();
  expect(action("Restore split")!.matches(":disabled")).toBe(false);
  await activate("Restore split");
  expect(state.sidebarLayout.expanded).toBe(false);
  paint();
  expect(action("Swap Fixture notes and Chat")!.matches(":disabled")).toBe(false);
  await activate("Swap Fixture notes and Chat");
  paint();
  expect(action("Swap Chat and Fixture notes")).not.toBeNull();

  state.sidebarLayout = setSidebarOpen({ columns: [] }, true);
  paint();
  expect(query(".chat-panel-swap")).toBeNull();
  expect(container.querySelectorAll(".chat-side-panel-toggle")).toHaveLength(1);
  await activate("Minimize side panel");
  expect(state.sidebarLayout.open).toBe(false);
});

it("retains focused Layout controls and an open menu when header props refresh", async () => {
  const focusAtSplit: (Element | null)[] = [];
  const onSplitRight = vi.fn<(paneId: string) => void>(() => {
    focusAtSplit.push(document.activeElement);
  });
  const layoutProps = () => ({
    sidebarLayout: openSlot({ columns: [] }, "workspace"),
    panelDefinitions: sidebarPanelDefinitions(),
  });
  const mounted = mountChatPaneHeader([], {
    onClosePane: vi.fn(),
    onSplitRight,
    ...layoutProps(),
    onLayoutChange: vi.fn(),
  });
  onTestFinished(() => mounted.container.remove());
  const { query, open } = layoutControls(mounted.container);
  const selectors = [
    ".chat-pane__layout-trigger",
    ".chat-pane__close-pane",
    ".chat-pane__split-right",
    ".chat-pane__layout-menu",
  ];
  const panel = await open();
  const controls = selectors.map((selector) => query(selector));
  const trigger = controls[0]!;
  const split = controls[2]!;
  trigger.focus();
  mounted.update({
    title: "Updated session title",
    ...layoutProps(),
  });
  selectors.forEach((selector, index) => expect(query(selector)).toBe(controls[index]));
  expect(document.activeElement).toBe(trigger);
  expect(panel.matches(":popover-open")).toBe(true);
  split.focus();
  split.click();
  await waitForSolid(() => expect(panel.matches(":popover-open")).toBe(false));
  expect(document.activeElement).toBe(trigger);
  expect(focusAtSplit).toEqual([trigger]);
  expect(onSplitRight).toHaveBeenCalledExactlyOnceWith("pane-1");
});

it("keeps a native external panel link when it is the only Layout action", async () => {
  // jsdom has no layout; this fixture's only native control is visible.
  Object.defineProperty(HTMLElement.prototype, "checkVisibility", {
    configurable: true,
    value: () => true,
  });
  onTestFinished(() => {
    Reflect.deleteProperty(HTMLElement.prototype, "checkVisibility");
  });
  const panelDefinitions = sidebarPanelDefinitions();
  panelDefinitions.find((definition) => definition.slot === "conversation")!.headerLink = {
    href: "https://example.test/panel",
    label: "Open panel",
  };
  const mounted = mountChatPaneHeader([], { sidebarLayout: { columns: [] }, panelDefinitions });
  const { action, open } = layoutControls(mounted.container);
  await open();
  const link = action("Open panel");
  expect(link).toMatchObject({
    href: "https://example.test/panel",
    target: "_blank",
    rel: "noopener",
  });
  expect(link.closest(".oc-menu")?.matches(":popover-open")).toBe(true);
});
