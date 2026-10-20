/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { flush } from "../../test-helpers/solid-settle.ts";
import { nativeHistoryMessage } from "./chat-pane-history.test-support.ts";
import {
  createGatewayBrowserClientFixture,
  createInitializationContext,
  createRenderTestChatPane,
  type TestChatPane,
} from "./chat-pane.test-support.ts";
import { subscribeTranscriptScroll } from "./components/chat-transcript-scroll-events.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
  requireElement,
  resizeObservers,
  transcriptDomState,
} from "./components/chat-transcript.test-support.ts";
import {
  mountTestTranscript,
  numberedContentRows,
} from "./test-helpers/chat-transcript-native.tsx";

beforeEach(installTranscriptDomMocks);
afterEach(() => {
  // Disconnect the real pane while its observers and timers still exist.
  document.body.replaceChildren();
  vi.useRealTimers();
  resetTranscriptTestDom();
});

it.each(["idle measurement", "end-command measurement", "native end clamp"] as const)(
  "does not request older history or take reader ownership after %s",
  async (movement) => {
    transcriptDomState.measuredRowHeight = 120;
    vi.useFakeTimers();
    const context = createInitializationContext();
    context.config.subscribe = () => () => {};
    const pane = createRenderTestChatPane();
    // Independent scenarios must not restore the previous case's cached reader.
    pane.paneId = `maintenance-history-${movement}`;
    pane.initialize(context);
    document.body.append(pane.element);
    await pane.updateComplete;
    const state = (pane as unknown as TestChatPane).state;
    state.sessionKey = "agent:main:maintenance-history";
    const request = vi.fn(async () => ({
      messages: [1, 2].map((seq) => nativeHistoryMessage(seq)),
      hasMore: false,
      totalMessages: 4,
    }));
    state.client = createGatewayBrowserClientFixture({ request });
    state.connected = true;
    state.chatMessages = [nativeHistoryMessage(3), nativeHistoryMessage(4)];
    state.chatHistoryPagination = { hasMore: true, nextOffset: 2, totalMessages: 4 };
    state.chatLoading = false;
    state.chatHasAutoScrolled = true;
    pane.render();
    const props = expectDefined(pane.chatProps, "rendered pane callbacks");
    const rows = numberedContentRows(12);
    const mounting = mountTestTranscript("maintenance-history", rows, props.transcript);
    await vi.advanceTimersByTimeAsync(0);
    const { container, renderRows, transcript, session } = await mounting;
    session.setContentReady(true);
    let maximum = 800;
    Object.defineProperties(container, {
      clientHeight: { configurable: true, value: 600 },
      scrollHeight: { configurable: true, get: () => maximum + 600 },
    });
    container.scrollTo = (options?: ScrollToOptions | number) => {
      if (typeof options === "object") {
        container.scrollTop = Math.max(0, Math.min(options.top ?? container.scrollTop, maximum));
      }
    };
    container.addEventListener(
      "scroll",
      expectDefined(props.onChatScroll, "native scroll callback"),
    );
    for (const observer of resizeObservers) {
      observer.emitTarget(container, 800, 600);
    }
    let scrolling: boolean | undefined;
    const stopObserving = subscribeTranscriptScroll(container, (event) => {
      if (event.type === "offset") {
        scrolling = event.scrolling;
      }
    });
    // Finish initial anchoring before exercising maintenance above the end.
    renderRows(rows);
    flush();
    vi.advanceTimersToNextFrame();
    flush();
    expect(container.scrollTop).toBe(800);
    expect(transcript.scrollToEnd({ behavior: "instant" })).toBe(true);
    expect(transcript.isPositionSettled).toBe(true);
    container.dispatchEvent(new Event("scroll"));
    renderRows(rows);
    const sentinel = container.appendChild(document.createElement("div"));
    sentinel.className = "chat-history-sentinel";
    pane.historySentinel = sentinel;

    class HistoryIntersectionObserver {
      constructor(private readonly callback: IntersectionObserverCallback) {}
      observe() {
        this.callback(
          [{ isIntersecting: true } as IntersectionObserverEntry],
          this as unknown as IntersectionObserver,
        );
      }
      disconnect() {}
    }
    vi.stubGlobal("IntersectionObserver", HistoryIntersectionObserver);
    await vi.advanceTimersByTimeAsync(150);
    stopObserving();
    expect(scrolling).toBe(false);
    expect(request).not.toHaveBeenCalled();
    expect(state.chatFollowLocked).toBe(false);
    maximum = 1400;

    if (movement === "native end clamp") {
      // Native clamping precedes both viewport observation and JavaScript scroll writes.
      maximum = 760;
      container.scrollTop = maximum;
    } else {
      if (movement === "end-command measurement") {
        maximum = 800;
        expect(transcript.scrollToEnd({ behavior: "auto" })).toBe(true);
        expect(container.scrollTop).toBe(800);
      }
      // Remeasure above the viewport, including while an end command awaits native completion.
      const earlier = requireElement(container, '[data-index="4"]');
      Object.defineProperty(earlier, "offsetHeight", { configurable: true, value: 80 });
      for (const observer of resizeObservers) {
        observer.emitTarget(earlier, 800, 80);
      }
    }
    expect(container.scrollTop).toBe(760);
    container.dispatchEvent(new Event("scroll"));
    await vi.advanceTimersByTimeAsync(0);
    expect.soft(request).not.toHaveBeenCalled();
    expect.soft(state).toMatchObject({ chatFollowLocked: false, chatReadingHistory: false });

    // Unclassified native movement still owns reader intent outside the maintenance target.
    container.scrollTop = 720;
    container.dispatchEvent(new Event("scroll"));
    await vi.advanceTimersByTimeAsync(0);
    expect(request).toHaveBeenCalledExactlyOnceWith("chat.history", {
      sessionKey: state.sessionKey,
      limit: 1000,
      maxBytes: 3 * 1024 * 1024,
      toolResultMaxChars: 2_000,
      offset: 2,
    });
    expect(state).toMatchObject({ chatFollowLocked: true, chatReadingHistory: true });
  },
);
