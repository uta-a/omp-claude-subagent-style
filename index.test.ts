import { afterEach, expect, test, spyOn } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { Component, EditorTheme, Theme, TUI } from "@oh-my-pi/pi-tui";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import { getEditorTheme } from "@oh-my-pi/pi-tui/theme";
import { MAIN_AGENT_ID } from "@oh-my-pi/pi-tui/overlays/agent-hub-types";
import type { RosterEditor } from "./editor";
import extension from "./index";
import { renderRoster, type AgentRow } from "./renderer";

const clocks: Array<{ mockRestore(): void }> = [];
afterEach(() => { for (const clock of clocks.splice(0)) clock.mockRestore(); });
// Plain styling exposes displayed values without ANSI escape sequences.
const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as unknown as Theme;

function host(hasUI = true, kind = "main") {
  let now = 0;
  clocks.push(spyOn(Date, "now").mockImplementation(() => now));
  const hooks = new Map<string, (event: unknown, ctx: unknown) => void>();
  const channels = new Map<string, Set<(data: unknown) => void>>();
  const timers = new Map<number, { tick: () => void; due: number; interval: number }>();
  const submissions: string[] = [];
  const notices: string[] = [];
  let nextTimer = 0;
  let component: Component | undefined;
  let editor: RosterEditor | undefined;
  let viewed = MAIN_AGENT_ID;
  // Partial host: the extension only asks this TUI to repaint.
  const tui = { requestRender() {} } as unknown as TUI;
  const ctx = {
    hasUI, agent: { kind },
    ui: {
      notify(message: string) { notices.push(message); },
      setWidget: (_key: string, factory: ((tui: TUI, theme: Theme) => Component) | undefined) => {
        component = factory?.(tui, theme);
      },
      setEditorComponent: (factory: ((tui: TUI, theme: EditorTheme) => RosterEditor) | undefined) => {
        editor = factory?.(tui, getEditorTheme());
        if (!editor) return;
        editor.composerState = () => ({ running: false, viewing: viewed === MAIN_AGENT_ID ? undefined : [viewed] });
        editor.onFocusAgent = id => { viewed = id; };
        editor.onSubmit = text => { submissions.push(text); };
      },
    },
    setInterval: (tick: () => void, ms: number) => {
      const id = ++nextTimer;
      timers.set(id, { tick, due: now + ms, interval: ms });
      return id;
    },
    clearTimer: (id: number) => { timers.delete(id); },
  };
  // Only the event registration surface is needed by the factory.
  const api = {
    on: (name: string, handler: (event: unknown, ctx: unknown) => void) => { hooks.set(name, handler); },
    events: {
      on: (name: string, handler: (data: unknown) => void) => {
        let listeners = channels.get(name);
        if (!listeners) channels.set(name, listeners = new Set());
        listeners.add(handler);
        return () => { listeners.delete(handler); };
      },
    },
  } as unknown as ExtensionAPI;
  extension(api);
  // The partial context covers only the methods exercised by these scenarios.
  const context = ctx as unknown as ExtensionContext;
  const hook = (name: string) => hooks.get(name)?.({}, context);
  const emit = (name: string, data: unknown) => {
    for (const handler of channels.get(`task:subagent:${name}`) ?? []) handler(data);
  };
  hook("session_start");
  return {
    hook, emit, submissions,
    key: (data: string) => { editor?.handleInput(data); },
    draft: (text: string) => { editor?.setText(text); },
    advance(ms: number) {
      const target = now + ms;
      while (true) {
        let nextId: number | undefined;
        let due = Infinity;
        for (const [id, timer] of timers) {
          if (timer.due <= target && timer.due < due) {
            nextId = id;
            due = timer.due;
          }
        }
        if (nextId === undefined) break;
        const timer = timers.get(nextId)!;
        now = timer.due;
        timer.due += timer.interval;
        timer.tick();
      }
      now = target;
    },
    get lines() { return component?.render(90).filter(line => line.trim()).map(line => line.trimEnd()); },
    get seconds() { return component?.render(90).filter(line => /\d+s ·/.test(line)).map(line => Number(line.match(/(\d+)s ·/)?.[1])); },
    get timerCount() { return timers.size; },
    get viewed() { return viewed; },
    get text() { return editor?.getText(); },
    notices,
  };
}

