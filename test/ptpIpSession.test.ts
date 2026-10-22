import { describe, expect, test } from "bun:test";
import { initializePtpIpTransport } from "../src/canon/ptpIpSession";
import type { MtpPayloadTransport } from "../src/canon/mtpSession";

class FakeTransport implements MtpPayloadTransport {
  readonly writes: Uint8Array[] = [];

  constructor(private readonly response: Uint8Array) {}

  async writePayload(payload: Uint8Array): Promise<void> {
    this.writes.push(payload);
  }

  async readPayload(): Promise<Uint8Array> {
    return this.response;
  }

  close(): void {}
}

describe("initializePtpIpTransport", () => {
  test("keeps initialization on the supplied transport and parses the ACK", async () => {
    const response = createAck();
    const transport = new FakeTransport(response);

    const ack = await initializePtpIpTransport(transport);

    expect(new DataView(transport.writes[0]?.buffer ?? new ArrayBuffer()).getUint32(0, true)).toBe(1);
    expect(ack.connectionNumber).toBe(1);
    expect(ack.cameraName).toBe("EOST100 ");
  });
});

function createAck(): Uint8Array {
  const name = "EOST100 \0";
  const payload = new Uint8Array(4 + 4 + 16 + name.length * 2 + 4);
  const view = new DataView(payload.buffer);
  view.setUint32(0, 2, true);
  view.setUint32(4, 1, true);
  for (let index = 0; index < name.length; index += 1) {
    payload[24 + index * 2] = name.charCodeAt(index);
  }
  view.setUint32(payload.byteLength - 4, 0x00010000, true);
  return payload;
}
