import { connectHiraya, HirayaSdkError, type HirayaClient, type JsonValue, type ThemeTokens } from "@hiraya/apps-sdk";
import { calculate, formatNumber } from "./calculator";
import "./style.css";

const APP_ID = "dev.hiraya.calculator";
const MAX_HISTORY = 30;
type HistoryItem = { expression: string; result: string; createdAt: number };

const expressionElement = required<HTMLElement>("#expression");
const resultElement = required<HTMLOutputElement>("#result");
const historyList = required<HTMLOListElement>("#history-list");
const emptyHistory = required<HTMLElement>("#empty-history");
const memoryIndicator = required<HTMLElement>("#memory-indicator");
const hostStatus = required<HTMLElement>("#host-status");
const clearHistoryButton = required<HTMLButtonElement>("#clear-history");

let expression = "";
let preview = "0";
let memory = 0;
let history: HistoryItem[] = [];
let justSolved = false;
let hiraya: HirayaClient | null = null;

document.querySelector(".keypad")?.addEventListener("click", (event) => {
  const button = (event.target as Element).closest<HTMLButtonElement>("button");
  if (!button) return;
  if (button.dataset.value) append(button.dataset.value);
  else if (button.dataset.action) perform(button.dataset.action);
});

document.querySelector(".memory-row")?.addEventListener("click", (event) => {
  const button = (event.target as Element).closest<HTMLButtonElement>("button");
  if (button?.dataset.action) perform(button.dataset.action);
});

clearHistoryButton.addEventListener("click", clearHistory);
historyList.addEventListener("click", (event) => {
  const button = (event.target as Element).closest<HTMLButtonElement>("button[data-expression]");
  if (!button?.dataset.expression) return;
  expression = button.dataset.expression;
  justSolved = false;
  updatePreview();
});

addEventListener("keydown", (event) => {
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  if (/^[0-9.+\-*/%()]$/.test(event.key)) append(event.key);
  else if (event.key === "Enter" || event.key === "=") solve();
  else if (event.key === "Backspace") backspace();
  else if (event.key === "Escape" || event.key === "Delete") clearExpression();
  else return;
  event.preventDefault();
});

render();
void initializeHost();

async function initializeHost(): Promise<void> {
  try {
    hiraya = await connectHiraya({ appId: APP_ID });
    const launch = await hiraya.app.getLaunchContext();
    applyTheme(launch.theme);
    const [storedHistory, storedMemory] = await Promise.all([
      hiraya.storage.get("history"),
      hiraya.storage.get("memory"),
    ]);
    history = parseHistory(storedHistory);
    memory = typeof storedMemory === "number" && Number.isFinite(storedMemory) ? storedMemory : 0;
    await hiraya.window.setTitle("Calculator");
    await hiraya.commands.set([
      { id: "clear", title: "Clear calculation" },
      { id: "clear-history", title: "Clear calculation history" },
    ]);
    const unsubscribeCommand = hiraya.on("commands.invoked", ({ id }) => {
      if (id === "clear") clearExpression();
      if (id === "clear-history") clearHistory();
    });
    const unsubscribeTheme = hiraya.on("theme.changed", applyTheme);
    addEventListener("pagehide", () => {
      unsubscribeCommand();
      unsubscribeTheme();
      hiraya?.close();
    }, { once: true });
    hostStatus.textContent = "Synced";
    hostStatus.dataset.connected = "true";
    render();
  } catch (error) {
    hostStatus.textContent = "Local session";
    hostStatus.title = describeError(error);
  }
}

function append(value: string): void {
  if (expression.length >= 256) return;
  const isOperator = /^[+\-*/]$/.test(value);
  if (justSolved && !isOperator && value !== "%") expression = "";
  justSolved = false;

  if (isOperator && /^[+\-*/]$/.test(expression.at(-1) ?? "")) {
    expression = expression.slice(0, -1) + value;
  } else if (value === "." && currentNumber().includes(".")) {
    return;
  } else {
    expression += value;
  }
  updatePreview();
}

function perform(action: string): void {
  if (action === "clear") clearExpression();
  if (action === "equals") solve();
  if (action === "sign") toggleSign();
  if (action === "parenthesis") addParenthesis();
  if (action === "memory-clear") setMemory(0);
  if (action === "memory-recall") recallMemory();
  if (action === "memory-add") setMemory(memory + currentValue());
  if (action === "memory-subtract") setMemory(memory - currentValue());
}

