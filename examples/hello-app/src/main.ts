import { connectHiraya, HirayaSdkError, type ThemeTokens } from "@hiraya/apps-sdk";
import "./style.css";

const APP_ID = "dev.hiraya.hello";
const greetings = ["Hello, Hiraya.", "Mabuhay!", "Build something thoughtful."];
const heading = document.querySelector<HTMLElement>("h1");
const button = document.querySelector<HTMLButtonElement>("button");
const countElement = document.querySelector<HTMLElement>("#count");
const launchElement = document.querySelector<HTMLElement>("#launch");
const themeElement = document.querySelector<HTMLElement>("#theme");
const statusElement = document.querySelector<HTMLElement>("#status");
let greeting = 0;

try {
  const hiraya = await connectHiraya({ appId: APP_ID });
  const launch = await hiraya.app.getLaunchContext();
  const storedClicks = await hiraya.storage.get("clicks");
  let clicks = typeof storedClicks === "number" && Number.isSafeInteger(storedClicks) && storedClicks >= 0 ? storedClicks : 0;

  const renderCount = () => {
    if (countElement) countElement.textContent = String(clicks);
  };
  const changeGreeting = async () => {
    greeting = (greeting + 1) % greetings.length;
    clicks += 1;
    if (heading) heading.textContent = greetings[greeting];
    renderCount();
    await hiraya.storage.set("clicks", clicks);
    await hiraya.window.setTitle(`${greetings[greeting]} (${clicks})`);
  };

  applyTheme(launch.theme);
  renderCount();
  if (launchElement) launchElement.textContent = `${launch.source} / ${launch.launchId}`;
  if (statusElement) statusElement.textContent = "Connected to the Hiraya host.";
  await hiraya.window.setTitle("Hello Hiraya");
  await hiraya.commands.set([{ id: "change-greeting", title: "Change the greeting" }]);
  const reportError = (error: unknown) => {
    if (statusElement) statusElement.textContent = error instanceof HirayaSdkError
      ? `Hiraya error (${error.code}): ${error.message}`
      : error instanceof Error ? error.message : String(error);
  };
  button?.addEventListener("click", () => void changeGreeting().catch(reportError));
  const unsubscribeCommand = hiraya.on("commands.invoked", ({ id }) => {
    if (id === "change-greeting") void changeGreeting().catch(reportError);
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
  document.documentElement.dataset.theme = theme.mode;
  if (themeElement) themeElement.textContent = theme.mode;
  for (const [name, value] of Object.entries(theme)) {
    if (name !== "mode") document.documentElement.style.setProperty(`--hiraya-${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`, value);
  }
}
