import {
  connectHiraya,
  HirayaSdkError,
  type FileHandle,
  type HirayaClient,
  type ThemeTokens,
} from "@hiraya/apps-sdk";
import "./style.css";

const APP_ID = "dev.hiraya.pixel-editor";
const MIME_TYPE = "image/png";
const MAX_DIMENSION = 512;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const HISTORY_LIMIT = 40;
const ZOOM_LEVELS = [2, 4, 6, 8, 12, 16, 24, 32];
const PALETTE = ["#171c1a", "#f3ead8", "#e1a854", "#c7553d", "#93485f", "#584b8b", "#315d73", "#3f7b63", "#79a45a", "#d0c15d", "#d47e3f", "#814b32"];

type Tool = "pencil" | "eraser" | "fill";
type Snapshot = { width: number; height: number; pixels: Uint8ClampedArray };

const canvas = required<HTMLCanvasElement>("#editor-canvas");
const canvasContext = canvas.getContext("2d", { alpha: true, willReadFrequently: true });
if (!canvasContext) throw new Error("Canvas 2D is not available.");
const context: CanvasRenderingContext2D = canvasContext;

const elements = {
  canvasFrame: required<HTMLElement>("#canvas-frame"),
  canvasScroll: required<HTMLElement>("#canvas-scroll"),
  color: required<HTMLInputElement>("#color-input"),
  colorValue: required<HTMLOutputElement>("#color-value"),
  cursor: required<HTMLElement>("#cursor-position"),
  dimensions: required<HTMLElement>("#dimensions"),
  documentName: required<HTMLElement>("#document-name"),
  grid: required<HTMLInputElement>("#grid-toggle"),
  newDialog: required<HTMLDialogElement>("#new-dialog"),
  newForm: required<HTMLFormElement>("#new-form"),
  newHeight: required<HTMLInputElement>("#new-height"),
  newWidth: required<HTMLInputElement>("#new-width"),
  opacity: required<HTMLInputElement>("#opacity-input"),
  opacityValue: required<HTMLOutputElement>("#opacity-value"),
  palette: required<HTMLElement>("#palette"),
  redo: required<HTMLButtonElement>("#redo-button"),
  save: required<HTMLButtonElement>("#save-button"),
  status: required<HTMLElement>("#status"),
  undo: required<HTMLButtonElement>("#undo-button"),
  zoomValue: required<HTMLOutputElement>("#zoom-value"),
};

let hiraya: HirayaClient | null = null;
let currentHandle: FileHandle | null = null;
let currentRevision: number | null = null;
let documentName = "Untitled.png";
let pixels = new Uint8ClampedArray(32 * 32 * 4);
let tool: Tool = "pencil";
let zoomIndex = 4;
let dirty = false;
let busy = true;
let drawing = false;
let lastPixel: { x: number; y: number } | null = null;
let undoStack: Snapshot[] = [];
let redoStack: Snapshot[] = [];

renderPalette();
bindUi();
renderDocument();
setBusy(true, "Connecting to Hiraya...");
void start();

