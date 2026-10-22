export const MTP_TCP_PAYLOAD = {
  COMMAND_REQUEST: 0x00000006,
  COMMAND_RESPONSE: 0x00000007,
  DATA_START: 0x00000009,
  DATA_PAYLOAD: 0x0000000a,
  DATA_PAYLOAD_LAST: 0x0000000c
} as const;

export const MTP_DATA_DIRECTION = {
  CAMERA_TO_HOST_OR_NONE: 0x00000001,
  HOST_TO_CAMERA: 0x00000002
} as const;

export const MTP_OPERATION = {
  GET_DEVICE_INFO: 0x1001,
  OPEN_SESSION: 0x1002,
  START_LIVE_VIEW: 0x9201,
  END_LIVE_VIEW: 0x9202,
  GET_LIVE_VIEW_IMAGE: 0x9203
} as const;

export const MTP_RESPONSE = {
  OK: 0x2001
} as const;

export interface MtpCommandRequest {
  operationCode: number;
  transactionId: number;
  dataDirection?: number;
  parameters?: number[];
}

export interface MtpCommandResponse {
  responseCode: number;
  transactionId: number;
  parameters: number[];
}

export interface ParsedMtpCommandRequest {
  operationCode: number;
  transactionId: number;
  dataDirection: number;
  parameters: number[];
}

export interface MtpDataStart {
  transactionId: number;
  byteLength: number;
}

export interface MtpDataPayload {
  transactionId: number;
  bytes: Uint8Array;
  isLast: boolean;
}

export function createMtpCommandRequest(request: MtpCommandRequest): Uint8Array {
  const parameters = request.parameters ?? [];
  const payload = new Uint8Array(14 + parameters.length * 4);
  const view = new DataView(payload.buffer);

  view.setUint32(0, MTP_TCP_PAYLOAD.COMMAND_REQUEST, true);
  view.setUint32(4, request.dataDirection ?? MTP_DATA_DIRECTION.CAMERA_TO_HOST_OR_NONE, true);
  view.setUint16(8, request.operationCode, true);
  view.setUint32(10, request.transactionId, true);

  parameters.forEach((parameter, index) => {
    view.setUint32(14 + index * 4, parameter, true);
  });

  return payload;
}

export function createMtpDataStart(transactionId: number, byteLength: number): Uint8Array {
  const payload = new Uint8Array(16);
  const view = new DataView(payload.buffer);
  view.setUint32(0, MTP_TCP_PAYLOAD.DATA_START, true);
  view.setUint32(4, transactionId, true);
  view.setBigUint64(8, BigInt(byteLength), true);
  return payload;
}

export function createMtpDataPayload(
  transactionId: number,
  bytes: Uint8Array,
  isLast: boolean
): Uint8Array {
  const payload = new Uint8Array(8 + bytes.byteLength);
  const view = new DataView(payload.buffer);
  view.setUint32(
    0,
    isLast ? MTP_TCP_PAYLOAD.DATA_PAYLOAD_LAST : MTP_TCP_PAYLOAD.DATA_PAYLOAD,
    true
  );
  view.setUint32(4, transactionId, true);
  payload.set(bytes, 8);
  return payload;
}

export function parseMtpCommandRequest(payload: Uint8Array): ParsedMtpCommandRequest {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const payloadType = view.getUint32(0, true);
  if (payloadType !== MTP_TCP_PAYLOAD.COMMAND_REQUEST) {
    throw new Error(`Unexpected MTP payload type: ${payloadType}`);
  }

  const parameters: number[] = [];
  for (let offset = 14; offset + 3 < payload.byteLength; offset += 4) {
    parameters.push(view.getUint32(offset, true));
  }

  return {
    operationCode: view.getUint16(8, true),
    transactionId: view.getUint32(10, true),
    dataDirection: view.getUint32(4, true),
    parameters
  };
}

export function parseMtpCommandResponse(payload: Uint8Array): MtpCommandResponse {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const payloadType = view.getUint32(0, true);
  if (payloadType !== MTP_TCP_PAYLOAD.COMMAND_RESPONSE) {
    throw new Error(`Unexpected MTP payload type: ${payloadType}`);
  }

  const responseCode = view.getUint16(4, true);
  const transactionId = view.getUint32(6, true);
  const parameters: number[] = [];

  for (let offset = 10; offset + 3 < payload.byteLength; offset += 4) {
    parameters.push(view.getUint32(offset, true));
  }

  return { responseCode, transactionId, parameters };
}

export function parseMtpDataStart(payload: Uint8Array): MtpDataStart {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const payloadType = view.getUint32(0, true);
  if (payloadType !== MTP_TCP_PAYLOAD.DATA_START) {
    throw new Error(`Unexpected MTP payload type: ${payloadType}`);
  }

  return {
    transactionId: view.getUint32(4, true),
    byteLength: view.getUint32(8, true)
  };
}

export function parseMtpDataPayload(payload: Uint8Array): MtpDataPayload {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const payloadType = view.getUint32(0, true);
  if (payloadType !== MTP_TCP_PAYLOAD.DATA_PAYLOAD && payloadType !== MTP_TCP_PAYLOAD.DATA_PAYLOAD_LAST) {
    throw new Error(`Unexpected MTP payload type: ${payloadType}`);
  }

  return {
    transactionId: view.getUint32(4, true),
    bytes: payload.slice(8),
    isLast: payloadType === MTP_TCP_PAYLOAD.DATA_PAYLOAD_LAST
  };
}
