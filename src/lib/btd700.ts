export const VENDOR_ID = 0x3542;
export const PRODUCT_ID = 0x3001;

/** Vendor collection the dongle uses for commands and events. */
export const COMMAND_USAGE_PAGE = 0xffa2;
export const COMMAND_REPORT_ID = 0x34;
/** Observed input size for report 52. hidapi writes 64 bytes including the report id. */
export const COMMAND_REPORT_BYTES = 63;

export const MARKER_EVENT = 0xfc;
export const MARKER_COMMAND = 0xfe;
export const MARKER_RESPONSE = 0xff;

export const CMD_GET_AUDIO_MODE = 0x01;
export const CMD_SET_AUDIO_MODE = 0x02;
export const CMD_GET_SUPPORTED_CODEC = 0x03;
export const CMD_SET_CODEC = 0x04;
export const CMD_GET_CODEC_IN_USE = 0x05;
export const CMD_GET_DONGLE_STATE = 0x06;
export const CMD_GET_AUDIO_QUALITY = 0x08;
export const CMD_GET_BROADCAST_INFO = 0x09;
export const CMD_SET_BROADCAST_INFO = 0x0a;
export const CMD_GET_BROADCAST_KEY = 0x0b;
export const CMD_SET_BROADCAST_KEY = 0x0c;
export const CMD_GET_BROADCAST_NAME = 0x0d;
export const CMD_SET_BROADCAST_NAME = 0x0e;
export const CMD_GET_FIRMWARE_VERSION = 0x12;

export const BROADCAST_QUALITIES = ["Standard, 16 kHz", "Standard, 24 kHz", "High quality, 48 kHz"];
export const LINK_STATE = [
  "Bluetooth idle",
  "Bluetooth disconnected",
  "Bluetooth connected",
  "Streaming audio",
  "Streaming voice",
];

const DONGLE_STATE = ["none", "disconnected", "connected", "streaming audio", "streaming voice"];
const LE_AUDIO_STATE = ["none", "disconnected", "connected", "streaming unicast", "streaming broadcast"];
const AUDIO_MODE = ["high quality", "gaming", "broadcast"];
const TRANSPORT = ["disconnected", "classic", "LE audio", "multipoint"];
const SINK = ["not available", "classic", "LE audio", "dual"];
export const CODEC_NAMES = ["SBC", "aptX", "aptX Adaptive", "aptX Lossless", "aptX Lite", "LC3"];
const RESOLUTION = ["", "16-bit", "24-bit"];
const FREQUENCY = ["", "44.1 kHz", "48 kHz", "96 kHz"];

const EVENT_DONGLE_STATE = 0x0f;
const EVENT_CODEC = 0x04;
const EVENT_AUDIO_MODE = 0x02;
const EVENT_LE_AUDIO = 0x10;
const EVENT_AUDIO_QUALITY = 0x11;
const EVENT_SINK = 0x16;

type ReportBits = {
  reportId: number;
  items: ReadonlyArray<{ reportSize: number; reportCount: number }>;
};

export function reportByteLength(report: ReportBits): number {
  const bits = report.items.reduce((total, item) => total + item.reportSize * item.reportCount, 0);
  if (bits > 0) return Math.ceil(bits / 8);
  if (report.reportId === COMMAND_REPORT_ID) return COMMAND_REPORT_BYTES;
  return 0;
}

export function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join(" ");
}

export function buildCommand(size: number, cmd: number, args: Uint8Array = new Uint8Array()): Uint8Array {
  if (args.length > size - 3) {
    throw new Error(`Command needs ${args.length} argument bytes, report holds ${size - 3}`);
  }
  const data = new Uint8Array(size);
  data[0] = MARKER_COMMAND;
  data[1] = cmd;
  data[2] = args.length;
  data.set(args, 3);
  return data;
}

/** WebHID strips the report id, so payload bytes start at index 3. */
export function payload(data: Uint8Array): Uint8Array {
  const length = data[2] ?? 0;
  return data.slice(3, 3 + length);
}

