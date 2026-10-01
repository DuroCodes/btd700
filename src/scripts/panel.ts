import {
  CMD_GET_AUDIO_MODE,
  CMD_GET_AUDIO_QUALITY,
  CMD_GET_BROADCAST_INFO,
  CMD_GET_BROADCAST_KEY,
  CMD_GET_BROADCAST_NAME,
  CMD_GET_CODEC_IN_USE,
  CMD_GET_DONGLE_STATE,
  CMD_GET_FIRMWARE_VERSION,
  CMD_GET_SUPPORTED_CODEC,
  CMD_SET_AUDIO_MODE,
  CMD_SET_BROADCAST_INFO,
  CMD_SET_BROADCAST_KEY,
  CMD_SET_BROADCAST_NAME,
  CMD_SET_CODEC,
  CODEC_NAMES,
  COMMAND_REPORT_ID,
  COMMAND_USAGE_PAGE,
  LINK_STATE,
  MARKER_EVENT,
  MARKER_RESPONSE,
  PRODUCT_ID,
  VENDOR_ID,
  buildCommand,
  codecMask,
  describeInput,
  describeResponse,
  encodeText,
  formatAudioQuality,
  formatQualityPair,
  hex,
  parseBroadcastInfo,
  parseText,
  payload,
  reportByteLength,
} from "../lib/btd700";

const FILTERS = [
  { vendorId: VENDOR_ID, productId: PRODUCT_ID, usagePage: 0xff00 },
  { vendorId: VENDOR_ID, productId: PRODUCT_ID, usagePage: 0xffa2 },
];

type Waiter = {
  cmd: number;
  timer: number;
  resolve: (data: Uint8Array) => void;
  reject: (error: Error) => void;
};

let device: HIDDevice | null = null;
let waiter: Waiter | null = null;
let activeMode = 0;
let lastTransport = 1;
let refreshing = false;
let applying = false;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export function start(): void {
  const connect = $("connect");
  const disconnect = $("disconnect");
  const reads = document.querySelectorAll<HTMLButtonElement>("[data-mode]");
  const saveBroadcast = $<HTMLButtonElement>("save-broadcast");
  const transport = $<HTMLSelectElement>("transport");
  const codec = $<HTMLSelectElement>("codec");

  if (!("hid" in navigator)) {
    setStatus("This browser has no WebHID. Open the page in Chrome or Edge.");
    connect.disabled = true;
    return;
  }

  connect.addEventListener("click", () => void onConnect());
  disconnect.addEventListener("click", () => void onDisconnect());
  for (const button of reads) {
    button.addEventListener("click", () => void setAudioMode(Number(button.dataset.mode)));
  }
  saveBroadcast.addEventListener("click", () => void saveBroadcastSettings());
  transport.addEventListener("change", () => void onTransportChange());
  codec.addEventListener("change", () => void onCodecChange());

  navigator.hid.addEventListener("disconnect", (event) => {
    if (device && event.device === device) {
      device = null;
      failWaiter(new Error("Dongle disconnected"));
      renderClosed("Dongle unplugged.");
    }
  });

  void showGranted();
}

async function showGranted(): Promise<void> {
  const granted = await navigator.hid.getDevices();
  const match = granted.find(isCommandDevice) ?? granted.find(isBtd700);
  if (!match) return;
  try {
    await openDevice(match);
  } catch (error) {
    setStatus(errorText(error));
  }
}

async function onConnect(): Promise<void> {
  setStatus("Choose the BTD 700 vendor interface.");
  try {
    const picked = await navigator.hid.requestDevice({ filters: FILTERS });
    const next = picked[0];
    if (!next) {
      setStatus("No device selected.");
      return;
    }
    await openDevice(next);
  } catch (error) {
    setStatus(errorText(error));
  }
}

async function openDevice(next: HIDDevice): Promise<void> {
  if (!next.opened) await next.open();
  device = next;
  waiter = null;
  next.oninputreport = onInput;
  renderOpen(next);
  setStatus(`Opened ${next.productName || "BTD 700"}.`);
  void refresh();
}

