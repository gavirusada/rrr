import net from "node:net";
import {
  createFramedPayload,
  createInitCommandRequestWithVersion,
  parseInitCommandAck,
  type InitCommandAck
} from "./ptpIpPackets";

export interface InitPtpIpOptions {
  host: string;
  port: number;
  localAddress?: string;
  timeoutMs?: number;
  clientName?: string;
  hostVersion?: number;
}

export async function initPtpIpCommandChannel(options: InitPtpIpOptions): Promise<InitCommandAck> {
  const timeoutMs = options.timeoutMs ?? 5000;
  const socket = new net.Socket();
  const clientGuid = new Uint8Array([
    0x43, 0x41, 0x4e, 0x4f, 0x4e, 0x57, 0x49, 0x46,
    0x49, 0x57, 0x45, 0x42, 0x43, 0x41, 0x4d, 0x01
  ]);
  const request = createFramedPayload(
    createInitCommandRequestWithVersion(
      clientGuid,
      options.clientName ?? "CanonWifiWebcam",
      options.hostVersion ?? 0x00010000
    )
  );

  return await new Promise<InitCommandAck>((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    let settled = false;

    const fail = (error: Error): void => {
      if (settled) {
        return;
      }

      settled = true;
      socket.destroy();
      reject(error);
    };

    socket.setTimeout(timeoutMs);
    socket.once("timeout", () => fail(new Error(`Timed out after ${timeoutMs}ms`)));
    socket.once("error", fail);
    socket.once("connect", () => {
      socket.write(request);
    });

    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.byteLength < 4) {
        return;
      }

      const expectedLength = buffer.readUInt32LE(0);
      if (buffer.byteLength < expectedLength) {
        return;
      }

      settled = true;
      socket.destroy();
      resolve(parseInitCommandAck(buffer.subarray(4, expectedLength)));
    });

    socket.connect(
      options.localAddress === undefined
        ? { host: options.host, port: options.port }
        : { host: options.host, port: options.port, localAddress: options.localAddress }
    );
  });
}
