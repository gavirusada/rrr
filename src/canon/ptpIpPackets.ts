export const PTP_IP_PACKET = {
  INIT_COMMAND_REQUEST: 0x00000001,
  INIT_COMMAND_ACK: 0x00000002,
  INIT_EVENT_REQUEST: 0x00000003,
  INIT_EVENT_ACK: 0x00000004
} as const;

export interface InitCommandAck {
  connectionNumber: number;
  cameraGuid: string;
  cameraName: string;
  versionMajor: number;
  versionMinor: number;
}

export function createInitCommandRequest(clientGuid: Uint8Array, clientName: string): Uint8Array {
  return createInitCommandRequestWithVersion(clientGuid, clientName, 0x00010000);
}

export function createInitCommandRequestWithVersion(
  clientGuid: Uint8Array,
  clientName: string,
  hostVersion: number
): Uint8Array {
  if (clientGuid.byteLength !== 16) {
    throw new Error("Client GUID must be exactly 16 bytes");
  }

  const encodedName = new TextEncoder().encode(`${clientName}\0`);
  const utf16Name = new Uint8Array(encodedName.byteLength * 2);
  for (let index = 0; index < encodedName.byteLength; index += 1) {
    utf16Name[index * 2] = encodedName[index] ?? 0;
  }

  const length = 4 + clientGuid.byteLength + utf16Name.byteLength + 4;
  const packet = new Uint8Array(length);
  const view = new DataView(packet.buffer);

  view.setUint32(0, PTP_IP_PACKET.INIT_COMMAND_REQUEST, true);
  packet.set(clientGuid, 4);
  packet.set(utf16Name, 20);
  view.setUint32(20 + utf16Name.byteLength, hostVersion, true);

  return packet;
}

export function createFramedPayload(payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(payload.byteLength + 4);
  const view = new DataView(frame.buffer);
  view.setUint32(0, frame.byteLength, true);
  frame.set(payload, 4);
  return frame;
}

export function createInitEventRequest(connectionNumber: number): Uint8Array {
  const packet = new Uint8Array(8);
  const view = new DataView(packet.buffer);
  view.setUint32(0, PTP_IP_PACKET.INIT_EVENT_REQUEST, true);
  view.setUint32(4, connectionNumber, true);
  return packet;
}

export function parseInitCommandAck(payload: Uint8Array): InitCommandAck {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const packetType = view.getUint32(0, true);
  if (packetType !== PTP_IP_PACKET.INIT_COMMAND_ACK) {
    throw new Error(`Unexpected packet type: ${packetType}`);
  }

  const connectionNumber = view.getUint32(4, true);
  const cameraGuid = [...payload.slice(8, 24)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const versionOffset = payload.byteLength - 4;
  const cameraName = decodeUtf16NullTerminated(payload.slice(24, versionOffset));

  return {
    connectionNumber,
    cameraGuid,
    cameraName,
    versionMajor: view.getUint16(versionOffset, true),
    versionMinor: view.getUint16(versionOffset + 2, true)
  };
}

export function parseInitEventAck(payload: Uint8Array): void {
  const packetType = new DataView(
    payload.buffer,
    payload.byteOffset,
    payload.byteLength
  ).getUint32(0, true);
  if (packetType !== PTP_IP_PACKET.INIT_EVENT_ACK) {
    throw new Error(`Unexpected packet type: ${packetType}`);
  }
}

function decodeUtf16NullTerminated(bytes: Uint8Array): string {
  const chars: number[] = [];

  for (let offset = 0; offset + 1 < bytes.byteLength; offset += 2) {
    const code = bytes[offset] ?? 0;
    const high = bytes[offset + 1] ?? 0;
    const charCode = code | (high << 8);
    if (charCode === 0) {
      break;
    }

    chars.push(charCode);
  }

  return String.fromCharCode(...chars);
}
