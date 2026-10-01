import {
  CMD,
  CODECS,
  EVENT,
  MARKER,
  MODE,
  PRODUCT_ID,
  REPORT_ID,
  TRANSPORT,
  USAGE_PAGE,
  VENDOR_ID,
  audioQuality,
  broadcastInfoArgs,
  buildCommand,
  codecArgs,
  codecMask,
  decodeText,
  describeEvent,
  encodeText,
  firmwareVersion,
  firstCodec,
  hex,
  parseBroadcastInfo,
  payload,
  stateLabel,
} from "../lib/btd700";

const RESPONSE_TIMEOUT_MS = 1500;

type Pending = {
  cmd: number;
  timer: number;
  resolve: (data: Uint8Array) => void;
  reject: (error: Error) => void;
};

let device: HIDDevice | null = null;
let pending: Pending | null = null;
let queue: Promise<unknown> = Promise.resolve();
let mode: number = MODE.standard;
let linkTransport: number = TRANSPORT.classic;
let syncing = false;

const ui = {
  connect: document.querySelector<HTMLButtonElement>("#connect")!,
  disconnect: document.querySelector<HTMLButtonElement>("#disconnect")!,
  status: document.querySelector<HTMLElement>("#status")!,
  state: document.querySelector<HTMLElement>("#link-state")!,
  firmware: document.querySelector<HTMLElement>("#firmware")!,
  controls: document.querySelector<HTMLElement>("#controls")!,
  modes: Array.from(
    document.querySelectorAll<HTMLButtonElement>("[data-mode]"),
  ),
  linkFields: document.querySelector<HTMLElement>("#link-properties")!,
  quality: document.querySelector<HTMLElement>("#audio-quality")!,
  transport: document.querySelector<HTMLSelectElement>("#transport")!,
  codec: document.querySelector<HTMLSelectElement>("#codec")!,
  broadcastFields: document.querySelector<HTMLElement>(
    "#broadcast-properties",
  )!,
  broadcastQuality:
    document.querySelector<HTMLSelectElement>("#broadcast-quality")!,
  broadcastName: document.querySelector<HTMLInputElement>("#broadcast-name")!,
  broadcastAudience: document.querySelector<HTMLSelectElement>(
    "#broadcast-audience",
  )!,
  broadcastPassword: document.querySelector<HTMLInputElement>(
    "#broadcast-password",
  )!,
  saveBroadcast: document.querySelector<HTMLButtonElement>("#save-broadcast")!,
  result: document.querySelector<HTMLElement>("#result")!,
  device: document.querySelector<HTMLElement>("#device")!,
  log: document.querySelector<HTMLElement>("#log")!,
};

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

const hex16 = (value: number) => value.toString(16).padStart(4, "0");

const isSecret = (cmd: number | undefined) =>
  cmd === CMD.getBroadcastKey || cmd === CMD.setBroadcastKey;

const redact = (data: Uint8Array) => `${hex(data.subarray(0, 3))} …`;

const isControlInterface = (candidate: HIDDevice) =>
  candidate.vendorId === VENDOR_ID &&
  candidate.productId === PRODUCT_ID &&
  candidate.collections.some(
    (collection) => collection.usagePage === USAGE_PAGE,
  );

const log = (line: string) => {
  const time = new Date().toLocaleTimeString([], { hour12: false });
  ui.log.textContent += `${time}  ${line}\n`;
  ui.log.scrollTop = ui.log.scrollHeight;
};

const showStatus = (text: string) => {
  ui.status.hidden = false;
  ui.status.textContent = text;
};

const showResult = (text: string) => {
  if (syncing && text === "") return;
  ui.result.textContent = text;
};

const showState = (state: number) => {
  ui.state.textContent = stateLabel(state);
};

