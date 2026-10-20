/* @vitest-environment jsdom */

import { expect, it, onTestFinished, vi } from "vitest";
import { registerModalSurface } from "../../components/overlay-registry.ts";
import { getRenderedModalDialog, installDialogPolyfill } from "../../test-helpers/modal-dialog.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import {
  createGatewayBrowserClientFixture,
  createSessionCapabilityFixture,
  createTestChatPane,
} from "./chat-pane.test-support.ts";
import { getChatComposerState } from "./components/chat-composer-state.ts";
import {
  configureNativeKeyTarget,
  nativeControlNavigationCases,
} from "./test-helpers/chat-scroll-input.tsx";

function createFocusedPane() {
  const { pane } = createTestChatPane({
    client: createGatewayBrowserClientFixture(),
    sessions: createSessionCapabilityFixture(),
  });
  pane.active = true;
  pane.presented = true;
  const composer = document.createElement("div");
  composer.className = "agent-chat__composer-combobox";
  const textarea = composer.appendChild(document.createElement("textarea"));
  getChatComposerState(pane.presentationId).composerTextarea = textarea;
  pane.append(composer);
  return { pane, focus: vi.spyOn(textarea, "focus") };
}

function typingTarget(pane: ReturnType<typeof createFocusedPane>["pane"], target: HTMLElement) {
  target.addEventListener("keydown", (event) => pane.handleDocumentKeydown(event));
  target.focus();
  target.dispatchEvent(new KeyboardEvent("keydown", { key: "x", bubbles: true, composed: true }));
}

function bodyElement<K extends keyof HTMLElementTagNameMap>(tag: K) {
  const element = document.body.appendChild(document.createElement(tag));
  onTestFinished(() => element.remove());
  return element;
}

it.each([
  ["range", "Home", () => <input type="range" />, false],
  ["input", "ArrowUp", () => <input />, false],
  [
    "handled widget",
    "PageUp",
    () => <div onKeyDown={(event: KeyboardEvent) => event.preventDefault()}>Widget</div>,
    false,
  ],
  ["transcript", "Home", () => <span>History</span>, true],
  ...nativeControlNavigationCases
    // Windows covers non-Apple paging, video covers native media, and Home covers Mac edges.
    .filter((testCase) => {
      const [name, key] = testCase;
      const fixture = testCase[4];
      return (
        ["ArrowUp", "Home", "PageUp"].includes(key) &&
        !name.startsWith("Linux ") &&
        !name.startsWith("audio ") &&
        !(name.startsWith("video ") && (fixture.shiftKey || fixture.ctrlKey)) &&
        !(name.startsWith("Mac ") && key === "PageUp")
      );
    })
    .map(
      ([name, key, content, controlOwned, fixture]) =>
        [name, key, content, !controlOwned, fixture] as const,
    ),
] as const)(
  "loads older history only when %s yields navigation",
  async (_name, key, content, loadsHistory, fixture = {}) => {
    vi.useFakeTimers();
    const request = vi.fn(async () => ({ messages: [], hasMore: false }));
    const { pane, state } = createTestChatPane({
      client: createGatewayBrowserClientFixture({ request }),
      sessions: createSessionCapabilityFixture(),
    });
    vi.spyOn(pane.transcript, "isPositionSettled", "get").mockReturnValue(true);
    state.chatHistoryPagination = { hasMore: true, nextOffset: 2 };
    pane.historyAutoLoadBlocked = true;
    const { container } = mountSolid(() => (
      <div onKeyDown={(event) => pane.handleTranscriptHistoryIntent(event)}>{content()}</div>
    ));
    const thread = container.querySelector("div")!;
    const sentinel = Object.assign(document.createElement("div"), {
      className: "chat-history-sentinel",
    });
    thread.append(sentinel);
    pane.historySentinel = sentinel;
    vi.spyOn(pane.transcript, "scrollElement", "get").mockReturnValue(thread);
    const restorePlatform = configureNativeKeyTarget(thread.firstElementChild!, fixture);
    try {
      thread.firstElementChild!.dispatchEvent(
        new KeyboardEvent("keydown", {
          key,
          shiftKey: fixture.shiftKey,
          ctrlKey: fixture.ctrlKey,
          bubbles: true,
          cancelable: true,
        }),
      );
      await Promise.resolve();
      expect(request).toHaveBeenCalledTimes(loadsHistory ? 1 : 0);
      expect(pane.historyAutoLoadBlocked).toBe(!loadsHistory);
    } finally {
      restorePlatform();
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  },
);

it("keeps the letter-to-composer contract when a button is focused", () => {
  const { pane, focus } = createFocusedPane();
  typingTarget(pane, bodyElement("button"));
  expect(focus).toHaveBeenCalledWith({ preventScroll: true });
});

it("distinguishes an open disclosure from an open overlay", () => {
  const { pane, focus } = createFocusedPane();
  const details = bodyElement("details");
  details.open = true;
  const summary = details.appendChild(document.createElement("summary"));
  typingTarget(pane, summary);
  expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  focus.mockClear();
  const dialog = bodyElement("dialog");
  dialog.open = true;
  typingTarget(pane, dialog.appendChild(document.createElement("button")));
  expect(focus).not.toHaveBeenCalled();
});

it("does not steal typing focus from a shadow-root confirmation", async () => {
  const restoreDialogPolyfill = installDialogPolyfill();
  const { pane, focus } = createFocusedPane();
  const container = document.body.appendChild(document.createElement("div"));
  onTestFinished(() => {
    container.remove();
    restoreDialogPolyfill();
  });
  const shadow = container.attachShadow({ mode: "open" });
  const modal = shadow.appendChild(document.createElement("openclaw-modal-dialog"));
  const cancel = modal.appendChild(document.createElement("button"));

  const { dialog } = await getRenderedModalDialog(shadow);
  expect(dialog.open).toBe(true);
  expect(dialog.getRootNode()).toBe(shadow);
  expect(document.querySelector("dialog[open]")).toBeNull();
  cancel.addEventListener("keydown", (event) => pane.handleDocumentKeydown(event));
  cancel.dispatchEvent(new KeyboardEvent("keydown", { key: "x", cancelable: true }));
  expect(focus).not.toHaveBeenCalled();
});

it("does not steal typing focus from a light-DOM confirmation", () => {
  const { pane, focus } = createFocusedPane();
  const modal = bodyElement("div");
  modal.setAttribute("aria-modal", "true");
  onTestFinished(registerModalSurface(modal));
  pane.handleDocumentKeydown(new KeyboardEvent("keydown", { key: "x", cancelable: true }));
  expect(focus).not.toHaveBeenCalled();
});
