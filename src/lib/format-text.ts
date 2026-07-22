import type { EditorLanguage } from "../types";

const PARSERS: Partial<Record<EditorLanguage, string>> = {
  markdown: "markdown",
  json: "json",
  javascript: "babel",
  typescript: "typescript",
  jsx: "babel",
  tsx: "typescript",
  css: "css",
  html: "html",
  yaml: "yaml",
};

export async function formatEditorText(content: string, language: EditorLanguage) {
  const parser = PARSERS[language];
  if (!parser) return content;
  const [prettier, babel, estree, html, markdown, postcss, typescript, yaml] = await Promise.all([
    import("prettier/standalone"),
    import("prettier/plugins/babel"),
    import("prettier/plugins/estree"),
    import("prettier/plugins/html"),
    import("prettier/plugins/markdown"),
    import("prettier/plugins/postcss"),
    import("prettier/plugins/typescript"),
    import("prettier/plugins/yaml"),
  ]);
  const plugins = [babel, estree, html, markdown, postcss, typescript, yaml];
  return prettier.format(content, { parser, plugins, tabWidth: 2 });
}