const DOWN = "\x1b[B";
const UP = "\x1b[A";
const ENTER = "\r";

test("each finished agent disappears immediately without waiting for user input", () => {
  const h = host();
  h.emit("lifecycle", { id: "A", agent: "review", status: "started" });
  h.advance(10_000);
  h.emit("lifecycle", { id: "B", agent: "test-runner", status: "started" });
  h.advance(2_000);
  expect(h.seconds).toEqual([12, 2]);
  h.emit("lifecycle", { id: "B", agent: "test-runner", status: "completed" });
  expect(h.seconds).toEqual([12]);
  h.advance(5_000);
  expect(h.seconds).toEqual([17]);
  h.emit("lifecycle", { id: "A", agent: "review", status: "completed" });
  expect(h.lines).toBeUndefined();
  expect(h.timerCount).toBe(0);
});

test("terminal progress removes rows; late running frames stay hidden until explicit revival", () => {
  const h = host();
  h.emit("lifecycle", { id: "A", agent: "implementer", status: "started" });
  h.emit("progress", { agent: "implementer", progress: { id: "A", status: "running", durationMs: 66000, description: "日本語の実装作業", tokens: 4300 } });
  expect(h.seconds).toEqual([66]);
  expect(h.lines?.[1]).toContain("日本語の実装作業");
  expect(h.lines?.[1]).toEndWith("↓ 4.3k tokens");
  h.emit("progress", { agent: "implementer", progress: { id: "A", status: "completed", durationMs: 66900 } });
  h.emit("lifecycle", { id: "A", agent: "implementer", status: "completed" });
  h.emit("progress", { agent: "implementer", progress: { id: "A", status: "running", durationMs: 10 } });
  expect(h.lines).toBeUndefined();
  h.emit("lifecycle", { id: "A", agent: "implementer", status: "started" });
  h.advance(2000);
  expect(h.seconds).toEqual([2]);
  expect(h.lines?.[1]).toEndWith("↓ — tokens");
});

test("same-type agents are distinct and failed or aborted instances disappear independently", () => {
  const h = host();
  h.emit("lifecycle", { id: "A", agent: "review", status: "started" });
  h.advance(1000);
  h.emit("lifecycle", { id: "B", agent: "review", status: "started" });
  h.advance(1000);
  h.emit("lifecycle", { id: "A", agent: "review", status: "failed" });
  expect(h.seconds).toEqual([1]);
  h.emit("lifecycle", { id: "B", agent: "review", status: "aborted" });
  expect(h.lines).toBeUndefined();
});

test("arrow selection does not change the viewed session until Enter; main restores the view", () => {
  const h = host();
  h.emit("lifecycle", { id: "A", agent: "review", status: "started" });
  h.emit("lifecycle", { id: "B", agent: "review", status: "started" });
  h.key(DOWN);
  expect(h.viewed).toBe(MAIN_AGENT_ID);
  expect(h.lines?.[1]?.trimStart()).toStartWith("› ○");
  h.key(ENTER);
  expect(h.viewed).toBe("A");
  expect(h.lines?.[1]?.trimStart()).toStartWith("› ●");
  h.key(DOWN);
  h.key(ENTER);
  expect(h.viewed).toBe("B");
  // Repeated Down at the final row must not wrap to main.
  h.key(DOWN);
  h.key(ENTER);
  expect(h.viewed).toBe("B");
  h.key(UP);
  h.key(UP);
  h.key(ENTER);
  expect(h.viewed).toBe(MAIN_AGENT_ID);
  expect(h.submissions).toEqual([]);
});

test("Up from main returns to the prompt without selecting a child or consuming Enter", () => {
  const h = host();
  h.emit("lifecycle", { id: "A", agent: "review", status: "started" });
  h.key(DOWN);
  h.key(UP);
  h.key(UP);
  h.key(ENTER);
  expect(h.viewed).toBe(MAIN_AGENT_ID);
  expect(h.submissions).toEqual([""]);
  h.key("hello");
  h.key(ENTER);
  expect(h.submissions).toEqual(["", "hello"]);
});

