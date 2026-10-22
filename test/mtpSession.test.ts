import { describe, expect, test } from "bun:test";
import { MtpSession, type MtpPayloadTransport } from "../src/canon/mtpSession";
import {
  MTP_DATA_DIRECTION,
  MTP_OPERATION,
  MTP_RESPONSE,
  MTP_TCP_PAYLOAD,
  parseMtpCommandRequest
} from "../src/canon/mtpPackets";

class ScriptedTransport implements MtpPayloadTransport {
  readonly writes: Uint8Array[] = [];

  constructor(private readonly reads: Uint8Array[]) {}

  async writePayload(payload: Uint8Array): Promise<void> {
    this.writes.push(payload);
  }

  async readPayload(): Promise<Uint8Array> {
    const payload = this.reads.shift();
    if (payload === undefined) {
      throw new Error("No scripted payload available");
    }

    return payload;
  }

  close(): void {}
}

describe("MtpSession", () => {
  test("opens an MTP session", async () => {
    const transport = new ScriptedTransport([commandResponse(1)]);
    const session = new MtpSession(transport, { sessionId: 1 });

    await session.openSession();

    const request = parseMtpCommandRequest(transport.writes[0] ?? new Uint8Array());
    expect(request.operationCode).toBe(MTP_OPERATION.OPEN_SESSION);
    expect(request.transactionId).toBe(1);
    expect(request.parameters).toEqual([1]);
  });

  test("reads data phase before command response", async () => {
    const transport = new ScriptedTransport([
      dataStart(1, 5),
      dataPayload(1, new Uint8Array([1, 2]), false),
      dataPayload(1, new Uint8Array([3, 4, 5]), true),
      commandResponse(1)
    ]);
    const session = new MtpSession(transport);

    const bytes = await session.getDeviceInfo();

    const request = parseMtpCommandRequest(transport.writes[0] ?? new Uint8Array());
    expect(request.operationCode).toBe(MTP_OPERATION.GET_DEVICE_INFO);
    expect(bytes).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
  });

  test("writes a host-to-camera data phase before reading the response", async () => {
    const transport = new ScriptedTransport([commandResponse(1)]);
    const session = new MtpSession(transport);
    const bytes = new Uint8Array([12, 0, 0, 0, 0xb1, 0xd1, 0, 0, 1, 0, 0, 0]);

    await session.sendData(0x9110, bytes);

    const request = parseMtpCommandRequest(transport.writes[0] ?? new Uint8Array());
    expect(request.operationCode).toBe(0x9110);
    expect(request.dataDirection).toBe(MTP_DATA_DIRECTION.HOST_TO_CAMERA);
    expect(new DataView((transport.writes[1] ?? new Uint8Array()).buffer).getUint32(0, true))
      .toBe(MTP_TCP_PAYLOAD.DATA_START);
    expect((transport.writes[2] ?? new Uint8Array()).slice(8)).toEqual(bytes);
  });

  test("returns accepted Canon camera response codes and successful response bytes", async () => {
    const jpegPayload = new Uint8Array([1, 2, 3, 4]);
    const transport = new ScriptedTransport([
      commandResponse(1, 0xa102),
      commandResponse(2, 0x2019),
      dataStart(3, jpegPayload.byteLength),
      dataPayload(3, jpegPayload, true),
      commandResponse(3)
    ]);
    const session = new MtpSession(transport);
    const request = {
      operationCode: 0x9153,
      parameters: [0x00200000, 1, 0],
      acceptedResponseCodes: [MTP_RESPONSE.OK, 0xa102, 0x2019]
    };

    expect(await session.executeCameraCommand(request)).toEqual({
      responseCode: 0xa102,
      bytes: new Uint8Array()
    });
    expect(await session.executeCameraCommand(request)).toEqual({
      responseCode: 0x2019,
      bytes: new Uint8Array()
    });
    expect(await session.executeCameraCommand(request)).toEqual({
      responseCode: MTP_RESPONSE.OK,
      bytes: jpegPayload
    });

    for (const writeIndex of [0, 1, 2]) {
      const command = parseMtpCommandRequest(transport.writes[writeIndex] ?? new Uint8Array());
      expect(command.operationCode).toBe(0x9153);
      expect(command.dataDirection).toBe(MTP_DATA_DIRECTION.CAMERA_TO_HOST_OR_NONE);
      expect(command.parameters).toEqual([0x00200000, 1, 0]);
    }
  });

  test("returns accepted Canon host-data response codes", async () => {
    const transport = new ScriptedTransport([
      commandResponse(1, 0x2019),
      commandResponse(2, 0xa102)
    ]);
    const session = new MtpSession(transport);
    const propertyPayload = new Uint8Array([12, 0, 0, 0, 0xb1, 0xd1, 0, 0, 1, 0, 0, 0]);
    const request = {
      operationCode: 0x9110,
      bytes: propertyPayload,
      acceptedResponseCodes: [MTP_RESPONSE.OK, 0x2019, 0xa102]
    };

    expect(await session.executeHostDataCommand(request)).toBe(0x2019);
    expect(await session.executeHostDataCommand(request)).toBe(0xa102);

    for (const writeIndex of [0, 3]) {
      const command = parseMtpCommandRequest(transport.writes[writeIndex] ?? new Uint8Array());
      expect(command.operationCode).toBe(0x9110);
      expect(command.dataDirection).toBe(MTP_DATA_DIRECTION.HOST_TO_CAMERA);
    }
    expect((transport.writes[2] ?? new Uint8Array()).slice(8)).toEqual(propertyPayload);
    expect((transport.writes[5] ?? new Uint8Array()).slice(8)).toEqual(propertyPayload);
  });

  test("keeps existing session methods strict about non-OK responses", async () => {
    const cameraTransport = new ScriptedTransport([commandResponse(1, 0xa102)]);
    const hostTransport = new ScriptedTransport([commandResponse(1, 0x2019)]);

    await expect(new MtpSession(cameraTransport).getLiveViewImage()).rejects.toThrow(
      "Unexpected MTP response code: 0xa102"
    );
    await expect(
      new MtpSession(hostTransport).sendData(0x9110, new Uint8Array([1]))
    ).rejects.toThrow("Unexpected MTP response code: 0x2019");
  });
});

function commandResponse(
  transactionId: number,
  responseCode: number = MTP_RESPONSE.OK
): Uint8Array {
  const payload = new Uint8Array(10);
  const view = new DataView(payload.buffer);
  view.setUint32(0, MTP_TCP_PAYLOAD.COMMAND_RESPONSE, true);
  view.setUint16(4, responseCode, true);
  view.setUint32(6, transactionId, true);
  return payload;
}

function dataStart(transactionId: number, byteLength: number): Uint8Array {
  const payload = new Uint8Array(12);
  const view = new DataView(payload.buffer);
  view.setUint32(0, MTP_TCP_PAYLOAD.DATA_START, true);
  view.setUint32(4, transactionId, true);
  view.setUint32(8, byteLength, true);
  return payload;
}

function dataPayload(transactionId: number, bytes: Uint8Array, isLast: boolean): Uint8Array {
  const payload = new Uint8Array(8 + bytes.byteLength);
  const view = new DataView(payload.buffer);
  view.setUint32(0, isLast ? MTP_TCP_PAYLOAD.DATA_PAYLOAD_LAST : MTP_TCP_PAYLOAD.DATA_PAYLOAD, true);
  view.setUint32(4, transactionId, true);
  payload.set(bytes, 8);
  return payload;
}
