import type { CSSProperties } from "react";

export const BUILTIN_THEME_IDS = ["hiraya-dusk", "warm-paper", "midnight-glass", "high-contrast"] as const;
export type BuiltinThemeId = typeof BUILTIN_THEME_IDS[number];
export type ThemeFontFamily = "humanist" | "system" | "mono";

export type ThemeColors = {
  shell: string;
  chrome: string;
  chromeText: string;
  window: string;
  windowMuted: string;
  text: string;
  textMuted: string;
  accent: string;
  accentText: string;
  border: string;
  danger: string;
  dangerSurface: string;
  desktopText: string;
  selection: string;
  editorBackground: string;
  editorText: string;
  editorGutter: string;
  editorKeyword: string;
  editorString: string;
  editorComment: string;
};

export type ThemeDefinition = {
  colors: ThemeColors;
  shape: { radius: number; borderWidth: number };
  effects: { blur: number; opacity: number; shadow: number };
  typography: { family: ThemeFontFamily; scale: number; weight: number };
  density: number;
  motion: number;
  iconSize: number;
};

export type CustomTheme = { id: string; name: string; definition: ThemeDefinition };
export type ThemeState = { selectedThemeId: string; customThemes: CustomTheme[] };

export const DEFAULT_THEME_ID: BuiltinThemeId = "hiraya-dusk";
export const DEFAULT_THEME_STATE: ThemeState = { selectedThemeId: DEFAULT_THEME_ID, customThemes: [] };
export const MAX_CUSTOM_THEMES = 24;
const COLOR_KEYS: Array<keyof ThemeColors> = [
  "shell", "chrome", "chromeText", "window", "windowMuted", "text", "textMuted", "accent", "accentText", "border",
  "danger", "dangerSurface", "desktopText", "selection", "editorBackground", "editorText", "editorGutter", "editorKeyword",
  "editorString", "editorComment",
];
const HEX_COLOR = /^#[\da-f]{6}$/i;

const duskColors: ThemeColors = {
  shell: "#25383d", chrome: "#141c1f", chromeText: "#f4f6f1", window: "#f2f1eb", windowMuted: "#e4e4dd",
  text: "#192229", textMuted: "#666f6c", accent: "#e7b964", accentText: "#20261f", border: "#c6c9c1",
  danger: "#983c34", dangerSurface: "#f3dfdc", desktopText: "#ffffff", selection: "#b88936",
  editorBackground: "#f8f7f2", editorText: "#27302d", editorGutter: "#e8e8e1", editorKeyword: "#875d18",
  editorString: "#47735d", editorComment: "#78817c",
};

export const BUILTIN_THEMES: Record<BuiltinThemeId, { name: string; description: string; definition: ThemeDefinition }> = {
  "hiraya-dusk": {
    name: "Hiraya Dusk",
    description: "The original warm, misty desktop.",
    definition: {
      colors: duskColors,
      shape: { radius: 14, borderWidth: 1 }, effects: { blur: 22, opacity: 0.9, shadow: 0.55 },
      typography: { family: "humanist", scale: 1, weight: 600 }, density: 1, motion: 1, iconSize: 60,
    },
  },
  "warm-paper": {
    name: "Warm Paper",
    description: "Tactile cream surfaces with restrained depth.",
    definition: {
      colors: {
        shell: "#534b3f", chrome: "#eee5d5", chromeText: "#332f29", window: "#fffaf0", windowMuted: "#eee4d2",
        text: "#302d28", textMuted: "#726a5f", accent: "#a65f36", accentText: "#fffaf0", border: "#c9bba5",
        danger: "#9b3f35", dangerSurface: "#f6dfd8", desktopText: "#fffdf7", selection: "#bc7449",
        editorBackground: "#fffdf7", editorText: "#342f29", editorGutter: "#f0e6d7", editorKeyword: "#9a4f2d",
        editorString: "#557348", editorComment: "#8a7d6d",
      },
      shape: { radius: 9, borderWidth: 1 }, effects: { blur: 4, opacity: 0.98, shadow: 0.3 },
      typography: { family: "humanist", scale: 1.02, weight: 600 }, density: 1.05, motion: 0.85, iconSize: 60,
    },
  },
  "midnight-glass": {
    name: "Midnight Glass",
    description: "Cool translucent chrome for low-light work.",
    definition: {
      colors: {
        shell: "#101820", chrome: "#111a25", chromeText: "#eef5ff", window: "#17222d", windowMuted: "#202e3b",
        text: "#edf4fa", textMuted: "#a7b4c0", accent: "#79b8d8", accentText: "#101820", border: "#405264",
        danger: "#ff9a90", dangerSurface: "#472c31", desktopText: "#f2f8ff", selection: "#5fa9cf",
        editorBackground: "#111a22", editorText: "#dce8ef", editorGutter: "#182530", editorKeyword: "#88c7ff",
        editorString: "#a8d99c", editorComment: "#7f94a2",
      },
      shape: { radius: 18, borderWidth: 1 }, effects: { blur: 28, opacity: 0.82, shadow: 0.8 },
      typography: { family: "system", scale: 1, weight: 550 }, density: 0.95, motion: 1.15, iconSize: 58,
    },
  },
  "high-contrast": {
    name: "High Contrast",
    description: "Strong boundaries and maximum legibility.",
    definition: {
      colors: {
        shell: "#000000", chrome: "#000000", chromeText: "#ffffff", window: "#ffffff", windowMuted: "#eeeeee",
        text: "#000000", textMuted: "#333333", accent: "#ffd400", accentText: "#000000", border: "#000000",
        danger: "#8c0000", dangerSurface: "#ffe1e1", desktopText: "#ffffff", selection: "#005fcc",
        editorBackground: "#ffffff", editorText: "#000000", editorGutter: "#eeeeee", editorKeyword: "#0033aa",
        editorString: "#006b2d", editorComment: "#444444",
      },
      shape: { radius: 3, borderWidth: 2 }, effects: { blur: 0, opacity: 1, shadow: 0 },
      typography: { family: "system", scale: 1.08, weight: 700 }, density: 1.08, motion: 0.35, iconSize: 64,
    },
  },
};