async function start(): Promise<void> {
  try {
    hiraya = await connectHiraya({ appId: APP_ID });
    const launch = await hiraya.app.getLaunchContext();
    applyTheme(launch.theme);
    const savedColor = await hiraya.storage.get("color");
    const savedOpacity = await hiraya.storage.get("opacity");
    if (typeof savedColor === "string" && /^#[0-9a-f]{6}$/i.test(savedColor)) setColor(savedColor);
    if (typeof savedOpacity === "number" && Number.isInteger(savedOpacity) && savedOpacity >= 0 && savedOpacity <= 100) {
      elements.opacity.value = String(savedOpacity);
      elements.opacityValue.value = `${savedOpacity}%`;
    }
    const unsubscribeTheme = hiraya.on("theme.changed", applyTheme);
    addEventListener("pagehide", () => {
      unsubscribeTheme();
      hiraya?.close();
    }, { once: true });
    await hiraya.window.setTitle("Pixel Editor - Untitled.png");
    if (launch.files[0]) await loadFile(launch.files[0]);
    else setStatus("Ready. Create pixel art or open a PNG.");
  } catch (error) {
    reportError(error, "Could not connect to Hiraya.");
  } finally {
    setBusy(false);
  }
}

function bindUi(): void {
  required<HTMLButtonElement>("#new-button").addEventListener("click", () => void requestNew());
  required<HTMLButtonElement>("#open-button").addEventListener("click", () => void openFile());
  elements.save.addEventListener("click", () => void save(false));
  required<HTMLButtonElement>("#save-as-button").addEventListener("click", () => void save(true));
  elements.undo.addEventListener("click", undo);
  elements.redo.addEventListener("click", redo);
  required<HTMLButtonElement>("#zoom-out").addEventListener("click", () => changeZoom(-1));
  required<HTMLButtonElement>("#zoom-in").addEventListener("click", () => changeZoom(1));
  elements.grid.addEventListener("change", renderScale);
  elements.color.addEventListener("input", () => {
    setColor(elements.color.value);
    void hiraya?.storage.set("color", elements.color.value);
  });
  elements.opacity.addEventListener("input", () => {
    elements.opacityValue.value = `${elements.opacity.value}%`;
    void hiraya?.storage.set("opacity", Number(elements.opacity.value));
  });
  document.querySelectorAll<HTMLButtonElement>("[data-tool]").forEach((button) => {
    button.addEventListener("click", () => selectTool(button.dataset.tool as Tool));
  });
  canvas.addEventListener("pointerdown", beginStroke);
  canvas.addEventListener("pointermove", moveStroke);
  canvas.addEventListener("pointerup", endStroke);
  canvas.addEventListener("pointercancel", endStroke);
  canvas.addEventListener("pointerleave", () => {
    if (!drawing) elements.cursor.textContent = "--, --";
  });
  addEventListener("keydown", handleShortcut);
  elements.newForm.addEventListener("submit", createNewFromDialog);
  required<HTMLButtonElement>("#new-cancel").addEventListener("click", () => elements.newDialog.close());
}

async function requestNew(): Promise<void> {
  if (!await confirmDiscard()) return;
  elements.newWidth.value = String(canvas.width);
  elements.newHeight.value = String(canvas.height);
  elements.newDialog.showModal();
  elements.newWidth.focus();
  elements.newWidth.select();
}

function createNewFromDialog(event: SubmitEvent): void {
  event.preventDefault();
  const width = Number(elements.newWidth.value);
  const height = Number(elements.newHeight.value);
  if (!validDimension(width) || !validDimension(height)) {
    elements.newWidth.setCustomValidity("Use a whole number from 1 to 512.");
    elements.newWidth.reportValidity();
    elements.newWidth.setCustomValidity("");
    return;
  }
  elements.newDialog.close();
  canvas.width = width;
  canvas.height = height;
  pixels = new Uint8ClampedArray(width * height * 4);
  currentHandle = null;
  currentRevision = null;
  documentName = "Untitled.png";
  resetHistory();
  setDirty(true);
  renderDocument();
  setStatus(`Created a transparent ${width} x ${height} canvas.`);
}

async function openFile(): Promise<void> {
  if (!hiraya || busy || !await confirmDiscard()) return;
  try {
    const handles = await hiraya.dialogs.openFile({ multiple: false, mimeTypes: [MIME_TYPE] });
    if (handles?.[0]) await loadFile(handles[0]);
  } catch (error) {
    reportError(error, "Could not open the file.");
  }
}

async function loadFile(handle: FileHandle): Promise<void> {
  if (!hiraya) return;
  setBusy(true, "Opening PNG...");
  try {
    const entry = await hiraya.files.stat(handle);
    if (entry.kind !== "file") throw new Error("The selected item is not a file.");
    if (entry.metadata.mimeType !== MIME_TYPE && !entry.metadata.name.toLowerCase().endsWith(".png")) throw new Error("Pixel Editor can only open PNG images.");
    const result = await hiraya.files.read(handle);
    const decoded = await decodePng(result.data);
    canvas.width = decoded.width;
    canvas.height = decoded.height;
    pixels = decoded.pixels;
    currentHandle = handle;
    currentRevision = entry.metadata.contentRevision;
    documentName = entry.metadata.name;
    resetHistory();
    setDirty(false);
    renderDocument();
    setStatus(`Opened ${entry.metadata.name}.`);
  } finally {
    setBusy(false);
  }
}

async function decodePng(data: ArrayBuffer): Promise<Snapshot> {
  const signature = new Uint8Array(data, 0, Math.min(8, data.byteLength));
  if (signature.length !== 8 || ![137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => signature[index] === value)) throw new Error("The selected file is not a valid PNG.");
  if (data.byteLength < 24 || data.byteLength > MAX_FILE_BYTES) throw new Error("PNG files must be 16 MB or smaller.");
  const header = new DataView(data);
  const headerWidth = header.getUint32(16);
  const headerHeight = header.getUint32(20);
  if (!validDimension(headerWidth) || !validDimension(headerHeight)) throw new Error(`PNG dimensions must be between 1 and ${MAX_DIMENSION} pixels per side.`);
  const bitmap = await createImageBitmap(new Blob([data], { type: MIME_TYPE }));
  try {
    if (!validDimension(bitmap.width) || !validDimension(bitmap.height)) throw new Error(`PNG dimensions must be between 1 and ${MAX_DIMENSION} pixels per side.`);
    const decoder = document.createElement("canvas");
    decoder.width = bitmap.width;
    decoder.height = bitmap.height;
    const decoderContext = decoder.getContext("2d", { willReadFrequently: true });
    if (!decoderContext) throw new Error("Canvas 2D is not available.");
    decoderContext.drawImage(bitmap, 0, 0);
    return { width: bitmap.width, height: bitmap.height, pixels: decoderContext.getImageData(0, 0, bitmap.width, bitmap.height).data.slice() };
  } finally {
    bitmap.close();
  }
}

async function save(saveAs: boolean): Promise<void> {
  if (!hiraya || busy) return;
  drawing = false;
  lastPixel = null;
  setBusy(true, "Encoding PNG...");
  try {
    let handle = saveAs ? null : currentHandle;
    let expectedRevision = saveAs ? null : currentRevision;
    if (!handle) {
      handle = await hiraya.dialogs.saveFile({ suggestedName: ensurePngName(documentName), mimeType: MIME_TYPE });
      if (!handle) return;
      const entry = await hiraya.files.stat(handle);
      if (entry.kind !== "file") throw new Error("The save destination is not a file.");
      expectedRevision = entry.metadata.contentRevision;
    }
    if (expectedRevision === null) throw new Error("The file revision is unavailable. Use Save As to preserve your work.");
    const data = await encodePng();
    const saved = await hiraya.files.write(handle, data, { mimeType: MIME_TYPE, expectedRevision });
    currentHandle = handle;
    currentRevision = saved.contentRevision;
    documentName = ensurePngName(saved.name);
    setDirty(false);
    renderMetadata();
    setStatus(`Saved ${documentName}.`);
  } catch (error) {
    if (error instanceof HirayaSdkError && error.code === "CONFLICT") {
      setStatus("Save conflict: the file changed elsewhere. Use Save As to preserve this version.", true);
    } else {
      reportError(error, "Could not save the PNG.");
    }
  } finally {
    setBusy(false);
  }
}

async function encodePng(): Promise<ArrayBuffer> {
  context.putImageData(new ImageData(pixels.slice(), canvas.width, canvas.height), 0, 0);
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error("PNG encoding failed.")), MIME_TYPE));
  return blob.arrayBuffer();
}

