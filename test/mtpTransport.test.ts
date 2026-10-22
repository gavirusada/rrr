import { afterEach, describe, expect, test } from "bun:test";
import { MtpTransport } from "../src/canon/mtpTransport";
import { createFramedPayload } from "../src/canon/ptpIpPackets";

const servers: Array<{ stop: () => void | Promise<void> }> = [];

afterEach(async () => {
  while (servers.length > 0) {
    await servers.pop()?.stop();
  }
});

describe("MtpTransport", () => {
  test("writes framed payloads and reads framed payloads", async () => {
    let received: Uint8Array | undefined;
    const server = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        data(socket, data) {
          received = data;
          socket.write(createFramedPayload(new Uint8Array([9, 8, 7])));
        },
        open() {}
      }
    });
    servers.push(server);

    const transport = new MtpTransport({ host: "127.0.0.1", port: server.port, timeoutMs: 500 });
    await transport.writePayload(new Uint8Array([1, 2, 3]));
    const response = await transport.readPayload();
    transport.close();

    if (received === undefined) {
      throw new Error("Expected the test server to receive one framed request");
    }

    expect(received).toEqual(createFramedPayload(new Uint8Array([1, 2, 3])));
    expect(response).toEqual(new Uint8Array([9, 8, 7]));
  });

});
