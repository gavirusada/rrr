import { describe, expect, test } from "bun:test";
import {
  createMtpCommandRequest,
  createMtpDataPayload,
  createMtpDataStart,
  MTP_DATA_DIRECTION,
  MTP_OPERATION,
  MTP_RESPONSE,
  MTP_TCP_PAYLOAD,
  parseMtpCommandResponse,
  parseMtpDataPayload,
  parseMtpDataStart
} from "../src/canon/mtpPackets";

describe("MTP packet helpers", () => {
  test("creates command request payloads", () => {
    const payload = createMtpCommandRequest({
      operationCode: MTP_OPERATION.OPEN_SESSION,
      transactionId: 3,
      parameters: [1]
    });
    const view = new DataView(payload.buffer);

    expect(view.getUint32(0, true)).toBe(MTP_TCP_PAYLOAD.COMMAND_REQUEST);
    expect(view.getUint32(4, true)).toBe(MTP_DATA_DIRECTION.CAMERA_TO_HOST_OR_NONE);
    expect(view.getUint16(8, true)).toBe(MTP_OPERATION.OPEN_SESSION);
    expect(view.getUint32(10, true)).toBe(3);
    expect(view.getUint32(14, true)).toBe(1);
  });

  test("creates host-to-camera data phase payloads", () => {
    const start = createMtpDataStart(7, 12);
    const startView = new DataView(start.buffer);
    expect(start.byteLength).toBe(16);
    expect(startView.getUint32(0, true)).toBe(MTP_TCP_PAYLOAD.DATA_START);
    expect(startView.getUint32(4, true)).toBe(7);
    expect(startView.getBigUint64(8, true)).toBe(12n);

    const bytes = new Uint8Array([1, 2, 3]);
    const payload = createMtpDataPayload(7, bytes, true);
    const payloadView = new DataView(payload.buffer);
    expect(payloadView.getUint32(0, true)).toBe(MTP_TCP_PAYLOAD.DATA_PAYLOAD_LAST);
    expect(payloadView.getUint32(4, true)).toBe(7);
    expect(payload.slice(8)).toEqual(bytes);
  });

  test("parses command responses", () => {
    const payload = new Uint8Array(14);
    const view = new DataView(payload.buffer);
    view.setUint32(0, MTP_TCP_PAYLOAD.COMMAND_RESPONSE, true);
    view.setUint16(4, MTP_RESPONSE.OK, true);
    view.setUint32(6, 3, true);
    view.setUint32(10, 99, true);

    expect(parseMtpCommandResponse(payload)).toEqual({
      responseCode: MTP_RESPONSE.OK,
      transactionId: 3,
      parameters: [99]
    });
  });

  test("parses data start payloads", () => {
    const payload = new Uint8Array(16);
    const view = new DataView(payload.buffer);
    view.setUint32(0, MTP_TCP_PAYLOAD.DATA_START, true);
    view.setUint32(4, 5, true);
    view.setUint32(8, 1024, true);
    view.setUint32(12, 0, true);

    expect(parseMtpDataStart(payload)).toEqual({
      transactionId: 5,
      byteLength: 1024
    });
  });

  test("parses final data payloads", () => {
    const payload = new Uint8Array([0x0c, 0, 0, 0, 5, 0, 0, 0, 0xff, 0xd8, 0xff, 0xd9]);

    expect(parseMtpDataPayload(payload)).toEqual({
      transactionId: 5,
      bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
      isLast: true
    });
  });
});
