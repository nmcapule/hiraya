export type LinearNavigationKey = "ArrowDown" | "ArrowLeft" | "ArrowRight" | "ArrowUp" | "End" | "Home";

export function linearNavigationIndex(current: number, count: number, key: LinearNavigationKey, orientation: "horizontal" | "vertical" | "both" = "both") {
  if (count <= 0) return -1;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  const previous = key === "ArrowLeft" || key === "ArrowUp";
  const horizontal = key === "ArrowLeft" || key === "ArrowRight";
  if (orientation === "horizontal" && !horizontal || orientation === "vertical" && horizontal) return current;
  return (Math.max(0, current) + (previous ? -1 : 1) + count) % count;
}

export function isLinearNavigationKey(key: string): key is LinearNavigationKey {
  return ["ArrowDown", "ArrowLeft", "ArrowRight", "ArrowUp", "End", "Home"].includes(key);
}

export function visibleMenuItems(container: ParentNode) {
  return Array.from(container.querySelectorAll<HTMLButtonElement>("[role='menuitem']:not(:disabled)"))
    .filter((item) => !item.closest("[hidden]") && item.getAttribute("aria-hidden") !== "true");
}

export function submenuKeyIntent(key: string, location: "trigger" | "submenu") {
  if (location === "trigger" && ["ArrowRight", "Enter", " "].includes(key)) return "open" as const;
  if (location === "submenu" && ["ArrowLeft", "Escape"].includes(key)) return "close" as const;
  return "none" as const;
}