function onInput(event: HIDInputReportEvent): void {
  const bytes = new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength);
  const gloss = describeInput(redacted(bytes));
  log(`IN  id ${event.reportId}  ${bytes.byteLength} bytes  ${hex(redacted(bytes))}${gloss ? `  ${gloss}` : ""}`);
  if (bytes[0] === MARKER_EVENT) applyEvent(bytes);
  if (gloss && !refreshing) setResult(gloss);
  if (!waiter || bytes[0] === MARKER_EVENT) return;
  if (bytes[0] === MARKER_RESPONSE && bytes[1] === waiter.cmd) {
    finishWaiter(bytes);
  }
}

async function onDisconnect(): Promise<void> {
  failWaiter(new Error("Disconnected"));
  if (device?.opened) await device.close();
  device = null;
  renderClosed("Closed.");
}

async function setAudioMode(mode: number): Promise<void> {
  const transport = mode === 2 ? 2 : lastTransport;
  try {
    await send(CMD_SET_AUDIO_MODE, new Uint8Array([mode, transport]));
    setActiveMode(mode, transport);
  } catch (error) {
    setResult(errorText(error));
  }
}

async function refresh(): Promise<void> {
  if (refreshing) return;
  refreshing = true;
  applying = true;
  let note = "";
  try {
    const version = await send(CMD_GET_FIRMWARE_VERSION);
    $("firmware").textContent = describeResponse(CMD_GET_FIRMWARE_VERSION, version).replace(/^firmware /, "");

    const state = await send(CMD_GET_DONGLE_STATE);
    setLinkState(payload(state)[0] ?? 0);

    const mode = await send(CMD_GET_AUDIO_MODE);
    const modeBody = payload(mode);
    setActiveMode(modeBody[0] ?? 0, modeBody[1] ?? lastTransport);

    try {
      await loadLink();
    } catch (error) {
      note = errorText(error);
    }
    try {
      await loadBroadcast();
    } catch (error) {
      note ||= errorText(error);
    }
    setResult(note);
  } catch (error) {
    setResult(errorText(error));
  } finally {
    applying = false;
    refreshing = false;
  }
}

async function loadLink(): Promise<void> {
  $("audio-quality").textContent = formatAudioQuality(await send(CMD_GET_AUDIO_QUALITY));
  const supported = codecMask(await send(CMD_GET_SUPPORTED_CODEC));
  const inUse = codecMask(await send(CMD_GET_CODEC_IN_USE));
  fillCodecSelect(supported, inUse);
}

function fillCodecSelect(supported: number, inUse: number): void {
  const select = $<HTMLSelectElement>("codec");
  select.replaceChildren();
  const mask = supported || 0x3f;
  for (const [index, name] of CODEC_NAMES.entries()) {
    if ((mask & (1 << index)) === 0) continue;
    const option = document.createElement("option");
    option.value = String(index);
    option.textContent = name;
    select.append(option);
  }
  selectCodec(inUse);
}

async function onTransportChange(): Promise<void> {
  if (applying) return;
  const transport = Number($<HTMLSelectElement>("transport").value);
  try {
    await send(CMD_SET_AUDIO_MODE, new Uint8Array([activeMode, transport]));
    lastTransport = transport;
  } catch (error) {
    setResult(errorText(error));
  }
}

async function onCodecChange(): Promise<void> {
  if (applying) return;
  const mask = 1 << Number($<HTMLSelectElement>("codec").value);
  try {
    await send(CMD_SET_CODEC, new Uint8Array([mask & 0xff, (mask >> 8) & 0xff]));
  } catch (error) {
    setResult(errorText(error));
  }
}

async function loadBroadcast(): Promise<void> {
  const info = parseBroadcastInfo(await send(CMD_GET_BROADCAST_INFO));
  $<HTMLSelectElement>("broadcast-quality").value = String(info.quality);
  $<HTMLSelectElement>("broadcast-audience").value = info.state === 1 ? "1" : "0";
  $<HTMLInputElement>("broadcast-name").value = parseText(await send(CMD_GET_BROADCAST_NAME));
  $<HTMLInputElement>("broadcast-password").value = parseText(await send(CMD_GET_BROADCAST_KEY));
}

