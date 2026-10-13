import type { Timer } from "bun";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { SubagentLifecyclePayload, SubagentProgressPayload } from "@oh-my-pi/pi-coding-agent/task";
import { MAIN_AGENT_ID } from "@oh-my-pi/pi-tui/overlays/agent-hub-types";
import { RosterEditor } from "./editor";
import { renderRoster, type AgentRow } from "./renderer";

const WIDGET_KEY = "claude-subagent-style";
const LIFECYCLE_CHANNEL = "task:subagent:lifecycle";
const PROGRESS_CHANNEL = "task:subagent:progress";

export default function claudeSubagentStyle(pi: ExtensionAPI): void {
  // Per-factory state: children must never share a parent's UI or selection.
  const rows = new Map<string, AgentRow>();
  const settled = new Set<string>();
  let context: ExtensionContext | undefined;
  let editor: RosterEditor | undefined;
  let timer: Timer | undefined;
  let unsubscribe: Array<() => void> = [];
  let mounted = false;
  let revision = 0;
  let requestRender: (() => void) | undefined;
  let selectedId = MAIN_AGENT_ID;
  let navigating = false;

  function viewedId(): string {
    return editor?.composerState().viewing?.at(-1) ?? MAIN_AGENT_ID;
  }

  function render(): void {
    if (!context) return;
    revision++;
    if (!rows.size && viewedId() === MAIN_AGENT_ID) {
      if (mounted) context.ui.setWidget(WIDGET_KEY, undefined);
      mounted = false;
      requestRender = undefined;
      return;
    }
    if (!mounted) {
      mounted = true;
      context.ui.setWidget(WIDGET_KEY, (tui, theme) => {
        requestRender = () => tui.requestRender();
        let cachedRevision = -1;
        let cachedWidth = -1;
        let cachedView = "";
        let cachedLines: string[] = [];
        return {
          render(width) {
            const viewed = viewedId();
            if (cachedRevision !== revision || cachedWidth !== width || cachedView !== viewed) {
              cachedLines = renderRoster(rows.values(), width, Date.now(), theme, {
                selectedId: navigating ? selectedId : viewed,
                viewedId: viewed,
              });
              cachedRevision = revision;
              cachedWidth = width;
              cachedView = viewed;
            }
            return cachedLines;
          },
          invalidate() { cachedRevision = -1; },
        };
      }, { placement: "belowEditor" });
    }
    requestRender?.();
  }

  function refresh(): void {
    render();
    if (!context) return;
    if (rows.size && timer === undefined) timer = context.setInterval(refresh, 1000);
    if (!rows.size && timer !== undefined) {
      context.clearTimer(timer);
      timer = undefined;
    }
  }

  function remove(id: string): void {
    settled.add(id);
    rows.delete(id);
    if (selectedId === id) selectedId = MAIN_AGENT_ID;
    // A completed/failed/aborted child is no longer a navigation target.
    if (viewedId() === id) editor?.onFocusAgent?.(MAIN_AGENT_ID);
    refresh();
  }

  function lifecycle(event: SubagentLifecyclePayload): void {
    if (event.status !== "started") {
      remove(event.id);
      return;
    }
    settled.delete(event.id);
    rows.set(event.id, {
      id: event.id,
      agent: event.agent,
      description: event.description ?? "",
      durationMs: 0,
      updatedAt: Date.now(),
    });
    refresh();
  }

  function progress(event: SubagentProgressPayload): void {
    const { id, status, durationMs } = event.progress;
    if (status === "pending") return;
    if (status !== "running") {
      remove(id);
      return;
    }
    // Late progress cannot resurrect a finished row. Explicit revival starts a
    // new run via the "started" lifecycle event and clears its tombstone.
    if (settled.has(id)) return;
    const existing = rows.get(id);
    rows.set(id, {
      id,
      agent: event.agent,
      description: event.progress.description || event.progress.lastIntent || existing?.description || event.task || "",
      tokens: event.progress.tokens ?? existing?.tokens,
      durationMs: Math.max(0, durationMs),
      updatedAt: Date.now(),
    });
    refresh();
  }

  function dispose(): void {
    for (const off of unsubscribe) off();
    unsubscribe = [];
    if (timer !== undefined && context) context.clearTimer(timer);
    timer = undefined;
    context?.ui.setWidget(WIDGET_KEY, undefined);
    if (editor) context?.ui.setEditorComponent(undefined);
    editor = undefined;
    context = undefined;
    rows.clear();
    settled.clear();
    selectedId = MAIN_AGENT_ID;
    navigating = false;
    mounted = false;
    requestRender = undefined;
  }

  pi.on("session_start", (_event, ctx) => {
    dispose();
    if (!ctx.hasUI || ctx.agent.kind !== "main") return;
    context = ctx;
    ctx.ui.setEditorComponent((_tui, theme) => {
      editor = new RosterEditor(theme, {
        available: () => rows.size > 0 || viewedId() !== MAIN_AGENT_ID,
        move(direction) {
          const ids = [MAIN_AGENT_ID, ...rows.keys()];
          const current = navigating ? selectedId : viewedId();
          const index = Math.max(0, ids.indexOf(current));
          if (index === 0 && direction === -1) {
            navigating = false;
            render();
            return;
          }
          selectedId = ids[Math.min(index + direction, ids.length - 1)]!;
          navigating = true;
          render();
        },
        activate() {
          if (!navigating) return undefined;
          if (selectedId !== MAIN_AGENT_ID && !rows.has(selectedId)) selectedId = MAIN_AGENT_ID;
          return selectedId;
        },
        leave() {
          if (!navigating) return;
          navigating = false;
          render();
        },
      });
      return editor;
    });
    unsubscribe = [
      pi.events.on(LIFECYCLE_CHANNEL, data => lifecycle(data as SubagentLifecyclePayload)),
      pi.events.on(PROGRESS_CHANNEL, data => progress(data as SubagentProgressPayload)),
    ];
  });

  pi.on("session_shutdown", dispose);
}