export function isBuiltinThemeId(value: string): value is BuiltinThemeId {
  return (BUILTIN_THEME_IDS as readonly string[]).includes(value);
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("The theme has an unsupported format.");
  return value as Record<string, unknown>;
}

function containsControl(value: string) {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 32 || codePoint === 127;
  });
}

function containsUnicodeControl(value: string) {
  return /\p{Cc}/u.test(value);
}

function relativeLuminance(color: string) {
  const channels = [1, 3, 5].map((offset) => Number.parseInt(color.slice(offset, offset + 2), 16) / 255)
    .map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrastRatio(foreground: string, background: string) {
  const first = relativeLuminance(foreground);
  const second = relativeLuminance(background);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

export function themeContrastIssues(definition: ThemeDefinition) {
  const { colors } = definition;
  return [
    ["window text", colors.text, colors.window],
    ["chrome text", colors.chromeText, colors.chrome],
    ["accent text", colors.accentText, colors.accent],
    ["editor text", colors.editorText, colors.editorBackground],
  ].filter(([, foreground, background]) => contrastRatio(foreground, background) < 4.5).map(([label]) => label);
}

function boundedNumber(value: unknown, min: number, max: number, integer = false) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max || integer && !Number.isInteger(value)) {
    throw new Error("The theme has an unsupported value.");
  }
  return value;
}

export function parseThemeDefinition(value: unknown): ThemeDefinition {
  const candidate = record(value);
  const colorValues = record(candidate.colors);
  const colors = Object.fromEntries(COLOR_KEYS.map((key) => {
    const color = colorValues[key];
    if (typeof color !== "string" || !HEX_COLOR.test(color)) throw new Error("The theme contains an invalid color.");
    return [key, color.toLowerCase()];
  })) as ThemeColors;
  const shape = record(candidate.shape);
  const effects = record(candidate.effects);
  const typography = record(candidate.typography);
  if (typography.family !== "humanist" && typography.family !== "system" && typography.family !== "mono") {
    throw new Error("The theme contains an invalid font family.");
  }
  return {
    colors,
    shape: { radius: boundedNumber(shape.radius, 0, 24), borderWidth: boundedNumber(shape.borderWidth, 0, 2) },
    effects: {
      blur: boundedNumber(effects.blur, 0, 30),
      opacity: boundedNumber(effects.opacity, 0.65, 1),
      shadow: boundedNumber(effects.shadow, 0, 1),
    },
    typography: {
      family: typography.family,
      scale: boundedNumber(typography.scale, 0.85, 1.2),
      weight: boundedNumber(typography.weight, 400, 700, true),
    },
    density: boundedNumber(candidate.density, 0.8, 1.2),
    motion: boundedNumber(candidate.motion, 0, 1.5),
    iconSize: boundedNumber(candidate.iconSize, 48, 72, true),
  };
}

export function parseCustomTheme(value: unknown): CustomTheme {
  const candidate = record(value);
  if (typeof candidate.id !== "string" || !candidate.id || candidate.id === "." || candidate.id === ".." || new TextEncoder().encode(candidate.id).byteLength > 180 || isBuiltinThemeId(candidate.id) || candidate.id.includes("/") || candidate.id.includes("\\") || containsControl(candidate.id)) {
    throw new Error("The custom theme has an invalid ID.");
  }
  if (typeof candidate.name !== "string" || candidate.name.trim() !== candidate.name || !candidate.name || [...candidate.name].length > 60 || containsUnicodeControl(candidate.name)) {
    throw new Error("The custom theme has an invalid name.");
  }
  const definition = parseThemeDefinition(candidate.definition);
  if (themeContrastIssues(definition).length) throw new Error("The custom theme does not provide sufficient text contrast.");
  return { id: candidate.id, name: candidate.name, definition };
}

