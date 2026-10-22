import {
  CANON_EOS_OPERATION,
  CANON_EOS_PROPERTY,
  createCanonEosPropertyPayload
} from "./canonEos";
import type {
  ExecuteCameraCommandRequest,
  ExecuteCameraCommandResult,
  ExecuteHostDataCommandRequest
} from "./mtpSession";

const OK = 0x2001;
const DEVICE_BUSY = 0x2019;
const NOT_READY = 0xa102;
const ACCEPTED_RESPONSE_CODES = [OK, DEVICE_BUSY, NOT_READY];
const RETRYABLE_RESPONSE_CODES = new Set([DEVICE_BUSY, NOT_READY]);

const SET_CAPACITY = 0x913d;
const SET_PC_CONNECT_MODE = 0x911a;
const CAPACITY_PROPERTY = 0xd11c;

export interface LiveViewBootstrapCommands {
  executeCameraCommand(
    request: ExecuteCameraCommandRequest
  ): Promise<ExecuteCameraCommandResult>;
  executeHostDataCommand(request: ExecuteHostDataCommandRequest): Promise<number>;
}

export interface LiveViewBootstrapOptions {
  retryDelayMs?: number;
  retryTimeoutMs?: number;
}

export class LiveViewBootstrap {
  private readonly retryDelayMs: number;
  private readonly retryTimeoutMs: number;

  constructor(
    private readonly commands: LiveViewBootstrapCommands,
    options: LiveViewBootstrapOptions = {}
  ) {
    this.retryDelayMs = options.retryDelayMs ?? 10;
    this.retryTimeoutMs = options.retryTimeoutMs ?? 5_000;
  }

  async start(): Promise<void> {
    await this.executeCameraCommand(CANON_EOS_OPERATION.SET_REMOTE_MODE, [1]);
    await this.executeCameraCommand(CANON_EOS_OPERATION.SET_EVENT_MODE, [1]);
    await this.executeCameraCommand(SET_CAPACITY, [0x1fff]);
    await this.pollEvents();

    await this.writePropertyWithRetry(CAPACITY_PROPERTY, 4, 4);

    await this.executeCameraCommand(SET_PC_CONNECT_MODE, [0x0fffffff, 0x1000, 1]);
    await this.pollEvents();

    await this.writePropertyWithRetry(CANON_EOS_PROPERTY.EVF_MODE, 1, 2);
    await this.writePropertyWithRetry(CANON_EOS_PROPERTY.EVF_OUTPUT_DEVICE, 8, 4);
    await this.pollEvents();
  }

  async getViewfinderData(): Promise<ExecuteCameraCommandResult> {
    return await this.commands.executeCameraCommand({
      operationCode: CANON_EOS_OPERATION.GET_VIEWFINDER_DATA,
      parameters: [0x00200000, 1, 0],
      acceptedResponseCodes: ACCEPTED_RESPONSE_CODES
    });
  }

  private async executeCameraCommand(operationCode: number, parameters: number[]): Promise<void> {
    const response = await this.commands.executeCameraCommand({
      operationCode,
      parameters,
      acceptedResponseCodes: ACCEPTED_RESPONSE_CODES
    });

    if (response.responseCode !== OK) {
      throw new Error(
        `Canon Live View command 0x${operationCode.toString(16)} failed with response 0x${response.responseCode.toString(16)}`
      );
    }
  }

  private async pollEvents(): Promise<void> {
    await this.executeCameraCommand(CANON_EOS_OPERATION.GET_EVENT, []);
  }

  private async writePropertyWithRetry(
    propertyCode: number,
    value: number,
    valueByteLength: 1 | 2 | 4
  ): Promise<void> {
    const deadline = Date.now() + this.retryTimeoutMs;

    while (true) {
      const responseCode = await this.commands.executeHostDataCommand({
        operationCode: CANON_EOS_OPERATION.SET_DEVICE_PROP_VALUE_EX,
        bytes: createCanonEosPropertyPayload(propertyCode, value, valueByteLength),
        acceptedResponseCodes: ACCEPTED_RESPONSE_CODES
      });

      if (responseCode === OK) {
        return;
      }

      if (!RETRYABLE_RESPONSE_CODES.has(responseCode)) {
        throw new Error(
          `Canon property 0x${propertyCode.toString(16)} failed with response 0x${responseCode.toString(16)}`
        );
      }

      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out writing Canon property 0x${propertyCode.toString(16)} after ${this.retryTimeoutMs}ms`
        );
      }

      await this.pollEvents();
      await delay(Math.min(this.retryDelayMs, Math.max(0, deadline - Date.now())));
    }
  }
}

async function delay(milliseconds: number): Promise<void> {
  if (milliseconds <= 0) {
    return;
  }

  await new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}
