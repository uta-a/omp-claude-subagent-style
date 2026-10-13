import { truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import type { Theme } from "@oh-my-pi/pi-tui";
import { MAIN_AGENT_ID } from "@oh-my-pi/pi-tui/overlays/agent-hub-types";

export interface RosterView {
  selectedId: string;
  viewedId: string;
}

export interface AgentRow {
  id: string;
  agent: string;
  description: string;
  durationMs: number;
  updatedAt: number;
  tokens?: number;
}

// Labels and task summaries are external text, not terminal formatting.
function clean(text: string): string {
  return text.replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, " ").replace(/\s+/g, " ").trim();
}

export function renderRoster(
  rows: Iterable<AgentRow>, totalWidth: number, now: number, theme: Theme,
  view: RosterView = { selectedId: MAIN_AGENT_ID, viewedId: MAIN_AGENT_ID },
): string[] {
  if (totalWidth <= 0) return [];
  const padding = " ".repeat(Math.min(2, Math.floor((totalWidth - 1) / 2)));
  const width = totalWidth - padding.length * 2;
  const agents = [...rows];
  if (!agents.length && view.viewedId === MAIN_AGENT_ID) return [];
  const names = agents.map(row => clean(row.agent));
  const nameWidth = Math.min(24, Math.max(...names.map(visibleWidth)));
  const main = `${view.selectedId === MAIN_AGENT_ID ? "›" : " "} ${view.viewedId === MAIN_AGENT_ID ? "●" : "○"} main`;
  const lines = [truncateToWidth(theme.bold(theme.fg(view.selectedId === MAIN_AGENT_ID ? "accent" : "text", main)), width)];
  for (const [index, row] of agents.entries()) {
    const duration = row.durationMs + Math.max(0, now - row.updatedAt);
    const count = row.tokens;
    const tokens = count === undefined ? "—" : count >= 1000 ? `${(count / 1000).toFixed(1)}k` : `${count}`;
    const stats = `${Math.floor(duration / 1000)}s · ↓ ${tokens} tokens`;
    const symbol = view.viewedId === row.id ? "●" : "○";
    const arrow = view.selectedId === row.id ? "›" : " ";
    const name = truncateToWidth(names[index]!, nameWidth);
    const left = `${arrow} ${symbol} ${name}${" ".repeat(Math.max(0, nameWidth - visibleWidth(name)))}  ${clean(row.description)}`;
    const statsWidth = visibleWidth(stats);
    let line: string;
    if (width >= statsWidth + 6) {
      const leftWidth = width - statsWidth - 2;
      const label = truncateToWidth(left, leftWidth);
      line = `${label}${" ".repeat(width - visibleWidth(label) - statsWidth)}${stats}`;
    } else {
      // On narrow terminals, preserve identity rather than rendering only stats.
      line = truncateToWidth(`${left.trimEnd()}  ${stats}`, width);
    }
    lines.push(theme.fg(view.selectedId === row.id ? "accent" : "muted", line));
  }
  return ["", ...lines.map(line => `${padding}${line}${padding}`), ""];
}
