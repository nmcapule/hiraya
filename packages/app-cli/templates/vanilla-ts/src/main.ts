import { connectHiraya, HirayaSdkError, type ThemeTokens } from "@hiraya/apps-sdk";
import "./style.css";

const APP_ID = "dev.hiraya.starter";
const countElement = document.querySelector<HTMLElement>("#count");
const statusElement = document.querySelector<HTMLElement>("#status");
const button = document.querySelector<HTMLButtonElement>("button");

try {
  const hiraya = await connectHiraya({ appId: APP_ID });
  const launch = await hiraya.app.getLaunchContext();
  applyTheme(launch.theme);
  const storedCount = await hiraya.storage.get("count");
  let count = typeof storedCount === "number" && Number.isSafeInteger(storedCount) && storedCount >= 0 ? storedCount : 0;

  const render = () => {
    if (countElement) countElement.textContent = String(count);
  };
  const increment = async () => {
    count += 1;
    render();
    await hiraya.storage.set("count", count);
  };

  render();
  if (statusElement) statusElement.textContent = `Connected from ${launch.source}.`;
  await hiraya.window.setTitle("Hiraya App");
  await hiraya.commands.set([{ id: "increment", title: "Increment count" }]);
  const reportError = (error: unknown) => {
    if (statusElement) statusElement.textContent = error instanceof HirayaSdkError
      ? `Hiraya error (${error.code}): ${error.message}`
      : error instanceof Error ? error.message : String(error);
  };
  button?.addEventListener("click", () => void increment().catch(reportError));
  const unsubscribeCommand = hiraya.on("commands.invoked", ({ id }) => {
    if (id === "increment") void increment().catch(reportError);
  });
  const unsubscribeTheme = hiraya.on("theme.changed", applyTheme);
  addEventListener("pagehide", () => {
    unsubscribeCommand();
    unsubscribeTheme();
    hiraya.close();
  }, { once: true });
} catch (error) {
  if (statusElement) statusElement.textContent = error instanceof HirayaSdkError
    ? `Hiraya error (${error.code}): ${error.message}`
    : error instanceof Error ? error.message : String(error);
}

function applyTheme(theme: ThemeTokens): void {
  const root = document.documentElement;
  root.dataset.theme = theme.mode;
  for (const [name, value] of Object.entries(theme)) {
    if (name !== "mode") root.style.setProperty(`--hiraya-${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`, value);
  }
}
