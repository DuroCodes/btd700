export const VENDOR_ID = 0x3542;
export const PRODUCT_ID = 0x3001;
export const USAGE_PAGE = 0xffa2;
export const REPORT_ID = 0x34;
/** WebHID strips the report id, so the 64-byte hidapi packet is 63 bytes here. */
export const REPORT_SIZE = 63;

export const MARKER = {
  event: 0xfc,
  command: 0xfe,
  response: 0xff,
} as const;

export const CMD = {
  getAudioMode: 0x01,
  setAudioMode: 0x02,
  getSupportedCodecs: 0x03,
  setCodec: 0x04,
  getCodec: 0x05,
  getState: 0x06,
  getAudioQuality: 0x08,
  getBroadcastInfo: 0x09,
  setBroadcastInfo: 0x0a,
  getBroadcastKey: 0x0b,
  setBroadcastKey: 0x0c,
  getBroadcastName: 0x0d,
  setBroadcastName: 0x0e,
  getFirmware: 0x12,
} as const;

export const EVENT = {
  audioMode: 0x02,
  codec: 0x04,
  state: 0x0f,
  leAudio: 0x10,
  audioQuality: 0x11,
  sink: 0x16,
} as const;

export const MODE = {
  standard: 0,
  gaming: 1,
  broadcast: 2,
} as const;

export const TRANSPORT = {
  classic: 1,
  leAudio: 2,
  multipoint: 3,
} as const;

export const CODECS = [
  "SBC",
  "aptX",
  "aptX Adaptive",
  "aptX Lossless",
  "aptX Lite",
  "LC3",
];

const STATES = [
  "Idle",
  "Bluetooth disconnected",
  "Bluetooth connected",
  "Streaming audio",
  "Streaming voice",
];
const MODES = ["standard", "gaming", "broadcast"];
const TRANSPORTS = ["disconnected", "classic", "LE audio", "multipoint"];
const LE_AUDIO_STATES = [
  "none",
  "disconnected",
  "connected",
  "streaming unicast",
  "streaming broadcast",
];
const SINKS = ["not available", "classic", "LE audio", "dual"];
const RESOLUTIONS = ["", "16bit", "24bit"];
const FREQUENCIES = ["", "44.1kHz", "48kHz", "96kHz"];

export type BroadcastInfo = {
  isPublic: boolean;
  quality: number;
  encrypted: boolean;
};

const label = (names: string[], value: number | undefined) =>
  value === undefined ? "unknown" : (names[value] ?? `unknown (${value})`);

export const buildCommand = (
  cmd: number,
  args: Uint8Array = new Uint8Array(),
) => {
  if (args.length > REPORT_SIZE - 3) {
    throw new Error(
      `Command 0x${cmd.toString(16)} has ${args.length} argument bytes; the limit is ${REPORT_SIZE - 3}.`,
    );
  }
  const packet = new Uint8Array(REPORT_SIZE);
  packet[0] = MARKER.command;
  packet[1] = cmd;
  packet[2] = args.length;
  packet.set(args, 3);
  return packet;
};

export const payload = (data: Uint8Array) => data.slice(3, 3 + (data[2] ?? 0));

export const stateLabel = (state: number) =>
  STATES[state] ?? `Unknown state (${state})`;

export const firmwareVersion = (data: Uint8Array) => {
  const [major = 0, minor = 0, low = 0, high = 0] = payload(data);
  return `${major}.${minor}.${low | (high << 8)}`;
};

export const codecMask = (data: Uint8Array) => {
  const [low = 0, high = 0] = payload(data);
  return low | (high << 8);
};

export const codecArgs = (codec: number) => {
  const mask = 1 << codec;
  return new Uint8Array([mask & 0xff, (mask >> 8) & 0xff]);
};

export const firstCodec = (mask: number) =>
  CODECS.findIndex((_, index) => (mask & (1 << index)) !== 0);

export const audioQuality = (resolution = 0, frequency = 0) => {
  if (!resolution && !frequency) return "—";
  return `${RESOLUTIONS[resolution] ?? resolution}, ${FREQUENCIES[frequency] ?? frequency}`;
};

export const parseBroadcastInfo = (data: Uint8Array) => {
  const [audience = 0, quality = 0, encryption = 0] = payload(data);
  return { isPublic: audience === 1, quality, encrypted: encryption === 1 };
};

export const broadcastInfoArgs = (info: BroadcastInfo) =>
  new Uint8Array([info.isPublic ? 1 : 0, info.quality, info.encrypted ? 1 : 0]);

export const decodeText = (data: Uint8Array) => {
  const body = payload(data);
  const end = body.indexOf(0);
  return new TextDecoder().decode(end === -1 ? body : body.subarray(0, end));
};

export const encodeText = (
  value: string,
  { terminated }: { terminated: boolean },
) => {
  const bytes = new TextEncoder().encode(value);
  if (!terminated) return bytes;
  const out = new Uint8Array(bytes.length + 1);
  out.set(bytes);
  return out;
};

export const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(" ");

export const describeEvent = (data: Uint8Array) => {
  if (data[0] !== MARKER.event) return "";
  const [first, second] = payload(data);
  switch (data[1]) {
    case EVENT.state:
      return stateLabel(first ?? 0).toLowerCase();
    case EVENT.codec:
      return `codec ${CODECS[firstCodec(first ?? 0)] ?? "unknown"}`;
    case EVENT.audioMode:
      return `${label(MODES, first)} mode, ${label(TRANSPORTS, second)}`;
    case EVENT.leAudio:
      return `LE audio ${label(LE_AUDIO_STATES, first)}`;
    case EVENT.audioQuality:
      return `quality ${audioQuality(first, second)}`;
    case EVENT.sink:
      return `sink ${label(SINKS, first)}`;
    default:
      return `event 0x${(data[1] ?? 0).toString(16)}`;
  }
};
