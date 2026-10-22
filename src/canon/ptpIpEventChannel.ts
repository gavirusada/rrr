import type { MtpPayloadTransport } from "./mtpSession";
import { createInitEventRequest, parseInitEventAck } from "./ptpIpPackets";

export class PtpIpEventChannel {
  constructor(private readonly transport: MtpPayloadTransport) {}

  async initialize(connectionNumber: number): Promise<void> {
    await this.transport.writePayload(createInitEventRequest(connectionNumber));
    parseInitEventAck(await this.transport.readPayload());
  }

  close(): void {
    this.transport.close();
  }
}