function beginStroke(event: PointerEvent): void {
  if (busy || event.button !== 0) return;
  const point = eventPixel(event);
  if (!point) return;
  canvas.setPointerCapture(event.pointerId);
  pushUndo();
  drawing = true;
  lastPixel = point;
  if (tool === "fill") {
    bucketFill(point.x, point.y);
    drawing = false;
    lastPixel = null;
  } else {
    drawLine(point, point);
  }
  finishEdit();
}

function moveStroke(event: PointerEvent): void {
  const point = eventPixel(event);
  elements.cursor.textContent = point ? `${point.x}, ${point.y}` : "--, --";
  if (busy || !drawing || !point || !lastPixel) return;
  drawLine(lastPixel, point);
  lastPixel = point;
  finishEdit();
}

function endStroke(event: PointerEvent): void {
  if (!drawing) return;
  drawing = false;
  lastPixel = null;
  if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
}

function drawLine(from: { x: number; y: number }, to: { x: number; y: number }): void {
  let x = from.x;
  let y = from.y;
  const dx = Math.abs(to.x - x);
  const dy = -Math.abs(to.y - y);
  const sx = x < to.x ? 1 : -1;
  const sy = y < to.y ? 1 : -1;
  let error = dx + dy;
  while (true) {
    setPixel(x, y, tool === "eraser" ? [0, 0, 0, 0] : selectedRgba());
    if (x === to.x && y === to.y) break;
    const doubled = error * 2;
    if (doubled >= dy) { error += dy; x += sx; }
    if (doubled <= dx) { error += dx; y += sy; }
  }
}

