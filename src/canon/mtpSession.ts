import {
  createMtpCommandRequest,
  createMtpDataPayload,
  createMtpDataStart,
  type MtpCommandRequest,
  MTP_DATA_DIRECTION,
  MTP_OPERATION,
  MTP_RESPONSE,
  MTP_TCP_PAYLOAD,
  parseMtpCommandResponse,
  parseMtpDataPayload,
  parseMtpDataStart
} from "./mtpPackets";

export interface MtpPayloadTransport {
  writePayload(payload: Uint8Array): Promise<void>;
  readPayload(): Promise<Uint8Array>;
  close(): void;
}

export interface MtpSessionOptions {
  sessionId?: number;
}

export interface ExecuteCameraCommandRequest {
  operationCode: number;
  parameters?: number[];
  acceptedResponseCodes: number[];
}

export interface ExecuteCameraCommandResult {
  responseCode: number;
  bytes: Uint8Array;
}

export interface ExecuteHostDataCommandRequest {
  operationCode: number;
  bytes: Uint8Array;
  parameters?: number[];
  acceptedResponseCodes: number[];
}

export class MtpSession {
  private transactionId = 1;
  private readonly sessionId: number;

  constructor(private readonly transport: MtpPayloadTransport, options: MtpSessionOptions = {}) {
    this.sessionId = options.sessionId ?? 1;
  }

  async openSession(): Promise<void> {
    await this.executeCommand({
      operationCode: MTP_OPERATION.OPEN_SESSION,
      parameters: [this.sessionId]
    });
  }

  async getDeviceInfo(): Promise<Uint8Array> {
    return await this.executeCommand({
      operationCode: MTP_OPERATION.GET_DEVICE_INFO,
      dataDirection: MTP_DATA_DIRECTION.CAMERA_TO_HOST_OR_NONE
    });
  }

  async startLiveView(): Promise<void> {
    await this.executeCommand({ operationCode: MTP_OPERATION.START_LIVE_VIEW });
  }

  async endLiveView(): Promise<void> {
    await this.executeCommand({ operationCode: MTP_OPERATION.END_LIVE_VIEW });
  }

  async getLiveViewImage(): Promise<Uint8Array> {
    return await this.executeCommand({
      operationCode: MTP_OPERATION.GET_LIVE_VIEW_IMAGE,
      dataDirection: MTP_DATA_DIRECTION.CAMERA_TO_HOST_OR_NONE
    });
  }

  async executeCameraCommand(
    request: ExecuteCameraCommandRequest
  ): Promise<ExecuteCameraCommandResult> {
    const commandRequest: {
      operationCode: number;
      dataDirection: number;
      parameters?: number[];
      acceptedResponseCodes: number[];
    } = {
      operationCode: request.operationCode,
      dataDirection: MTP_DATA_DIRECTION.CAMERA_TO_HOST_OR_NONE,
      acceptedResponseCodes: request.acceptedResponseCodes
    };
    if (request.parameters !== undefined) {
      commandRequest.parameters = request.parameters;
    }

    return await this.executeCameraCommandWithDirection(commandRequest);
  }

  async executeHostDataCommand(request: ExecuteHostDataCommandRequest): Promise<number> {
    const transactionId = this.nextTransactionId();
    const commandRequest: MtpCommandRequest = {
      operationCode: request.operationCode,
      transactionId,
      dataDirection: MTP_DATA_DIRECTION.HOST_TO_CAMERA
    };
    if (request.parameters !== undefined) {
      commandRequest.parameters = request.parameters;
    }

    await this.transport.writePayload(createMtpCommandRequest(commandRequest));
    await this.transport.writePayload(createMtpDataStart(transactionId, request.bytes.byteLength));
    await this.transport.writePayload(createMtpDataPayload(transactionId, request.bytes, true));
    return this.assertAcceptedResponse(
      await this.transport.readPayload(),
      transactionId,
      request.acceptedResponseCodes
    );
  }

