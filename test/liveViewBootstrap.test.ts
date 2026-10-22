import { describe, expect, test } from "bun:test";
import {
  LiveViewBootstrap,
  type LiveViewBootstrapCommands
} from "../src/canon/liveViewBootstrap";

interface CameraCommandRequest {
  operationCode: number;
  parameters?: number[];
  acceptedResponseCodes: number[];
}

interface HostDataCommandRequest {
  operationCode: number;
  bytes: Uint8Array;
  acceptedResponseCodes: number[];
}

class ScriptedCommands implements LiveViewBootstrapCommands {
  readonly calls: string[] = [];
  readonly cameraRequests: CameraCommandRequest[] = [];
  readonly hostRequests: HostDataCommandRequest[] = [];

  constructor(
    private readonly hostResponses: number[],
    private readonly viewfinderResponse = {
      responseCode: 0x2001,
      bytes: new Uint8Array()
    }
  ) {}

  async executeCameraCommand(request: CameraCommandRequest) {
    this.cameraRequests.push(request);
    this.calls.push(`camera:0x${request.operationCode.toString(16)}`);

    if (request.operationCode === 0x9153) {
      return this.viewfinderResponse;
    }

    return { responseCode: 0x2001, bytes: new Uint8Array() };
  }

  async executeHostDataCommand(request: HostDataCommandRequest): Promise<number> {
    this.hostRequests.push(request);
    const propertyCode = new DataView(
      request.bytes.buffer,
      request.bytes.byteOffset,
      request.bytes.byteLength
    ).getUint32(4, true);
    this.calls.push(`host:0x${propertyCode.toString(16)}`);

    const responseCode = this.hostResponses.shift();
    if (responseCode === undefined) {
      throw new Error("No scripted host response");
    }
    return responseCode;
  }
}

describe("LiveViewBootstrap", () => {
  test("starts Canon Live View in validated order and polls events before busy retries", async () => {
    const commands = new ScriptedCommands([
      0x2019,
      0x2001,
      0xa102,
      0x2001,
      0x2019,
      0x2001
    ]);
    const bootstrap = new LiveViewBootstrap(commands, { retryDelayMs: 0 });

    await bootstrap.start();

    expect(commands.calls).toEqual([
      "camera:0x9114",
      "camera:0x9115",
      "camera:0x913d",
      "camera:0x9116",
      "host:0xd11c",
      "camera:0x9116",
      "host:0xd11c",
      "camera:0x911a",
      "camera:0x9116",
      "host:0xd1b1",
      "camera:0x9116",
      "host:0xd1b1",
      "host:0xd1b0",
      "camera:0x9116",
      "host:0xd1b0",
      "camera:0x9116"
    ]);

    expect(commands.cameraRequests[0]).toMatchObject({
      operationCode: 0x9114,
      parameters: [1]
    });
    expect(commands.cameraRequests[1]).toMatchObject({
      operationCode: 0x9115,
      parameters: [1]
    });
    expect(commands.cameraRequests[2]).toMatchObject({
      operationCode: 0x913d,
      parameters: [0x1fff]
    });
    expect(commands.cameraRequests[5]).toMatchObject({
      operationCode: 0x911a,
      parameters: [0x0fffffff, 0x1000, 1]
    });

    for (const eventRequest of [
      commands.cameraRequests[3],
      commands.cameraRequests[4],
      commands.cameraRequests[6],
      commands.cameraRequests[7],
      commands.cameraRequests[8],
      commands.cameraRequests[9]
    ]) {
      expect(eventRequest).toMatchObject({
        operationCode: 0x9116,
        parameters: []
      });
    }

    expect(commands.hostRequests).toHaveLength(6);
    for (const request of commands.hostRequests) {
      expect(request.operationCode).toBe(0x9110);
      expect(request.acceptedResponseCodes).toEqual([0x2001, 0x2019, 0xa102]);
    }

    expectPropertyWrite(commands.hostRequests[0], 0xd11c, 4, 4);
    expectPropertyWrite(commands.hostRequests[1], 0xd11c, 4, 4);
    expectPropertyWrite(commands.hostRequests[2], 0xd1b1, 1, 2);
    expectPropertyWrite(commands.hostRequests[3], 0xd1b1, 1, 2);
    expectPropertyWrite(commands.hostRequests[4], 0xd1b0, 8, 4);
    expectPropertyWrite(commands.hostRequests[5], 0xd1b0, 8, 4);
  });

  test("requests Canon viewfinder data with the Wi-Fi EVF parameters", async () => {
    const response = {
      responseCode: 0xa102,
      bytes: new Uint8Array()
    };
    const commands = new ScriptedCommands([], response);
    const bootstrap = new LiveViewBootstrap(commands, { retryDelayMs: 0 });

    expect(await bootstrap.getViewfinderData()).toEqual(response);
    expect(commands.cameraRequests).toEqual([
      {
        operationCode: 0x9153,
        parameters: [0x00200000, 1, 0],
        acceptedResponseCodes: [0x2001, 0x2019, 0xa102]
      }
    ]);
  });

});

function expectPropertyWrite(
  request: HostDataCommandRequest | undefined,
  propertyCode: number,
  value: number,
  valueByteLength: 2 | 4
): void {
  expect(request).toBeDefined();
  const bytes = request?.bytes ?? new Uint8Array();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  expect(bytes.byteLength).toBe(12);
  expect(view.getUint32(0, true)).toBe(12);
  expect(view.getUint32(4, true)).toBe(propertyCode);
  if (valueByteLength === 2) {
    expect(view.getUint16(8, true)).toBe(value);
    expect(view.getUint16(10, true)).toBe(0);
  } else {
    expect(view.getUint32(8, true)).toBe(value);
  }
}