function bucketFill(x: number, y: number): void {
  const target = getPixel(x, y);
  const replacement = tool === "eraser" ? [0, 0, 0, 0] : selectedRgba();
  if (sameColor(target, replacement)) return;
  const stack = [y * canvas.width + x];
  const visited = new Uint8Array(canvas.width * canvas.height);
  while (stack.length) {
    const point = stack.pop() as number;
    if (visited[point]) continue;
    visited[point] = 1;
    const px = point % canvas.width;
    const py = Math.floor(point / canvas.width);
    if (!sameColor(getPixel(px, py), target)) continue;
    setPixel(px, py, replacement);
    if (px > 0) stack.push(point - 1);
    if (px + 1 < canvas.width) stack.push(point + 1);
    if (py > 0) stack.push(point - canvas.width);
    if (py + 1 < canvas.height) stack.push(point + canvas.width);
  }
}

function setPixel(x: number, y: number, rgba: number[]): void {
  const offset = (y * canvas.width + x) * 4;
  pixels[offset] = rgba[0];
  pixels[offset + 1] = rgba[1];
  pixels[offset + 2] = rgba[2];
  pixels[offset + 3] = rgba[3];
}

function getPixel(x: number, y: number): number[] {
  const offset = (y * canvas.width + x) * 4;
  return [pixels[offset], pixels[offset + 1], pixels[offset + 2], pixels[offset + 3]];
}

function selectedRgba(): number[] {
  const hex = elements.color.value;
  return [Number.parseInt(hex.slice(1, 3), 16), Number.parseInt(hex.slice(3, 5), 16), Number.parseInt(hex.slice(5, 7), 16), Math.round(Number(elements.opacity.value) * 2.55)];
}

function pushUndo(): void {
  undoStack.push(snapshot());
  if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
  redoStack = [];
  renderHistory();
}

function undo(): void {
  if (busy) return;
  const previous = undoStack.pop();
  if (!previous) return;
  redoStack.push(snapshot());
  restore(previous);
  setDirty(true);
  setStatus("Undid the last edit.");
}

function redo(): void {
  if (busy) return;
  const next = redoStack.pop();
  if (!next) return;
  undoStack.push(snapshot());
  restore(next);
  setDirty(true);
  setStatus("Redid the edit.");
}

function snapshot(): Snapshot {
  return { width: canvas.width, height: canvas.height, pixels: pixels.slice() };
}

function restore(state: Snapshot): void {
  canvas.width = state.width;
  canvas.height = state.height;
  pixels = state.pixels.slice();
  renderDocument();
}

function resetHistory(): void {
  undoStack = [];
  redoStack = [];
  renderHistory();
}

function finishEdit(): void {
  context.putImageData(new ImageData(pixels, canvas.width, canvas.height), 0, 0);
  setDirty(true);
}

function renderDocument(): void {
  context.imageSmoothingEnabled = false;
  context.putImageData(new ImageData(pixels, canvas.width, canvas.height), 0, 0);
  renderScale();
  renderMetadata();
  renderHistory();
}

function renderScale(): void {
  const zoom = ZOOM_LEVELS[zoomIndex];
  canvas.style.width = `${canvas.width * zoom}px`;
  canvas.style.height = `${canvas.height * zoom}px`;
  elements.canvasFrame.style.setProperty("--pixel-size", `${zoom}px`);
  elements.canvasFrame.style.width = `${canvas.width * zoom}px`;
  elements.canvasFrame.style.height = `${canvas.height * zoom}px`;
  elements.canvasFrame.classList.toggle("grid-visible", elements.grid.checked && zoom >= 6);
  elements.zoomValue.value = `${zoom * 100}%`;
}

function renderMetadata(): void {
  elements.documentName.textContent = `${dirty ? "*" : ""}${documentName}`;
  elements.dimensions.textContent = `${canvas.width} x ${canvas.height} px`;
  void hiraya?.window.setTitle(`Pixel Editor - ${dirty ? "*" : ""}${documentName}`);
}

function renderHistory(): void {
  elements.undo.disabled = undoStack.length === 0 || busy;
  elements.redo.disabled = redoStack.length === 0 || busy;
}

function renderPalette(): void {
  for (const color of PALETTE) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "swatch";
    button.style.backgroundColor = color;
    button.title = color.toUpperCase();
    button.setAttribute("aria-label", `Select ${color}`);
    button.addEventListener("click", () => {
      setColor(color);
      void hiraya?.storage.set("color", color);
    });
    elements.palette.append(button);
  }
  const transparent = document.createElement("button");
  transparent.type = "button";
  transparent.className = "swatch transparent";
  transparent.title = "Transparent (Eraser)";
  transparent.setAttribute("aria-label", "Select transparent eraser");
  transparent.addEventListener("click", () => selectTool("eraser"));
  elements.palette.append(transparent);
}