const showMode = (next: number, transport?: number) => {
  mode = next;
  const broadcast = next === MODE.broadcast;
  if (!broadcast && transport) {
    linkTransport = transport;
    ui.transport.value = String(transport);
  }
  for (const button of ui.modes) {
    button.setAttribute(
      "aria-pressed",
      String(button.dataset.mode === String(next)),
    );
  }
  ui.linkFields.hidden = broadcast;
  ui.broadcastFields.hidden = !broadcast;
};

const showOpen = () => {
  ui.connect.hidden = true;
  ui.disconnect.hidden = false;
  ui.status.hidden = true;
  ui.state.hidden = false;
  ui.firmware.hidden = false;
  ui.controls.hidden = false;
};

const showClosed = (text: string) => {
  ui.connect.hidden = false;
  ui.disconnect.hidden = true;
  ui.state.hidden = true;
  ui.firmware.hidden = true;
  ui.controls.hidden = true;
  showStatus(text);
};

const selectCodec = (mask: number) => {
  const value = String(firstCodec(mask));
  if (Array.from(ui.codec.options).some((option) => option.value === value))
    ui.codec.value = value;
};

const fillCodecs = (supported: number, active: number) => {
  const options = CODECS.flatMap((name, index) =>
    supported & (1 << index) ? [new Option(name, String(index))] : [],
  );
  ui.codec.replaceChildren(...options);
  selectCodec(active);
};

const applyEvent = (data: Uint8Array) => {
  const [first = 0, second] = payload(data);
  switch (data[1]) {
    case EVENT.state:
      showState(first);
      break;
    case EVENT.audioMode:
      showMode(first, second);
      break;
    case EVENT.codec:
      selectCodec(first);
      break;
    case EVENT.audioQuality:
      ui.quality.textContent = audioQuality(first, second);
      break;
  }
};

const rejectPending = (error: Error) => {
  const done = pending;
  if (!done) return;
  pending = null;
  window.clearTimeout(done.timer);
  done.reject(error);
};

const onInputReport = (event: HIDInputReportEvent) => {
  if (event.reportId !== REPORT_ID) return;
  const data = new Uint8Array(
    event.data.buffer,
    event.data.byteOffset,
    event.data.byteLength,
  );
  const note = describeEvent(data);
  const bytes = isSecret(data[1])
    ? redact(data)
    : hex(data.subarray(0, 3 + (data[2] ?? 0)));
  log(`in   ${bytes}${note ? `  ${note}` : ""}`);

  if (data[0] === MARKER.event) {
    applyEvent(data);
  } else if (data[0] === MARKER.response && pending?.cmd === data[1]) {
    const done = pending;
    pending = null;
    window.clearTimeout(done.timer);
    done.resolve(data);
  }
};

/** Commands share one report, so each waits for the previous response. */
const run = (task: () => Promise<void>) => {
  const next = queue
    .then(task)
    .catch((error: unknown) => showResult(message(error)));
  queue = next;
  return next;
};

const request = async (cmd: number, args?: Uint8Array) => {
  const current = device;
  if (!current) throw new Error("Connect the dongle first.");

  const packet = buildCommand(cmd, args);
  log(
    `out  ${isSecret(cmd) ? redact(packet) : hex(packet.subarray(0, 3 + (packet[2] ?? 0)))}`,
  );

  const response = new Promise<Uint8Array>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      pending = null;
      reject(
        new Error(`The dongle did not answer command 0x${cmd.toString(16)}.`),
      );
    }, RESPONSE_TIMEOUT_MS);
    pending = { cmd, timer, resolve, reject };
  });

  try {
    await current.sendReport(REPORT_ID, packet);
  } catch (error) {
    rejectPending(error instanceof Error ? error : new Error(message(error)));
  }
  return response;
};

