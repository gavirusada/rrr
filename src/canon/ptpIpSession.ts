import {
  createInitCommandRequestWithVersion,
  parseInitCommandAck,
  type InitCommandAck
} from "./ptpIpPackets";
import type { MtpPayloadTransport } from "./mtpSession";

const DEFAULT_CLIENT_GUID = new Uint8Array([
  0x43, 0x41, 0x4e, 0x4f, 0x4e, 0x57, 0x49, 0x46,
  0x49, 0x57, 0x45, 0x42, 0x43, 0x41, 0x4d, 0x01
]);

export interface InitializePtpIpOptions {
  clientGuid?: Uint8Array;
  clientName?: string;
  hostVersion?: number;
}

export async function initializePtpIpTransport(
  transport: MtpPayloadTransport,
  options: InitializePtpIpOptions = {}
): Promise<InitCommandAck> {
  await transport.writePayload(
    createInitCommandRequestWithVersion(
      options.clientGuid ?? DEFAULT_CLIENT_GUID,
      options.clientName ?? "CanonWifiWebcam",
      options.hostVersion ?? 0x00010000
    )
  );

  return parseInitCommandAck(await transport.readPayload());
}