function setColor(color: string): void {
  elements.color.value = color;
  elements.colorValue.value = color.toUpperCase();
  document.documentElement.style.setProperty("--active-color", color);
  if (tool === "eraser") selectTool("pencil");
}

function selectTool(next: Tool): void {
  tool = next;
  document.querySelectorAll<HTMLButtonElement>("[data-tool]").forEach((button) => {
    const active = button.dataset.tool === tool;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  canvas.dataset.tool = tool;
  setStatus(`${tool[0].toUpperCase()}${tool.slice(1)} selected.`);
}

function changeZoom(direction: number): void {
  zoomIndex = Math.max(0, Math.min(ZOOM_LEVELS.length - 1, zoomIndex + direction));
  renderScale();
}

function handleShortcut(event: KeyboardEvent): void {
  if (busy || elements.newDialog.open) return;
  const modifier = event.ctrlKey || event.metaKey;
  if (modifier && event.key.toLowerCase() === "s") {
    event.preventDefault();
    void save(event.shiftKey);
  } else if (modifier && event.key.toLowerCase() === "z") {
    event.preventDefault();
    if (event.shiftKey) redo();
    else undo();
  } else if (modifier && event.key.toLowerCase() === "y") {
    event.preventDefault();
    redo();
  } else if (!modifier && !event.altKey && event.key.toLowerCase() === "p") selectTool("pencil");
  else if (!modifier && !event.altKey && event.key.toLowerCase() === "e") selectTool("eraser");
  else if (!modifier && !event.altKey && event.key.toLowerCase() === "f") selectTool("fill");
  else if (!modifier && (event.key === "+" || event.key === "=")) changeZoom(1);
  else if (!modifier && event.key === "-") changeZoom(-1);
}

async function confirmDiscard(): Promise<boolean> {
  if (!dirty) return true;
  if (!hiraya) return false;
  try {
    return await hiraya.dialogs.confirm({ title: "Discard unsaved changes?", message: "Your current pixel edits have not been saved.", confirmLabel: "Discard", destructive: true });
  } catch (error) {
    reportError(error, "Could not confirm the action.");
    return false;
  }
}

function setDirty(next: boolean): void {
  if (dirty === next) return;
  dirty = next;
  renderMetadata();
  void hiraya?.window.setDirty(next).catch((error: unknown) => reportError(error, "Could not update window state."));
}

function setBusy(next: boolean, message?: string): void {
  busy = next;
  document.querySelectorAll<HTMLButtonElement>("button").forEach((button) => {
    if (!button.closest("dialog")) button.disabled = next;
  });
  renderHistory();
  if (message) setStatus(message);
}

function setStatus(message: string, error = false): void {
  elements.status.textContent = message;
  elements.status.classList.toggle("error", error);
}

function reportError(error: unknown, fallback: string): void {
  if (error instanceof HirayaSdkError && error.code === "CANCELLED") return;
  const message = error instanceof HirayaSdkError ? `${fallback} (${error.code}: ${error.message})` : error instanceof Error ? `${fallback} ${error.message}` : fallback;
  setStatus(message, true);
}

function applyTheme(theme: ThemeTokens): void {
  document.documentElement.dataset.theme = theme.mode;
  for (const [name, value] of Object.entries(theme)) {
    if (name !== "mode") document.documentElement.style.setProperty(`--hiraya-${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`, value);
  }
}

function eventPixel(event: PointerEvent): { x: number; y: number } | null {
  const rect = canvas.getBoundingClientRect();
  const x = Math.floor((event.clientX - rect.left) * canvas.width / rect.width);
  const y = Math.floor((event.clientY - rect.top) * canvas.height / rect.height);
  return x >= 0 && y >= 0 && x < canvas.width && y < canvas.height ? { x, y } : null;
}

function sameColor(left: number[], right: number[]): boolean {
  return left.every((value, index) => value === right[index]);
}

function validDimension(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= MAX_DIMENSION;
}

function ensurePngName(name: string): string {
  return name.toLowerCase().endsWith(".png") ? name : `${name}.png`;
}

function required<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing required element: ${selector}`);
  return element;
}