async function saveBroadcastSettings(): Promise<void> {
  const quality = Number($<HTMLSelectElement>("broadcast-quality").value);
  const audience = Number($<HTMLSelectElement>("broadcast-audience").value);
  const name = $<HTMLInputElement>("broadcast-name").value;
  const password = $<HTMLInputElement>("broadcast-password").value;
  const encryption = password.length > 0 ? 1 : 0;
  try {
    await send(CMD_SET_BROADCAST_INFO, new Uint8Array([audience, quality, encryption]));
    await send(CMD_SET_BROADCAST_NAME, encodeText(name, true));
    await send(CMD_SET_BROADCAST_KEY, encodeText(password, false));
    setResult("Broadcast settings saved.");
  } catch (error) {
    setResult(errorText(error));
  }
}

function setLinkState(state: number): void {
  $("link-state").textContent = LINK_STATE[state] ?? `Unknown (${state})`;
}

function setActiveMode(mode: number, transport?: number): void {
  activeMode = mode;
  if (transport !== undefined && transport > 0) {
    lastTransport = transport;
    const select = $<HTMLSelectElement>("transport");
    if ([...select.options].some((option) => option.value === String(transport))) select.value = String(transport);
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-mode]")) {
    button.setAttribute("aria-pressed", button.dataset.mode === String(mode) ? "true" : "false");
  }
  const broadcast = mode === 2;
  $("link-properties").hidden = broadcast;
  $("broadcast-properties").hidden = !broadcast;
}

function selectCodec(mask: number): void {
  const index = CODEC_NAMES.findIndex((_, codec) => mask & (1 << codec));
  const select = $<HTMLSelectElement>("codec");
  if (index >= 0 && select.querySelector(`option[value="${index}"]`)) select.value = String(index);
}

function applyEvent(bytes: Uint8Array): void {
  const body = payload(bytes);
  if (bytes[1] === 0x0f) setLinkState(body[0] ?? 0);
  if (bytes[1] === 0x02) setActiveMode(body[0] ?? 0, body[1]);
  if (bytes[1] === 0x04) selectCodec(body[0] ?? 0);
  if (bytes[1] === 0x11) $("audio-quality").textContent = formatQualityPair(body[0], body[1]);
}

function redacted(bytes: Uint8Array): Uint8Array {
  const command = bytes[1];
  const hidesPassword = command === CMD_GET_BROADCAST_KEY || command === CMD_SET_BROADCAST_KEY;
  if (!hidesPassword || bytes.byteLength < 4) return bytes;
  const copy = bytes.slice();
  copy.fill(0, 3);
  return copy;
}

async function send(cmd: number, args: Uint8Array = new Uint8Array()): Promise<Uint8Array> {
  const current = device;
  const report = selectedReport();
  if (!current || !report) {
    throw new Error("Connect and pick an output report first.");
  }
  if (waiter) {
    throw new Error("Waiting for the previous response.");
  }

  const packet = buildCommand(report.size, cmd, args);
  log(`OUT id ${report.id}  ${hex(redacted(packet))}`);
  setResult("Waiting…");

  const response = new Promise<Uint8Array>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      const pending = waiter;
      if (!pending) return;
      waiter = null;
      reject(new Error("No matching response in 1.5s. Check the log for a different report id."));
    }, 1500);
    waiter = { cmd, timer, resolve, reject };
  });
  const done = response.then(
    (data) => ({ ok: true as const, data }),
    (error: unknown) => ({ ok: false as const, error }),
  );

  try {
    await current.sendReport(report.id, packet);
  } catch (error) {
    failWaiter(error instanceof Error ? error : new Error(errorText(error)));
  }

  const outcome = await done;
  if (!outcome.ok) {
    throw outcome.error instanceof Error ? outcome.error : new Error(errorText(outcome.error));
  }
  if (!refreshing) setResult(describeResponse(cmd, outcome.data));
  return outcome.data;
}

function finishWaiter(data: Uint8Array): void {
  const pending = waiter;
  if (!pending) return;
  waiter = null;
  window.clearTimeout(pending.timer);
  pending.resolve(data);
}

function selectedReport(): { id: number; size: number } | null {
  const select = $<HTMLSelectElement>("report");
  const option = select.selectedOptions[0];
  if (!option) return null;
  return { id: Number(option.value), size: Number(option.dataset.size) };
}

