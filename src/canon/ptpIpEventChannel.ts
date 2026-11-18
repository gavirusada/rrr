import type { MtpPayloadTransport } from "./mtpSession";
import { createInitEventRequest, parseInitEventAck } from "./ptpIpPackets";

export class PtpIpEventChannel {
  private closed = false;

  constructor(private readonly transport: MtpPayloadTransport) {}

  async initialize(connectionNumber: number): Promise<void> {
    await this.transport.writePayload(createInitEventRequest(connectionNumber));
    parseInitEventAck(await this.transport.readPayload());
    this.startEventDrainer();
  }

  private startEventDrainer(): void {
    // Background reader loop: drains event packets from event socket so socket buffer never fills up
    (async () => {
      while (!this.closed) {
        try {
          await this.transport.readPayload();
        } catch {
          break;
        }
      }
    })();
  }

  close(): void {
    this.closed = true;
    try {
      this.transport.close();
    } catch {
      // Ignore
    }
  }
}

