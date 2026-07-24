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
  text: "#192229", textMuted: "#59625f", accent: "#e7b964", accentText: "#20261f", border: "#c6c9c1",
  danger: "#983c34", dangerSurface: "#f3dfdc", desktopText: "#ffffff", selection: "#96651d",
  editorBackground: "#f8f7f2", editorText: "#27302d", editorGutter: "#e8e8e1", editorKeyword: "#875d18",
  editorString: "#47735d", editorComment: "#606964",
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
        text: "#302d28", textMuted: "#665e54", accent: "#a65f36", accentText: "#fffaf0", border: "#c9bba5",
        danger: "#9b3f35", dangerSurface: "#f6dfd8", desktopText: "#fffdf7", selection: "#bc7449",
        editorBackground: "#fffdf7", editorText: "#342f29", editorGutter: "#f0e6d7", editorKeyword: "#9a4f2d",
        editorString: "#557348", editorComment: "#706354",
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

export function themeContrastRatio(foreground: string, background: string) {
  const first = relativeLuminance(foreground);
  const second = relativeLuminance(background);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

function colorChannels(color: string) {
  return [1, 3, 5].map((offset) => Number.parseInt(color.slice(offset, offset + 2), 16));
}

export function mixThemeColors(foreground: string, background: string, foregroundRatio: number) {
  const first = colorChannels(foreground);
  const second = colorChannels(background);
  return `#${first.map((channel, index) => Math.round(channel * foregroundRatio + second[index] * (1 - foregroundRatio)).toString(16).padStart(2, "0")).join("")}`;
}

export type ThemeSemanticRoles = {
  chrome: string;
  chromeForeground: string;
  window: string;
  windowMuted: string;
  elevated: string;
  foreground: string;
  mutedForeground: string;
  accentFill: string;
  accentForeground: string;
  accentOnWindow: string;
  accentOnChrome: string;
  accentSurface: string;
  dangerFill: string;
  dangerForeground: string;
  dangerSurface: string;
  dangerSurfaceForeground: string;
  status: string;
  statusForeground: string;
  statusSurface: string;
  readOnlyForeground: string;
  readOnlySurface: string;
  focusWindow: string;
  focusMuted: string;
  focusChrome: string;
};

function strongestContrast(background: string, candidates: readonly string[]) {
  return candidates.reduce((best, candidate) => themeContrastRatio(candidate, background) > themeContrastRatio(best, background) ? candidate : best);
}

function strongestMinimumContrast(backgrounds: readonly string[], candidates: readonly string[]) {
  const minimum = (candidate: string) => Math.min(...backgrounds.map((background) => themeContrastRatio(candidate, background)));
  return candidates.reduce((best, candidate) => minimum(candidate) > minimum(best) ? candidate : best);
}

/** Derives rendered roles without extending the persisted version-1 theme schema. */
export function themeSemanticRoles(definition: ThemeDefinition): ThemeSemanticRoles {
  const { colors } = definition;
  const windowCandidates = [colors.accent, colors.selection, colors.text, colors.chromeText];
  const chromeCandidates = [colors.accent, colors.selection, colors.chromeText, colors.text];
  const minimumWindow = mixThemeColors(colors.window, colors.shell, 0.65);
  const minimumMuted = mixThemeColors(colors.windowMuted, colors.shell, 0.65);
  const minimumChrome = mixThemeColors(colors.chrome, colors.shell, 0.65);
  const accentOnWindow = strongestMinimumContrast([colors.window, minimumWindow], windowCandidates);
  const accentOnChrome = strongestMinimumContrast([colors.chrome, minimumChrome], chromeCandidates);
  const accentSurface = mixThemeColors(accentOnWindow, colors.window, 0.1);
  const status = strongestMinimumContrast([colors.window, minimumWindow], [colors.accent, colors.selection, colors.text, colors.chromeText]);
  const statusSurface = mixThemeColors(status, colors.window, 0.12);
  const readOnlySurface = mixThemeColors(accentOnChrome, colors.chrome, 0.12);
  return {
    chrome: colors.chrome,
    chromeForeground: colors.chromeText,
    window: colors.window,
    windowMuted: colors.windowMuted,
    elevated: colors.window,
    foreground: colors.text,
    mutedForeground: colors.textMuted,
    accentFill: colors.accent,
    accentForeground: colors.accentText,
    accentOnWindow,
    accentOnChrome,
    accentSurface,
    dangerFill: colors.danger,
    dangerForeground: strongestContrast(colors.danger, [colors.accentText, colors.chromeText, colors.text]),
    dangerSurface: colors.dangerSurface,
    dangerSurfaceForeground: strongestContrast(colors.dangerSurface, [colors.danger, colors.text, colors.chromeText]),
    status,
    statusForeground: strongestContrast(statusSurface, [status, colors.text, colors.chromeText]),
    statusSurface,
    readOnlyForeground: strongestContrast(readOnlySurface, [accentOnChrome, colors.chromeText, colors.text]),
    readOnlySurface,
    focusWindow: strongestMinimumContrast([colors.window, minimumWindow], windowCandidates),
    focusMuted: strongestMinimumContrast([colors.windowMuted, minimumMuted], windowCandidates),
    focusChrome: strongestMinimumContrast([colors.chrome, minimumChrome], chromeCandidates),
  };
}

export type ThemeContrastCheck = { label: string; foreground: string; background: string; ratio: number; minimum: 3 | 4.5 };

export function themeContrastChecks(definition: ThemeDefinition): ThemeContrastCheck[] {
  const { colors } = definition;
  const roles = themeSemanticRoles(definition);
  const minimumWindow = mixThemeColors(colors.window, colors.shell, 0.65);
  const minimumMuted = mixThemeColors(colors.windowMuted, colors.shell, 0.65);
  const minimumChrome = mixThemeColors(colors.chrome, colors.shell, 0.65);
  const selectedSurface = mixThemeColors(colors.selection, colors.window, 0.23);
  const hoverSurface = mixThemeColors(colors.accent, colors.window, 0.13);
  const subtleChromeSurface = mixThemeColors(colors.chromeText, colors.chrome, 0.09);
  const textPairs: Array<[string, string, string]> = [
    ["text / window", roles.foreground, roles.window],
    ["text / minimum-opacity window", roles.foreground, minimumWindow],
    ["text / window muted", roles.foreground, roles.windowMuted],
    ["text / minimum-opacity window muted", roles.foreground, minimumMuted],
    ["muted text / window", roles.mutedForeground, roles.window],
    ["muted text / window muted", roles.mutedForeground, roles.windowMuted],
    ["text / blended selection", roles.foreground, selectedSurface],
    ["text / blended hover", roles.foreground, hoverSurface],
    ["text / chrome", roles.chromeForeground, roles.chrome],
    ["text / minimum-opacity chrome", roles.chromeForeground, minimumChrome],
    ["text / blended chrome control", roles.chromeForeground, subtleChromeSurface],
    ["accent foreground / accent fill", roles.accentForeground, roles.accentFill],
    ["accent badge text / blended surface", roles.accentOnWindow, roles.accentSurface],
    ["status badge text / blended surface", roles.statusForeground, roles.statusSurface],
    ["read-only badge text / blended chrome", roles.readOnlyForeground, roles.readOnlySurface],
    ["danger foreground / danger fill", roles.dangerForeground, roles.dangerFill],
    ["danger text / danger surface", roles.dangerSurfaceForeground, roles.dangerSurface],
    ["disabled text / public surface", roles.mutedForeground, roles.elevated],
    ["editor text", colors.editorText, colors.editorBackground],
    ["editor comment", colors.editorComment, colors.editorBackground],
    ["editor gutter text", colors.editorComment, colors.editorGutter],
    ["editor keyword", colors.editorKeyword, colors.editorBackground],
    ["editor string", colors.editorString, colors.editorBackground],
  ];
  const indicatorPairs: Array<[string, string, string]> = [
    ["accent indicator / window", roles.accentOnWindow, roles.window],
    ["accent indicator / minimum-opacity window", roles.accentOnWindow, minimumWindow],
    ["accent indicator / chrome", roles.accentOnChrome, roles.chrome],
    ["accent indicator / minimum-opacity chrome", roles.accentOnChrome, minimumChrome],
    ["focus / window", roles.focusWindow, roles.window],
    ["focus / minimum-opacity window", roles.focusWindow, minimumWindow],
    ["focus / window muted", roles.focusMuted, roles.windowMuted],
    ["focus / minimum-opacity window muted", roles.focusMuted, minimumMuted],
    ["focus / chrome", roles.focusChrome, roles.chrome],
    ["focus / minimum-opacity chrome", roles.focusChrome, minimumChrome],
  ];
  return [
    ...textPairs.map(([label, foreground, background]) => ({ label, foreground, background, ratio: themeContrastRatio(foreground, background), minimum: 4.5 as const })),
    ...indicatorPairs.map(([label, foreground, background]) => ({ label, foreground, background, ratio: themeContrastRatio(foreground, background), minimum: 3 as const })),
  ];
}

export function themeContrastIssues(definition: ThemeDefinition) {
  return themeContrastChecks(definition).filter((check) => check.ratio < check.minimum).map((check) => check.label);
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
    throw new Error("The desktop themes have an unsupported format.");
  }
  const customThemes = candidate.customThemes.map(parseCustomTheme);
  const ids = new Set<string>();
  for (const theme of customThemes) {
    if (ids.has(theme.id)) throw new Error("The desktop contains duplicate custom theme IDs.");
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
  const roles = themeSemanticRoles(definition);
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
    "--theme-elevated": roles.elevated,
    "--theme-accent-on-window": roles.accentOnWindow,
    "--theme-accent-on-chrome": roles.accentOnChrome,
    "--theme-accent-surface": roles.accentSurface,
    "--theme-danger-foreground": roles.dangerForeground,
    "--theme-danger-surface-foreground": roles.dangerSurfaceForeground,
    "--theme-status": roles.status,
    "--theme-status-foreground": roles.statusForeground,
    "--theme-status-surface": roles.statusSurface,
    "--theme-readonly-foreground": roles.readOnlyForeground,
    "--theme-readonly-surface": roles.readOnlySurface,
    "--theme-focus-window": roles.focusWindow,
    "--theme-focus-muted": roles.focusMuted,
    "--theme-focus-chrome": roles.focusChrome,
  } as CSSProperties;
}

export type DesktopIconMetrics = { width: number; height: number; stepX: number; stepY: number };

export function themeIconMetrics(definition: ThemeDefinition): DesktopIconMetrics {
  const width = Math.round(definition.iconSize + 38);
  const height = Math.round(definition.iconSize + 42);
  return { width, height, stepX: width + 6, stepY: height + 10 };
}
