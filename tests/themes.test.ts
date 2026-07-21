import { describe, expect, test } from "bun:test";
import {
  BUILTIN_THEME_IDS,
  BUILTIN_THEMES,
  DEFAULT_THEME_ID,
  parseCustomTheme,
  parseThemeDefinition,
  parseThemeState,
  resolveTheme,
  themeIconMetrics,
} from "../src/lib/themes";

describe("themes", () => {
  test("all built-in definitions satisfy the shared theme contract", () => {
    for (const id of BUILTIN_THEME_IDS) {
      expect(parseThemeDefinition(BUILTIN_THEMES[id].definition)).toEqual(BUILTIN_THEMES[id].definition);
    }
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
