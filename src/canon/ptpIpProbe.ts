import net from "node:net";

export interface ProbeResult {
  host: string;
  port: number;
  localAddress?: string;
  reachable: boolean;
  latencyMs: number;
  error?: string;
}

export async function probePtpIp(
  host: string,
  port: number,
  timeoutMs = 2000,
  localAddress?: string
): Promise<ProbeResult> {
  const startedAt = performance.now();

  return await new Promise<ProbeResult>((resolve) => {
    const socket = new net.Socket();
    let settled = false;

    const finish = (reachable: boolean, error?: string): void => {
      if (settled) {
        return;
      }

      settled = true;
      socket.destroy();

      const base = {
        host,
        port,
        ...(localAddress === undefined ? {} : { localAddress }),
        reachable,
        latencyMs: Math.max(0, Math.round(performance.now() - startedAt))
      };

      resolve(error === undefined ? base : { ...base, error });
    };

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false, `Timed out after ${timeoutMs}ms`));
    socket.once("error", (error) => finish(false, error.message));
    socket.connect(localAddress === undefined ? { host, port } : { host, port, localAddress });
  });
}
