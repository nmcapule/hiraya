import { describe, expect, test } from "bun:test";
import {
  BUILTIN_THEME_IDS,
  BUILTIN_THEMES,
  DEFAULT_THEME_ID,
  parseCustomTheme,
  parseThemeDefinition,
  parseThemeState,
  resolveTheme,
  themeContrastIssues,
  themeContrastChecks,
  themeContrastRatio,
  themeIconMetrics,
  themeSemanticRoles,
} from "../src/lib/themes";

describe("themes", () => {
  test("all built-in definitions satisfy the shared theme contract", () => {
    for (const id of BUILTIN_THEME_IDS) {
      expect(parseThemeDefinition(BUILTIN_THEMES[id].definition)).toEqual(BUILTIN_THEMES[id].definition);
      expect(themeContrastIssues(BUILTIN_THEMES[id].definition)).toEqual([]);
    }
  });

  test("checks the rendered text and indicator matrix", () => {
    const definition = BUILTIN_THEMES[DEFAULT_THEME_ID].definition;
    const cases: Array<[keyof typeof definition.colors, string]> = [
      ["textMuted", "muted"],
      ["chromeText", "text / chrome"],
      ["accentText", "accent"],
      ["editorComment", "editor comment"],
      ["editorKeyword", "editor keyword"],
      ["editorString", "editor string"],
    ];
    for (const [key, issue] of cases) {
      const colors = { ...definition.colors, [key]: key === "chromeText" ? definition.colors.chrome : definition.colors.window };
      if (key.startsWith("editor")) colors[key] = definition.colors.editorBackground;
      if (key === "accentText") colors[key] = definition.colors.accent;
      expect(themeContrastIssues({ ...definition, colors })).toContainEqual(expect.stringContaining(issue));
    }
  });

  test("derives accessible surface-specific roles for every built-in", () => {
    for (const id of BUILTIN_THEME_IDS) {
      const definition = BUILTIN_THEMES[id].definition;
      const roles = themeSemanticRoles(definition);
      for (const check of themeContrastChecks(definition)) expect(check.ratio).toBeGreaterThanOrEqual(check.minimum);
      expect(themeContrastRatio(roles.statusForeground, roles.statusSurface)).toBeGreaterThanOrEqual(4.5);
      expect(themeContrastRatio(roles.readOnlyForeground, roles.readOnlySurface)).toBeGreaterThanOrEqual(4.5);
      expect(themeContrastRatio(roles.focusChrome, roles.chrome)).toBeGreaterThanOrEqual(3);
      expect(themeContrastRatio(roles.focusWindow, roles.window)).toBeGreaterThanOrEqual(3);
    }
  });

  test("rejects an adversarial theme whose rendered surfaces collapse", () => {
    const definition = structuredClone(BUILTIN_THEMES[DEFAULT_THEME_ID].definition);
    for (const key of Object.keys(definition.colors) as Array<keyof typeof definition.colors>) definition.colors[key] = "#777777";
    const checks = themeContrastChecks(definition);
    expect(checks.find((check) => check.label === "read-only badge text / blended chrome")?.ratio).toBeLessThan(4.5);
    expect(checks.find((check) => check.label === "focus / minimum-opacity chrome")?.ratio).toBeLessThan(3);
    expect(themeContrastIssues(definition)).toEqual(expect.arrayContaining([
      "text / window",
      "text / window muted",
      "text / chrome",
      "accent foreground / accent fill",
      "danger text / danger surface",
      "focus / chrome",
    ]));
  });

  test("validates custom IDs, names, colors, and bounded values", () => {
    const definition = structuredClone(BUILTIN_THEMES[DEFAULT_THEME_ID].definition);
    expect(parseCustomTheme({ id: "theme-1", name: "My theme", definition })).toEqual({ id: "theme-1", name: "My theme", definition });
    expect(() => parseCustomTheme({ id: DEFAULT_THEME_ID, name: "Reserved", definition })).toThrow();
    expect(() => parseCustomTheme({ id: ".", name: "Dot", definition })).toThrow();
    expect(() => parseCustomTheme({ id: "界".repeat(61), name: "Too many bytes", definition })).toThrow();
    expect(() => parseCustomTheme({ id: "theme-1", name: " Bad ", definition })).toThrow();
    expect(() => parseCustomTheme({ id: "theme-1", name: "Bad\u0085name", definition })).toThrow();
    expect(() => parseThemeDefinition({ ...definition, colors: { ...definition.colors, accent: "red" } })).toThrow();
    expect(() => parseThemeDefinition({ ...definition, iconSize: 73 })).toThrow();
    expect(() => parseThemeDefinition({ ...definition, effects: { ...definition.effects, opacity: 0.5 } })).toThrow();
    expect(() => parseCustomTheme({ id: "theme-1", name: "Invisible", definition: { ...definition, colors: { ...definition.colors, text: definition.colors.window } } })).toThrow("contrast");
  });

  test("requires unique custom themes and a resolvable selection", () => {
    const definition = BUILTIN_THEMES[DEFAULT_THEME_ID].definition;
    const custom = { id: "custom-1", name: "Custom", definition };
    expect(parseThemeState({ selectedThemeId: custom.id, customThemes: [custom] })).toEqual({ selectedThemeId: custom.id, customThemes: [custom] });
    expect(() => parseThemeState({ selectedThemeId: "missing", customThemes: [] })).toThrow();
    expect(() => parseThemeState({ selectedThemeId: custom.id, customThemes: [custom, custom] })).toThrow();
  });

  test("resolves custom definitions and matching desktop metrics", () => {
    const definition = { ...BUILTIN_THEMES[DEFAULT_THEME_ID].definition, iconSize: 72 };
    const state = { selectedThemeId: "large", customThemes: [{ id: "large", name: "Large", definition }] };
    expect(resolveTheme(state)).toBe(definition);
    expect(themeIconMetrics(definition)).toEqual({ width: 110, height: 114, stepX: 116, stepY: 124 });
  });
});