function renderOpen(next: HIDDevice): void {
  $<HTMLButtonElement>("connect").hidden = true;
  $<HTMLButtonElement>("disconnect").hidden = false;
  $("status").hidden = true;
  $("link-state").hidden = false;
  $("firmware").hidden = false;
  $<HTMLElement>("commands").hidden = false;
  $("device").textContent = [
    next.productName || "BTD 700",
    `VID ${hex16(next.vendorId)}`,
    `PID ${hex16(next.productId)}`,
  ].join(" · ");
  $("collections").textContent = formatCollections(next);
  fillReports(next);
}

function renderClosed(message: string): void {
  $<HTMLButtonElement>("connect").hidden = false;
  $<HTMLButtonElement>("connect").disabled = false;
  $<HTMLButtonElement>("disconnect").hidden = true;
  $("status").hidden = false;
  $("link-state").hidden = true;
  $("firmware").hidden = true;
  $<HTMLElement>("commands").hidden = true;
  setStatus(message);
}

function fillReports(next: HIDDevice): void {
  const select = $<HTMLSelectElement>("report");
  select.replaceChildren();
  const reports = commandOutputs(next);
  for (const report of reports) {
    const size = reportByteLength(report);
    const option = document.createElement("option");
    option.value = String(report.reportId);
    option.dataset.size = String(size);
    option.textContent = `report ${report.reportId} · ${size} bytes`;
    select.append(option);
  }
  const preferred =
    [...select.options].find((option) => Number(option.value) === COMMAND_REPORT_ID) ?? select.options[0];
  if (preferred) preferred.selected = true;
  const empty = reports.length === 0;
  for (const control of document.querySelectorAll<HTMLButtonElement | HTMLSelectElement | HTMLInputElement>(
    "#commands button, #commands select, #commands input",
  )) {
    control.disabled = empty;
  }
  if (empty) setResult("The command report (id 52, usage page 0xFFA2) was not in this interface.");
}

function formatCollections(next: HIDDevice): string {
  if (next.collections.length === 0) return "No collections.";
  return next.collections
    .map((collection) => {
      const header = `usage page ${hex16(collection.usagePage)}  usage ${collection.usage}`;
      const lines = [
        ...collection.inputReports.map((report) => reportLine("input  ", report)),
        ...collection.outputReports.map((report) => reportLine("output ", report)),
        ...collection.featureReports.map((report) => reportLine("feature", report)),
      ];
      return [header, ...lines].join("\n");
    })
    .join("\n\n");
}

function reportLine(kind: string, report: HIDReportInfo): string {
  const size = reportByteLength(report);
  const command = kind.startsWith("output") && report.reportId === COMMAND_REPORT_ID ? "  command channel" : "";
  return `  ${kind}  id ${String(report.reportId).padStart(3)}  ${String(size).padStart(3)} bytes${command}`;
}

function commandOutputs(next: HIDDevice): HIDReportInfo[] {
  return next.collections
    .filter((collection) => collection.usagePage === COMMAND_USAGE_PAGE)
    .flatMap((collection) => collection.outputReports);
}

function isBtd700(candidate: HIDDevice): boolean {
  return candidate.vendorId === VENDOR_ID && candidate.productId === PRODUCT_ID;
}

function isCommandDevice(candidate: HIDDevice): boolean {
  return isBtd700(candidate) && candidate.collections.some((collection) => collection.usagePage === COMMAND_USAGE_PAGE);
}

function failWaiter(error: Error): void {
  const pending = waiter;
  if (!pending) return;
  waiter = null;
  window.clearTimeout(pending.timer);
  pending.reject(error);
}

function log(line: string): void {
  const pre = $("log");
  const stamp = new Date().toISOString().slice(11, 23);
  pre.textContent = `${pre.textContent}${stamp}  ${line}\n`;
  pre.scrollTop = pre.scrollHeight;
}

function setStatus(message: string): void {
  $("status").textContent = message;
}

function setResult(message: string): void {
  $("result").textContent = message;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hex16(value: number): string {
  return `0x${value.toString(16).padStart(4, "0")}`;
}
