import { afterEach, describe, expect, test } from "bun:test";
import { probePtpIp } from "../src/canon/ptpIpProbe";

const servers: Array<{ stop: () => void | Promise<void> }> = [];

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop();
    await server?.stop();
  }
});

describe("probePtpIp", () => {
  test("reports reachable when a TCP connection opens", async () => {
    const server = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        open(socket) {
          socket.end();
        },
        data() {}
      }
    });
    servers.push(server);

    const result = await probePtpIp("127.0.0.1", server.port, 500);

    expect(result.reachable).toBe(true);
    expect(result.host).toBe("127.0.0.1");
    expect(result.port).toBe(server.port);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  test("reports unreachable when the connection fails", async () => {
    const result = await probePtpIp("127.0.0.1", 9, 100);

    expect(result.reachable).toBe(false);
    expect(result.error).toBeString();
  });
});