export function parseThemeState(value: unknown): ThemeState {
  const candidate = record(value);
  if (typeof candidate.selectedThemeId !== "string" || !Array.isArray(candidate.customThemes) || candidate.customThemes.length > MAX_CUSTOM_THEMES) {
    throw new Error("The workspace themes have an unsupported format.");
  }
  const customThemes = candidate.customThemes.map(parseCustomTheme);
  const ids = new Set<string>();
  for (const theme of customThemes) {
    if (ids.has(theme.id)) throw new Error("The workspace contains duplicate custom theme IDs.");
    ids.add(theme.id);
  }
  if (!isBuiltinThemeId(candidate.selectedThemeId) && !ids.has(candidate.selectedThemeId)) {
    throw new Error("The selected custom theme does not exist.");
  }
  return { selectedThemeId: candidate.selectedThemeId, customThemes };
}

export function resolveTheme(state: ThemeState) {
  if (isBuiltinThemeId(state.selectedThemeId)) return BUILTIN_THEMES[state.selectedThemeId].definition;
  return state.customThemes.find((theme) => theme.id === state.selectedThemeId)?.definition ?? BUILTIN_THEMES[DEFAULT_THEME_ID].definition;
}

export function themeName(state: ThemeState, id: string) {
  if (isBuiltinThemeId(id)) return BUILTIN_THEMES[id].name;
  return state.customThemes.find((theme) => theme.id === id)?.name ?? "Hiraya Dusk";
}

const FONT_STACKS: Record<ThemeFontFamily, string> = {
  humanist: '"Avenir Next", "Segoe UI", ui-sans-serif, system-ui, sans-serif',
  system: 'system-ui, -apple-system, "Segoe UI", sans-serif',
  mono: 'ui-monospace, "SFMono-Regular", Consolas, "Liberation Mono", monospace',
};

function hexToRgb(hex: string) {
  return `${Number.parseInt(hex.slice(1, 3), 16)} ${Number.parseInt(hex.slice(3, 5), 16)} ${Number.parseInt(hex.slice(5, 7), 16)}`;
}

export function themeStyle(definition: ThemeDefinition): CSSProperties {
  const { colors, shape, effects, typography, density, motion, iconSize } = definition;
  const iconFootprintWidth = Math.round(iconSize + 38);
  const iconFootprintHeight = Math.round(iconSize + 42);
  return {
    "--theme-shell": colors.shell,
    "--theme-chrome": colors.chrome,
    "--theme-chrome-rgb": hexToRgb(colors.chrome),
    "--theme-chrome-text": colors.chromeText,
    "--theme-window": colors.window,
    "--theme-window-rgb": hexToRgb(colors.window),
    "--theme-window-muted": colors.windowMuted,
    "--theme-text": colors.text,
    "--theme-text-muted": colors.textMuted,
    "--theme-accent": colors.accent,
    "--theme-accent-rgb": hexToRgb(colors.accent),
    "--theme-accent-text": colors.accentText,
    "--theme-border": colors.border,
    "--theme-danger": colors.danger,
    "--theme-danger-surface": colors.dangerSurface,
    "--theme-desktop-text": colors.desktopText,
    "--theme-selection": colors.selection,
    "--theme-selection-rgb": hexToRgb(colors.selection),
    "--theme-editor-bg": colors.editorBackground,
    "--theme-editor-text": colors.editorText,
    "--theme-editor-gutter": colors.editorGutter,
    "--theme-editor-keyword": colors.editorKeyword,
    "--theme-editor-string": colors.editorString,
    "--theme-editor-comment": colors.editorComment,
    "--theme-radius": `${shape.radius}px`,
    "--theme-radius-small": `${Math.max(2, Math.round(shape.radius * 0.62))}px`,
    "--theme-border-width": `${shape.borderWidth}px`,
    "--theme-blur": `${effects.blur}px`,
    "--theme-opacity": effects.opacity,
    "--theme-shadow-strength": effects.shadow,
    "--theme-font": FONT_STACKS[typography.family],
    "--theme-type-scale": typography.scale,
    "--theme-weight": typography.weight,
    "--theme-density": density,
    "--theme-motion": motion,
    "--theme-icon-size": `${iconSize}px`,
    "--theme-icon-footprint-width": `${iconFootprintWidth}px`,
    "--theme-icon-footprint-height": `${iconFootprintHeight}px`,
  } as CSSProperties;
}

export type DesktopIconMetrics = { width: number; height: number; stepX: number; stepY: number };

export function themeIconMetrics(definition: ThemeDefinition): DesktopIconMetrics {
  const width = Math.round(definition.iconSize + 38);
  const height = Math.round(definition.iconSize + 42);
  return { width, height, stepX: width + 6, stepY: height + 10 };
}
