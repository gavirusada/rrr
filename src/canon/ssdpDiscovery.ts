import dgram from "node:dgram";

const CANON_SMARTPHONE_SERVICE = "urn:schemas-canon-com:service:ICPO-SmartPhoneEOSSystemService:1";

export interface SsdpCamera {
  address: string;
  port: number;
  location: string;
  server: string;
  serviceType: string;
  usn: string;
}

export interface DiscoverOptions {
  localAddress?: string;
  timeoutMs?: number;
}

export function parseSsdpCameraResponse(message: string, remoteAddress: string, remotePort: number): SsdpCamera | null {
  const headers = parseHeaders(message);
  const serviceType = headers.get("st") ?? headers.get("nt") ?? "";

  if (serviceType !== CANON_SMARTPHONE_SERVICE) {
    return null;
  }

  const notifyStatus = headers.get("nts");
  if (notifyStatus !== undefined && notifyStatus !== "ssdp:alive") {
    return null;
  }

  const location = headers.get("location");
  const usn = headers.get("usn");
  if (location === undefined || usn === undefined) {
    return null;
  }

  return {
    address: remoteAddress,
    port: remotePort,
    location,
    server: headers.get("server") ?? "",
    serviceType,
    usn
  };
}

export async function discoverCanonCameras(options: DiscoverOptions = {}): Promise<SsdpCamera[]> {
  const timeoutMs = options.timeoutMs ?? 3000;
  const searchSocket = dgram.createSocket({ type: "udp4", reuseAddr: true });
  const notifySocket = dgram.createSocket({ type: "udp4", reuseAddr: true });
  const found = new Map<string, SsdpCamera>();

  const message = Buffer.from([
    "M-SEARCH * HTTP/1.1",
    "HOST:239.255.255.250:1900",
    'MAN:"ssdp:discover"',
    "MX:1",
    `ST:${CANON_SMARTPHONE_SERVICE}`,
    "",
    ""
  ].join("\r\n"));

  return await new Promise<SsdpCamera[]>((resolve, reject) => {
    let interval: Timer | undefined;
    let timeout: Timer | undefined;
    let settled = false;

    const done = (): void => {
      if (settled) {
        return;
      }

      settled = true;
      if (interval !== undefined) {
        clearInterval(interval);
      }

      if (timeout !== undefined) {
        clearTimeout(timeout);
      }

      searchSocket.close();
      notifySocket.close();
      resolve([...found.values()]);
    };

    const fail = (error: Error): void => {
      if (settled) {
        return;
      }

      settled = true;
      if (interval !== undefined) {
        clearInterval(interval);
      }

      if (timeout !== undefined) {
        clearTimeout(timeout);
      }

      searchSocket.close();
      notifySocket.close();
      reject(error);
    };

    const receive = (buffer: Buffer, remote: dgram.RemoteInfo): void => {
      const camera = parseSsdpCameraResponse(buffer.toString("utf8"), remote.address, remote.port);
      if (camera !== null) {
        found.set(camera.usn, camera);
      }
    };

    searchSocket.on("message", receive);
    notifySocket.on("message", receive);
    searchSocket.once("error", fail);
    notifySocket.once("error", fail);

    notifySocket.bind(1900, options.localAddress, () => {
      if (options.localAddress !== undefined) {
        notifySocket.addMembership("239.255.255.250", options.localAddress);
      } else {
        notifySocket.addMembership("239.255.255.250");
      }

      searchSocket.bind(0, options.localAddress, () => {
        searchSocket.setMulticastTTL(1);
        if (options.localAddress !== undefined) {
          searchSocket.setMulticastInterface(options.localAddress);
        }

        const sendSearch = (): void => {
          searchSocket.send(message, 1900, "239.255.255.250");
        };

        sendSearch();
        interval = setInterval(sendSearch, 2000);
        timeout = setTimeout(done, timeoutMs);
      });
    });
  });
}

function parseHeaders(message: string): Map<string, string> {
  const headers = new Map<string, string>();
  const lines = message.split(/\r?\n/);

  for (const line of lines.slice(1)) {
    const separator = line.indexOf(":");
    if (separator < 1) {
      continue;
    }

    headers.set(line.slice(0, separator).trim().toLowerCase(), line.slice(separator + 1).trim());
  }

  return headers;
}