function solve(): void {
  if (!expression.trim()) return;
  try {
    const source = expression;
    const result = formatNumber(calculate(source));
    preview = result;
    expression = result;
    justSolved = true;
    history.unshift({ expression: source, result, createdAt: Date.now() });
    history = history.slice(0, MAX_HISTORY);
    void persist("history", history);
    render();
  } catch (error) {
    preview = error instanceof Error ? error.message : "Invalid expression";
    resultElement.dataset.error = "true";
    renderDisplay();
  }
}

function updatePreview(): void {
  if (!expression) preview = "0";
  else {
    try {
      preview = formatNumber(calculate(expression));
    } catch {
      preview = "...";
    }
  }
  renderDisplay();
}

function clearExpression(): void {
  expression = "";
  preview = "0";
  justSolved = false;
  renderDisplay();
}

function backspace(): void {
  expression = expression.slice(0, -1);
  justSolved = false;
  updatePreview();
}

function toggleSign(): void {
  const match = /(^|[+\-*/(])(-?\d*\.?\d+)$/.exec(expression);
  if (!match) return;
  const start = expression.length - match[2].length;
  expression = expression.slice(0, start) + (match[2].startsWith("-") ? match[2].slice(1) : `-${match[2]}`);
  justSolved = false;
  updatePreview();
}

function addParenthesis(): void {
  const openCount = [...expression].filter((character) => character === "(").length;
  const closeCount = [...expression].filter((character) => character === ")").length;
  const canClose = openCount > closeCount && /[\d)%]$/.test(expression);
  append(canClose ? ")" : "(");
}

function recallMemory(): void {
  const value = formatNumber(memory);
  if (justSolved) expression = "";
  expression += memory < 0 ? `(${value})` : value;
  justSolved = false;
  updatePreview();
}

function setMemory(value: number): void {
  memory = Number.isFinite(value) ? value : 0;
  void persist("memory", memory);
  renderMemory();
}

function currentValue(): number {
  try {
    return expression ? calculate(expression) : 0;
  } catch {
    return 0;
  }
}

function currentNumber(): string {
  return expression.split(/[+\-*/()%]/).at(-1) ?? "";
}

function clearHistory(): void {
  history = [];
  void persist("history", history);
  renderHistory();
}

function render(): void {
  renderDisplay();
  renderMemory();
  renderHistory();
}

function renderDisplay(): void {
  expressionElement.textContent = expression || "0";
  resultElement.textContent = preview;
  if (Number.isFinite(Number(preview))) delete resultElement.dataset.error;
  expressionElement.scrollLeft = expressionElement.scrollWidth;
}

function renderMemory(): void {
  const active = memory !== 0;
  memoryIndicator.dataset.active = String(active);
  memoryIndicator.setAttribute("aria-label", active ? `Memory contains ${formatNumber(memory)}` : "Memory is empty");
  memoryIndicator.title = active ? `Memory: ${formatNumber(memory)}` : "Memory is empty";
}

function renderHistory(): void {
  historyList.replaceChildren(...history.map((item) => {
    const row = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.expression = item.expression;
    button.setAttribute("aria-label", `Reuse ${item.expression}, result ${item.result}`);
    const expressionText = document.createElement("span");
    expressionText.className = "history-expression";
    expressionText.textContent = item.expression;
    const resultText = document.createElement("strong");
    resultText.textContent = `= ${item.result}`;
    button.append(expressionText, resultText);
    row.append(button);
    return row;
  }));
  emptyHistory.hidden = history.length > 0;
  clearHistoryButton.disabled = history.length === 0;
}

async function persist(key: string, value: JsonValue): Promise<void> {
  if (!hiraya) return;
  try {
    await hiraya.storage.set(key, value);
  } catch (error) {
    hostStatus.textContent = "Sync paused";
    hostStatus.title = describeError(error);
  }
}

function parseHistory(value: JsonValue | undefined): HistoryItem[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return [];
    const candidate = item as Record<string, JsonValue>;
    if (typeof candidate.expression !== "string" || typeof candidate.result !== "string" || typeof candidate.createdAt !== "number") return [];
    return [{ expression: candidate.expression.slice(0, 256), result: candidate.result.slice(0, 64), createdAt: candidate.createdAt }];
  }).slice(0, MAX_HISTORY);
}

function applyTheme(theme: ThemeTokens): void {
  document.documentElement.dataset.theme = theme.mode;
  for (const [name, value] of Object.entries(theme)) {
    if (name !== "mode") document.documentElement.style.setProperty(`--hiraya-${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`, value);
  }
}

function describeError(error: unknown): string {
  if (error instanceof HirayaSdkError) return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

function required<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing required element: ${selector}`);
  return element;
}
