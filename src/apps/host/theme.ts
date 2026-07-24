import type { ThemeTokens } from "@hiraya/apps-contracts";
import type { ThemeDefinition } from "../../lib/themes";

export function mapThemeTokens(theme: ThemeDefinition): ThemeTokens {
  const { colors } = theme;
  return {
    mode: isDark(colors.window) ? "dark" : "light",
    background: colors.shell,
    surface: colors.window,
    surfaceElevated: colors.windowMuted,
    text: colors.text,
    textMuted: colors.textMuted,
    border: colors.border,
    accent: colors.accent,
    accentText: colors.accentText,
    danger: colors.danger,
    focus: colors.selection,
  };
}

export class AppThemeService {
  readonly #listeners = new Set<(theme: ThemeTokens) => void>();
  #theme: ThemeTokens;

  constructor(theme: ThemeDefinition | ThemeTokens) {
    this.#theme = "colors" in theme ? mapThemeTokens(theme) : { ...theme };
  }

  async get(): Promise<ThemeTokens> {
    return { ...this.#theme };
  }

  set(theme: ThemeDefinition | ThemeTokens): void {
    this.#theme = "colors" in theme ? mapThemeTokens(theme) : { ...theme };
    for (const listener of this.#listeners) listener({ ...this.#theme });
  }

  subscribe(listener: (theme: ThemeTokens) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}

function isDark(color: string): boolean {
  const channels = [1, 3, 5].map((offset) => Number.parseInt(color.slice(offset, offset + 2), 16) / 255)
    .map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2] < 0.35;
}
