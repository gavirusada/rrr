export interface AppConfig {
  cameraIp?: string;
  cameraPort: number;
  localAddress?: string;
  listenHost: string;
  listenPort: number;
  discover: boolean;
  discoverTimeoutMs: number;
  describe: boolean;
  descriptorLocation?: string;
  cameraPropsWatchSeconds: number | null;
  interfaces: boolean;
  init: boolean;
  mtpSmoke: boolean;
  probeOnly: boolean;
  serveMjpeg: boolean;
}

export function parseArgs(args: string[]): AppConfig {
  const values = new Map<string, string>();
  const flags = new Set<string>();

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) {
      continue;
    }

    if (arg === "--probe-only") {
      flags.add(arg);
      continue;
    }

    if (arg === "--discover") {
      flags.add(arg);
      continue;
    }

    if (arg === "--init") {
      flags.add(arg);
      continue;
    }

    if (arg === "--mtp-smoke") {
      flags.add(arg);
      continue;
    }

    if (arg === "--serve-mjpeg") {
      flags.add(arg);
      continue;
    }

    if (arg === "--interfaces") {
      flags.add(arg);
      continue;
    }

    if (arg === "--describe") {
      flags.add(arg);
      continue;
    }

    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected argument ${arg}`);
    }

    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Missing value for ${arg}`);
    }

    values.set(arg, value);
    index += 1;
  }

  const cameraIp = values.get("--camera-ip");
  if (!flags.has("--discover") && !flags.has("--interfaces") && !flags.has("--describe") && (cameraIp === undefined || cameraIp.trim().length === 0)) {
    throw new Error("Missing required --camera-ip");
  }

  const config: AppConfig = {
    cameraPort: parsePort(values.get("--camera-port") ?? "15740", "--camera-port"),
    listenHost: values.get("--listen-host") ?? "127.0.0.1",
    listenPort: parsePort(values.get("--listen-port") ?? "8787", "--listen-port"),
    discover: flags.has("--discover"),
    discoverTimeoutMs: parsePositiveInteger(values.get("--discover-timeout-ms") ?? "3000", "--discover-timeout-ms"),
    describe: flags.has("--describe"),
    cameraPropsWatchSeconds:
      values.has("--camera-props-watch")
        ? parsePositiveInteger(values.get("--camera-props-watch") ?? "", "--camera-props-watch")
        : null,
    interfaces: flags.has("--interfaces"),
    init: flags.has("--init"),
    mtpSmoke: flags.has("--mtp-smoke"),
    probeOnly: flags.has("--probe-only"),
    serveMjpeg: flags.has("--serve-mjpeg")
  };

  if (cameraIp !== undefined) {
    config.cameraIp = cameraIp;
  }

  const localAddress = values.get("--local-address");
  if (localAddress !== undefined) {
    config.localAddress = localAddress;
  }

  const descriptorLocation = values.get("--descriptor-location");
  if (descriptorLocation !== undefined) {
    config.descriptorLocation = descriptorLocation;
  }

  return config;
}

function parsePort(value: string, optionName: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid ${optionName}: expected integer between 1 and 65535`);
  }

  return port;
}

function parsePositiveInteger(value: string, optionName: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    throw new Error(`Invalid ${optionName}: expected positive integer`);
  }

  return number;
}

export function usage(): string {
  return [
    "Usage: bun run dev -- --camera-ip <ip> [options]",
    "",
    "Options:",
    "  --camera-ip <ip>       Camera IPv4 address",
    "  --camera-port <port>   Camera PTP/IP port, default 15740",
    "  --local-address <ip>   Local Wi-Fi IPv4 address to bind from",
    "  --listen-host <host>   Local bind host, default 127.0.0.1",
    "  --listen-port <port>   Local MJPEG server port, default 8787",
    "  --discover             Discover Canon cameras over SSDP",
    "  --discover-timeout-ms <ms>  Discovery wait time, default 3000",
    "  --describe             Fetch and parse Canon UPnP descriptor",
    "  --descriptor-location <url> Descriptor URL; discovers if omitted",
    "  --camera-props-watch <seconds>  Poll Canon property events for diagnostics",
    "  --interfaces           List local IPv4 interfaces",
    "  --init                 Send PTP/IP Init Command Request",
    "  --mtp-smoke            Open MTP session and request GetDeviceInfo",
    "  --serve-mjpeg          Stream Canon Live View as local MJPEG",
    "  --probe-only           Probe camera connectivity and exit",
    "  --help                 Show this help"
  ].join("\n");
}