  async sendData(operationCode: number, bytes: Uint8Array, parameters: number[] = []): Promise<void> {
    await this.executeHostDataCommand({
      operationCode,
      bytes,
      parameters,
      acceptedResponseCodes: [MTP_RESPONSE.OK]
    });
  }

  close(): void {
    this.transport.close();
  }

  private async executeCommand(request: {
    operationCode: number;
    dataDirection?: number;
    parameters?: number[];
  }): Promise<Uint8Array> {
    const result = await this.executeCameraCommandWithDirection({
      ...request,
      acceptedResponseCodes: [MTP_RESPONSE.OK]
    });
    return result.bytes;
  }

  private async executeCameraCommandWithDirection(request: {
    operationCode: number;
    dataDirection?: number;
    parameters?: number[];
    acceptedResponseCodes: number[];
  }): Promise<ExecuteCameraCommandResult> {
    const transactionId = this.nextTransactionId();

    const commandRequest: MtpCommandRequest = {
      operationCode: request.operationCode,
      transactionId
    };
    if (request.dataDirection !== undefined) {
      commandRequest.dataDirection = request.dataDirection;
    }
    if (request.parameters !== undefined) {
      commandRequest.parameters = request.parameters;
    }

    await this.transport.writePayload(createMtpCommandRequest(commandRequest));

    const firstPayload = await this.transport.readPayload();
    const payloadType = readPayloadType(firstPayload);
    if (payloadType === MTP_TCP_PAYLOAD.COMMAND_RESPONSE) {
      return {
        responseCode: this.assertAcceptedResponse(
          firstPayload,
          transactionId,
          request.acceptedResponseCodes
        ),
        bytes: new Uint8Array()
      };
    }

    if (payloadType !== MTP_TCP_PAYLOAD.DATA_START) {
      throw new Error(`Unexpected MTP payload type: ${payloadType}`);
    }

    const dataStart = parseMtpDataStart(firstPayload);
    if (dataStart.transactionId !== transactionId) {
      throw new Error(`Unexpected MTP data transaction: ${dataStart.transactionId}`);
    }

    const chunks: Uint8Array[] = [];
    let receivedLength = 0;
    let isLast = false;
    while (!isLast) {
      const dataPayload = parseMtpDataPayload(await this.transport.readPayload());
      if (dataPayload.transactionId !== transactionId) {
        throw new Error(`Unexpected MTP data transaction: ${dataPayload.transactionId}`);
      }

      chunks.push(dataPayload.bytes);
      receivedLength += dataPayload.bytes.byteLength;
      isLast = dataPayload.isLast;
    }

    const responseCode = this.assertAcceptedResponse(
      await this.transport.readPayload(),
      transactionId,
      request.acceptedResponseCodes
    );
    const bytes = concatChunks(chunks, receivedLength);
    if (dataStart.byteLength !== receivedLength) {
      throw new Error(`Unexpected MTP data length: expected ${dataStart.byteLength}, got ${receivedLength}`);
    }

    return { responseCode, bytes };
  }

  private nextTransactionId(): number {
    const transactionId = this.transactionId;
    this.transactionId += 1;
    return transactionId;
  }

  private assertAcceptedResponse(
    payload: Uint8Array,
    transactionId: number,
    acceptedResponseCodes: number[]
  ): number {
    const response = parseMtpCommandResponse(payload);
    if (response.transactionId !== transactionId) {
      throw new Error(`Unexpected MTP response transaction: ${response.transactionId}`);
    }

    if (!acceptedResponseCodes.includes(response.responseCode)) {
      throw new Error(`Unexpected MTP response code: 0x${response.responseCode.toString(16)}`);
    }

    return response.responseCode;
  }
}

function readPayloadType(payload: Uint8Array): number {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  return view.getUint32(0, true);
}

function concatChunks(chunks: Uint8Array[], byteLength: number): Uint8Array {
  const output = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return output;
}