export function describeInput(data: Uint8Array): string {
  if (data[0] !== MARKER_EVENT && data[0] !== MARKER_RESPONSE) return "";
  const body = payload(data);
  const id = data[1];
  if (data[0] === MARKER_RESPONSE) return "";
  switch (id) {
    case EVENT_DONGLE_STATE:
      return `state ${label(DONGLE_STATE, body[0])}`;
    case EVENT_CODEC:
      return `codec ${codecNames(body[0] ?? 0)}`;
    case EVENT_AUDIO_MODE:
      return `audio ${label(AUDIO_MODE, body[0])}, transport ${label(TRANSPORT, body[1])}`;
    case EVENT_LE_AUDIO:
      return `LE audio ${label(LE_AUDIO_STATE, body[0])}`;
    case EVENT_AUDIO_QUALITY:
      return `quality ${body[0] ?? "?"} / ${body[1] ?? "?"}`;
    case EVENT_SINK:
      return `sink ${label(SINK, body[0])}`;
    default:
      return `event 0x${(id ?? 0).toString(16)} ${hex(body)}`;
  }
}

export function codecMask(data: Uint8Array): number {
  const body = payload(data);
  return (body[0] ?? 0) | ((body[1] ?? 0) << 8);
}

export function formatAudioQuality(data: Uint8Array): string {
  const body = payload(data);
  return formatQualityPair(body[0], body[1]);
}

export function formatQualityPair(resolution?: number, frequency?: number): string {
  const bits = RESOLUTION[resolution ?? 0] ?? `${resolution}-bit`;
  const rate = FREQUENCY[frequency ?? 0] ?? `${frequency} kHz`;
  if (!resolution && !frequency) return "Unknown";
  return `${bits}, ${rate}`;
}

function codecNames(mask: number): string {
  const names = CODEC_NAMES.filter((_, index) => mask & (1 << index));
  return names.length ? names.join(", ") : `none (0x${mask.toString(16)})`;
}

export type BroadcastInfo = {
  state: number;
  quality: number;
  encryption: number;
};

export function parseBroadcastInfo(data: Uint8Array): BroadcastInfo {
  const body = payload(data);
  return {
    state: body[0] ?? 0,
    quality: body[1] ?? 0,
    encryption: body[2] ?? 0,
  };
}

export function parseText(data: Uint8Array): string {
  const body = payload(data);
  const end = body.indexOf(0);
  const bytes = end === -1 ? body : body.slice(0, end);
  return new TextDecoder().decode(bytes);
}

export function encodeText(value: string, trailingNul: boolean): Uint8Array {
  const bytes = new TextEncoder().encode(value);
  if (!trailingNul) return bytes;
  const out = new Uint8Array(bytes.length + 1);
  out.set(bytes);
  return out;
}

export function describeResponse(cmd: number, data: Uint8Array): string {
  const body = payload(data);
  switch (cmd) {
    case CMD_GET_FIRMWARE_VERSION: {
      if (body.length < 2) return `firmware ${hex(body)}`;
      const build = body.length >= 4 ? body[2]! | (body[3]! << 8) : (body[2] ?? 0);
      return `firmware ${body[0]}.${body[1]}.${build}`;
    }
    case CMD_GET_DONGLE_STATE:
      return `state ${label(DONGLE_STATE, body[0])}`;
    case CMD_GET_AUDIO_MODE:
      return `audio ${label(AUDIO_MODE, body[0])}, transport ${label(TRANSPORT, body[1])}`;
    case CMD_GET_CODEC_IN_USE:
    case CMD_GET_SUPPORTED_CODEC:
      return `${cmd === CMD_GET_CODEC_IN_USE ? "codec" : "supported codecs"} ${codecNames(codecMask(data))}`;
    case CMD_GET_AUDIO_QUALITY:
      return formatAudioQuality(data);
    case CMD_SET_AUDIO_MODE:
      return "audio mode updated";
    case CMD_SET_CODEC:
      return "codec updated";
    case CMD_GET_BROADCAST_INFO: {
      const info = parseBroadcastInfo(data);
      const audience = info.state === 1 ? "public" : "private";
      const quality = BROADCAST_QUALITIES[info.quality] ?? `quality ${info.quality}`;
      return `broadcast ${audience}, ${quality}, encryption ${info.encryption ? "on" : "off"}`;
    }
    case CMD_GET_BROADCAST_NAME:
      return `broadcast name ${parseText(data) || "(empty)"}`;
    case CMD_GET_BROADCAST_KEY:
      return payload(data).some((byte) => byte !== 0) ? "broadcast password is set" : "broadcast password is empty";
    case CMD_SET_BROADCAST_INFO:
    case CMD_SET_BROADCAST_NAME:
    case CMD_SET_BROADCAST_KEY:
      return "broadcast settings saved";
    default:
      return hex(body);
  }
}

function label(names: string[], value: number | undefined): string {
  if (value === undefined) return "missing";
  return names[value] ?? `unknown (${value})`;
}
