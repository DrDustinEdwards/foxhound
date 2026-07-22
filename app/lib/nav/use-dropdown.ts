import { useEffect, useRef, useState } from "react";

// Shared open/close + click-outside dropdown state (nav assessment F-2,
// foxhound-nav-assessment.md: "Both dropdowns close on click-outside... the
// two components duplicate identical open/ref/click-outside logic, which is
// also the only real duplication in the system... worth a shared useDropdown
// hook when touched next"). TASK-foxhound-marketing-header-v2.md adds a
// third near-identical dropdown (the marketing header's section pill),
// crossing that threshold; extracted here and adopted by all three call
// sites (ProductSwitcher, GearMenu, SectionPill).
export function useDropdown<T extends HTMLElement = HTMLDivElement>() {
  const [open, setOpen] = useState(false);
  const ref = useRef<T>(null);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  return { open, setOpen, ref };
}
