import { matchesKey, isKeyRelease } from "@oh-my-pi/pi-tui";
import type { EditorTheme } from "@oh-my-pi/pi-tui";
import { CustomEditor } from "@oh-my-pi/pi-tui/prompt/custom-editor";

export interface RosterNavigation {
  available(): boolean;
  move(direction: -1 | 1): void;
  activate(): string | undefined;
  leave(): void;
}

// Use the host's focus callback, not copied transcripts or injected messages.
// The host rewires normal submit, Escape, history and agent focus on installation.
export class RosterEditor extends CustomEditor {
  constructor(theme: EditorTheme, private readonly navigation: RosterNavigation) {
    super(theme);
  }

  override handleInput(data: string): void {
    if (!isKeyRelease(data) && !this.getText() && this.navigation.available()) {
      if (matchesKey(data, "up") || matchesKey(data, "down")) {
        this.navigation.move(matchesKey(data, "up") ? -1 : 1);
        return;
      }
      if (matchesKey(data, "enter") && this.onFocusAgent) {
        const target = this.navigation.activate();
        if (target !== undefined) {
          this.onFocusAgent(target);
          return;
        }
      }
    }
    // Typing or Escape hands control back to the normal editor. Escape retains
    // omp's standard return-to-main behavior when viewing a child session.
    if (!isKeyRelease(data)) this.navigation.leave();
    super.handleInput(data);
  }
}
