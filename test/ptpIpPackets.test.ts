import { describe, expect, test } from "bun:test";
import {
  createFramedPayload,
  createInitCommandRequest,
  createInitEventRequest,
  parseInitCommandAck,
  parseInitEventAck
} from "../src/canon/ptpIpPackets";

describe("PTP/IP packets", () => {
  test("creates init command request", () => {
    const packet = createInitCommandRequest(new Uint8Array(16).fill(1), "PC");
    const view = new DataView(packet.buffer);

    expect(view.getUint32(0, true)).toBe(1);
    expect(packet.slice(4, 20)).toEqual(new Uint8Array(16).fill(1));
    expect(view.getUint32(packet.byteLength - 4, true)).toBe(0x00010000);
  });

  test("frames payload with length prefix", () => {
    const frame = createFramedPayload(new Uint8Array([1, 2, 3, 4]));
    const view = new DataView(frame.buffer);

    expect(view.getUint32(0, true)).toBe(8);
    expect(frame.slice(4)).toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  test("creates init event request with the command connection number", () => {
    const packet = createInitEventRequest(7);
    const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);

    expect(packet.byteLength).toBe(8);
    expect(view.getUint32(0, true)).toBe(3);
    expect(view.getUint32(4, true)).toBe(7);
  });

  test("parses init command ack", () => {
    const packet = new Uint8Array(36);
    const view = new DataView(packet.buffer);
    view.setUint32(0, 2, true);
    view.setUint32(4, 7, true);
    packet.set(new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0x60, 0x12, 0x8b, 0x7c, 0xc2, 0x40]), 8);
    packet.set(new Uint8Array([0x54, 0, 0x31, 0, 0x30, 0, 0x30, 0, 0, 0]), 24);
    view.setUint16(32, 1, true);
    view.setUint16(34, 0, true);

    expect(parseInitCommandAck(packet)).toEqual({
      connectionNumber: 7,
      cameraGuid: "0000000000000000010060128b7cc240",
      cameraName: "T100",
      versionMajor: 1,
      versionMinor: 0
    });
  });

  test("accepts init event ack packet type", () => {
    const packet = new Uint8Array(4);
    new DataView(packet.buffer).setUint32(0, 4, true);

    expect(parseInitEventAck(packet)).toBeUndefined();
  });

  test("rejects a non-event packet as init event ack", () => {
    const packet = new Uint8Array(4);
    new DataView(packet.buffer).setUint32(0, 2, true);

    expect(() => parseInitEventAck(packet)).toThrow("Unexpected packet type: 2");
  });
});
