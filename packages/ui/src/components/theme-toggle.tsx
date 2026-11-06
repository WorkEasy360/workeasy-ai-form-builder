"use client";

import { useSyncExternalStore } from "react";
import { THEME_STORAGE_KEY } from "../tokens";
import { MoonIcon, SunIcon } from "./icons";

type Theme = "light" | "dark";

function currentTheme(): Theme {
  const pinned = document.documentElement.getAttribute("data-theme");
  if (pinned === "light" || pinned === "dark") return pinned;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** Re-renders when the pinned theme or the OS preference changes. */
function subscribe(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  media.addEventListener("change", onChange);
  return () => {
    observer.disconnect();
    media.removeEventListener("change", onChange);
  };
}

/**
 * Switches between light and dark and remembers the choice in this browser.
 * Until someone chooses, the operating system's preference applies.
 */
export function ThemeToggle({ className = "c-btn c-btn-ghost c-btn-icon" }: { className?: string }) {
  // Unknown on the server; the icon settles on the first client render.
  const theme = useSyncExternalStore<Theme | undefined>(subscribe, currentTheme, () => undefined);

  function toggle() {
    const next: Theme = currentTheme() === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Storage can be unavailable (private windows); the choice then lasts for this page only.
    }
  }

  const label = theme === "dark" ? "Switch to light theme" : "Switch to dark theme";
  return (
    <button type="button" className={className} onClick={toggle} aria-label={label} title={label}>
      {theme === "dark" ? <SunIcon /> : <MoonIcon />}
    </button>
  );
}
