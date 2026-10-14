import { useEffect } from "react";

// `[` collapses or expands the shell's menu. Capsomer's AdminShell shows the
// key on its collapse control and leaves binding it to the app, because a
// single-key shortcut is the app's setting. It presses that control, so the
// shell's own state and its memory of the choice stay the one source. Never
// while a person types, and never with a modifier held.
export function useCollapseKey(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "[" || e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented || e.isComposing) return;
      const target = e.target as HTMLElement | null;
      if (target?.isContentEditable || target?.closest?.("input, textarea, select")) return;
      const toggle = document.querySelector<HTMLButtonElement>(".cap-admin-collapse");
      if (!toggle || toggle.getClientRects().length === 0) return;
      e.preventDefault();
      toggle.click();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
}