const sync = async () => {
  syncing = true;
  try {
    ui.firmware.textContent = `Firmware ${firmwareVersion(await request(CMD.getFirmware))}`;
    showState(payload(await request(CMD.getState))[0] ?? 0);

    const [currentMode = MODE.standard, transport] = payload(
      await request(CMD.getAudioMode),
    );
    showMode(currentMode, transport);

    const [resolution, frequency] = payload(await request(CMD.getAudioQuality));
    ui.quality.textContent = audioQuality(resolution, frequency);

    const supported = codecMask(await request(CMD.getSupportedCodecs));
    fillCodecs(supported, codecMask(await request(CMD.getCodec)));

    const info = parseBroadcastInfo(await request(CMD.getBroadcastInfo));
    ui.broadcastQuality.value = String(info.quality);
    ui.broadcastAudience.value = info.isPublic ? "1" : "0";
    ui.broadcastName.value = decodeText(await request(CMD.getBroadcastName));
    ui.broadcastPassword.value = decodeText(await request(CMD.getBroadcastKey));
  } finally {
    syncing = false;
  }
};

const setMode = async (next: number) => {
  const transport = next === MODE.broadcast ? TRANSPORT.leAudio : linkTransport;
  await request(CMD.setAudioMode, new Uint8Array([next, transport]));
  showMode(next, transport);
  showResult("");
};

const setTransport = async () => {
  const transport = Number(ui.transport.value);
  await request(CMD.setAudioMode, new Uint8Array([mode, transport]));
  linkTransport = transport;
  showResult("");
};

const setCodec = async () => {
  await request(CMD.setCodec, codecArgs(Number(ui.codec.value)));
  showResult("");
};

const saveBroadcast = async () => {
  const password = ui.broadcastPassword.value;
  await request(
    CMD.setBroadcastInfo,
    broadcastInfoArgs({
      isPublic: ui.broadcastAudience.value === "1",
      quality: Number(ui.broadcastQuality.value),
      encrypted: password.length > 0,
    }),
  );
  await request(
    CMD.setBroadcastName,
    encodeText(ui.broadcastName.value, { terminated: true }),
  );
  await request(
    CMD.setBroadcastKey,
    encodeText(password, { terminated: false }),
  );
  showResult("Saved.");
};

const open = async (next: HIDDevice) => {
  if (!next.opened) await next.open();
  device = next;
  next.addEventListener("inputreport", onInputReport);
  ui.device.textContent = `${next.productName || "BTD 700"} · ${hex16(next.vendorId)}:${hex16(next.productId)}`;
  showOpen();
  await run(sync);
};

const connect = async () => {
  try {
    const [picked] = await navigator.hid.requestDevice({
      filters: [
        { vendorId: VENDOR_ID, productId: PRODUCT_ID, usagePage: USAGE_PAGE },
      ],
    });
    if (picked) await open(picked);
  } catch (error) {
    showStatus(message(error));
  }
};

const disconnect = async () => {
  const current = device;
  device = null;
  rejectPending(new Error("Disconnected."));
  if (current) {
    current.removeEventListener("inputreport", onInputReport);
    if (current.opened) await current.close();
  }
  showClosed("Connect the dongle.");
};

const reconnect = async () => {
  const match = (await navigator.hid.getDevices()).find(isControlInterface);
  if (match)
    await open(match).catch((error: unknown) => showStatus(message(error)));
};

export const start = () => {
  if (!("hid" in navigator)) {
    showStatus("WebHID is unavailable. Open this page in Chrome or Edge.");
    ui.connect.disabled = true;
    return;
  }

  ui.connect.addEventListener("click", () => void connect());
  ui.disconnect.addEventListener("click", () => void disconnect());
  for (const button of ui.modes) {
    button.addEventListener(
      "click",
      () => void run(() => setMode(Number(button.dataset.mode))),
    );
  }
  ui.transport.addEventListener("change", () => void run(setTransport));
  ui.codec.addEventListener("change", () => void run(setCodec));
  ui.saveBroadcast.addEventListener("click", () => void run(saveBroadcast));

  navigator.hid.addEventListener("disconnect", (event) => {
    if (event.device !== device) return;
    device = null;
    rejectPending(new Error("Dongle disconnected."));
    showClosed("Dongle unplugged.");
  });

  void reconnect();
};
