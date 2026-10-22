import net from "node:net";
import { createFramedPayload } from "./ptpIpPackets";

export interface MtpTransportOptions {
  host: string;
  port: number;
  localAddress?: string;
  timeoutMs?: number;
}

export class MtpTransport {
  private readonly socket = new net.Socket();
  private buffer = Buffer.alloc(0);
  private connected = false;
  private terminalError: Error | null = null;

  constructor(private readonly options: MtpTransportOptions) {
    this.socket.on("error", (error) => {
      this.terminalError = error;
      this.connected = false;
    });
  }

  async connect(): Promise<void> {
    this.throwIfFailed();
    if (this.connected) {
      return;
    }

    const timeoutMs = this.options.timeoutMs ?? 5000;
    await new Promise<void>((resolve, reject) => {
      const fail = (error: Error): void => {
        cleanup();
        this.socket.destroy();
        reject(error);
      };
      const connected = (): void => {
        cleanup();
        this.connected = true;
        resolve();
      };
      const cleanup = (): void => {
        this.socket.setTimeout(0);
        this.socket.off("timeout", timedOut);
        this.socket.off("error", fail);
        this.socket.off("connect", connected);
      };
      const timedOut = (): void => fail(new Error(`Timed out after ${timeoutMs}ms`));

      this.socket.setTimeout(timeoutMs);
      this.socket.once("timeout", timedOut);
      this.socket.once("error", fail);
      this.socket.on("data", (chunk: Buffer) => {
        this.buffer = Buffer.concat([this.buffer, chunk]);
      });
      this.socket.once("connect", connected);

      this.socket.connect(
        this.options.localAddress === undefined
          ? { host: this.options.host, port: this.options.port }
          : { host: this.options.host, port: this.options.port, localAddress: this.options.localAddress }
      );
    });
  }

  async writePayload(payload: Uint8Array): Promise<void> {
    await this.connect();
    const frame = createFramedPayload(payload);
    await new Promise<void>((resolve, reject) => {
      this.socket.write(frame, (error) => {
        if (error != null) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }

  async readPayload(): Promise<Uint8Array> {
    await this.connect();
    this.throwIfFailed();

    while (this.buffer.byteLength < 4) {
      await this.waitForData();
    }

    const expectedLength = this.buffer.readUInt32LE(0);
    while (this.buffer.byteLength < expectedLength) {
      await this.waitForData();
    }

    const payload = this.buffer.subarray(4, expectedLength);
    this.buffer = this.buffer.subarray(expectedLength);
    return payload;
  }

  close(): void {
    this.socket.destroy();
    this.connected = false;
  }

  private async waitForData(): Promise<void> {
    this.throwIfFailed();
    const timeoutMs = this.options.timeoutMs ?? 5000;

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const err = new Error(`Timed out after ${timeoutMs}ms`);
        this.terminalError = err;
        this.connected = false;
        cleanup();
        this.socket.destroy();
        reject(err);
      }, timeoutMs);
      const onData = (): void => {
        cleanup();
        resolve();
      };
      const onError = (error: Error): void => {
        cleanup();
        reject(error);
      };
      const onClose = (): void => {
        cleanup();
        reject(new Error("MTP transport closed before a complete payload was received"));
      };
      const cleanup = (): void => {
        clearTimeout(timer);
        this.socket.off("data", onData);
        this.socket.off("error", onError);
        this.socket.off("close", onClose);
      };

      this.socket.once("data", onData);
      this.socket.once("error", onError);
      this.socket.once("close", onClose);
    });
  }

  private throwIfFailed(): void {
    if (this.terminalError !== null) {
      throw this.terminalError;
    }
  }
}
