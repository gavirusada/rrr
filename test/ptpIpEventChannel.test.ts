import { describe, expect, test } from "bun:test";
import type { MtpPayloadTransport } from "../src/canon/mtpSession";
import { PtpIpEventChannel } from "../src/canon/ptpIpEventChannel";

class FakeTransport implements MtpPayloadTransport {
  readonly writes: Uint8Array[] = [];
  closed = false;

  constructor(private readonly response: Uint8Array) {}

  async writePayload(payload: Uint8Array): Promise<void> {
    this.writes.push(payload);
  }

  async readPayload(): Promise<Uint8Array> {
    return this.response;
  }

  close(): void {
    this.closed = true;
  }
}

describe("PtpIpEventChannel", () => {
  test("initializes the supplied transport with the command connection number", async () => {
    const transport = new FakeTransport(eventAck());
    const channel = new PtpIpEventChannel(transport);

    await channel.initialize(7);

    expect(transport.writes).toHaveLength(1);
    const request = transport.writes[0] ?? new Uint8Array();
    const view = new DataView(request.buffer, request.byteOffset, request.byteLength);
    expect(view.getUint32(0, true)).toBe(3);
    expect(view.getUint32(4, true)).toBe(7);
  });

  test("rejects initialization when the camera does not return an event ACK", async () => {
    const transport = new FakeTransport(packet(2));
    const channel = new PtpIpEventChannel(transport);

    await expect(channel.initialize(7)).rejects.toThrow("Unexpected packet type: 2");
  });

  test("closes the supplied transport", () => {
    const transport = new FakeTransport(eventAck());
    const channel = new PtpIpEventChannel(transport);

    channel.close();

    expect(transport.closed).toBe(true);
  });
});

function eventAck(): Uint8Array {
  return packet(4);
}

function packet(type: number): Uint8Array {
  const payload = new Uint8Array(4);
  new DataView(payload.buffer).setUint32(0, type, true);
  return payload;
}