test("finishing the selected/viewed agent returns to main without selecting a different child", () => {
  const h = host();
  h.emit("lifecycle", { id: "A", agent: "review", status: "started" });
  h.emit("lifecycle", { id: "B", agent: "review", status: "started" });
  h.key(DOWN);
  h.key(ENTER);
  h.emit("lifecycle", { id: "A", agent: "review", status: "completed" });
  expect(h.viewed).toBe(MAIN_AGENT_ID);
  h.key(ENTER);
  expect(h.viewed).toBe(MAIN_AGENT_ID);
  expect(h.lines?.[1]).toContain("review");
  h.emit("lifecycle", { id: "B", agent: "review", status: "completed" });
  expect(h.lines).toBeUndefined();
});

test("draft arrows and Enter retain normal editing and submission rather than switching agents", () => {
  const h = host();
  h.emit("lifecycle", { id: "A", agent: "review", status: "started" });
  h.key(DOWN);
  h.draft("hello");
  h.key(UP);
  h.key(ENTER);
  expect(h.submissions).toEqual(["hello"]);
  expect(h.viewed).toBe(MAIN_AGENT_ID);
  h.key(DOWN);
  h.key("x");
  expect(h.text).toBe("x");
  h.key(ENTER);
  expect(h.submissions).toEqual(["hello", "x"]);
  expect(h.viewed).toBe(MAIN_AGENT_ID);
});

test("session restart and shutdown clear rows, timers, editor and event subscriptions", () => {
  const h = host();
  h.emit("lifecycle", { id: "A", agent: "review", status: "started" });
  h.key(DOWN);
  h.hook("session_start");
  expect(h.lines).toBeUndefined();
  expect(h.timerCount).toBe(0);
  h.emit("lifecycle", { id: "B", agent: "implementer", status: "started" });
  h.key(DOWN);
  h.key(ENTER);
  expect(h.viewed).toBe("B");
  h.hook("session_shutdown");
  h.advance(5000);
  h.emit("lifecycle", { id: "C", agent: "test-runner", status: "started" });
  expect(h.lines).toBeUndefined();
  expect(h.timerCount).toBe(0);
  expect(h.text).toBeUndefined();
});

test("headless and child sessions do not create widgets or replace the editor", () => {
  for (const h of [host(false), host(true, "sub")]) {
    h.emit("lifecycle", { id: "A", agent: "review", status: "started" });
    h.advance(1000);
    expect(h.lines).toBeUndefined();
    expect(h.timerCount).toBe(0);
    expect(h.text).toBeUndefined();
  }
});

test("resizing bounds Japanese, emoji and controls while preserving right-aligned statistics", () => {
  const row: AgentRow = { id: "A", agent: "ensemble:explore", description: "ホーム直下の構成確認 🔍".repeat(20), tokens: 4300, durationMs: 12000, updatedAt: 0 };
  for (const width of [0, 1, 12, 30, 80, 120]) {
    const lines = renderRoster([row], width, 0, theme);
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    if (width >= 30) {
      const statsLine = lines.find(line => line.includes("12s ·"))!;
      expect(statsLine.trimEnd()).toEndWith("12s · ↓ 4.3k tokens");
      expect(visibleWidth(statsLine)).toBe(width);
    }
  }
  row.description = "bad\nline\t\x1b[31m";
  const line = renderRoster([row], 80, 0, theme).find(line => line.includes("bad"))!;
  expect(line).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
});

test("terminal events leave completion output to omp while removing rows and restoring main", () => {
  const h = host();
  h.emit("lifecycle", { id: "A", agent: "review", status: "started" });
  h.emit("lifecycle", { id: "B", agent: "scout", status: "started" });
  h.key(DOWN);
  h.key(ENTER);
  h.emit("progress", { agent: "review", progress: { id: "A", status: "completed", durationMs: 8000 } });
  h.emit("lifecycle", { id: "A", agent: "review", status: "completed" });
  expect(h.viewed).toBe(MAIN_AGENT_ID);
  expect(h.seconds).toEqual([0]);
  h.emit("lifecycle", { id: "B", agent: "scout", status: "failed" });
  h.advance(1000);
  expect(h.lines).toBeUndefined();
  expect(h.timerCount).toBe(0);
  expect(h.notices).toEqual([]);
  expect(h.submissions).toEqual([]);
});
