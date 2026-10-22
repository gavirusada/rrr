import { describe, expect, test } from "bun:test";
import { parseArgs, usage } from "../src/config";

describe("parseArgs", () => {
  test("parses required camera ip with defaults", () => {
    expect(parseArgs(["--camera-ip", "192.168.1.45"])).toEqual({
      cameraIp: "192.168.1.45",
      cameraPort: 15740,
      listenHost: "127.0.0.1",
      listenPort: 8787,
      discover: false,
      discoverTimeoutMs: 3000,
      describe: false,
      cameraPropsWatchSeconds: null,
      interfaces: false,
      init: false,
      mtpSmoke: false,
      probeOnly: false,
      serveMjpeg: false
    });
  });

  test("parses explicit ports and probe mode", () => {
    expect(
      parseArgs([
        "--camera-ip",
        "10.0.0.12",
        "--local-address",
        "10.0.0.30",
        "--camera-port",
        "15741",
        "--listen-host",
        "0.0.0.0",
        "--listen-port",
        "9000",
        "--probe-only"
      ])
    ).toEqual({
      cameraIp: "10.0.0.12",
      cameraPort: 15741,
      localAddress: "10.0.0.30",
      listenHost: "0.0.0.0",
      listenPort: 9000,
      discover: false,
      discoverTimeoutMs: 3000,
      describe: false,
      cameraPropsWatchSeconds: null,
      interfaces: false,
      init: false,
      mtpSmoke: false,
      probeOnly: true,
      serveMjpeg: false
    });
  });

  test("rejects missing camera ip", () => {
    expect(() => parseArgs([])).toThrow("Missing required --camera-ip");
  });

  test("allows discovery without a camera ip", () => {
    expect(parseArgs(["--discover", "--local-address", "192.168.1.10", "--discover-timeout-ms", "60000"])).toEqual({
      cameraPort: 15740,
      localAddress: "192.168.1.10",
      listenHost: "127.0.0.1",
      listenPort: 8787,
      discover: true,
      discoverTimeoutMs: 60000,
      describe: false,
      cameraPropsWatchSeconds: null,
      interfaces: false,
      init: false,
      mtpSmoke: false,
      probeOnly: false,
      serveMjpeg: false
    });
  });

  test("allows interface listing without a camera ip", () => {
    expect(parseArgs(["--interfaces"])).toEqual({
      cameraPort: 15740,
      listenHost: "127.0.0.1",
      listenPort: 8787,
      discover: false,
      discoverTimeoutMs: 3000,
      describe: false,
      cameraPropsWatchSeconds: null,
      interfaces: true,
      init: false,
      mtpSmoke: false,
      probeOnly: false,
      serveMjpeg: false
    });
  });

  test("parses MTP smoke mode", () => {
    expect(parseArgs(["--camera-ip", "192.168.1.2", "--mtp-smoke"])).toMatchObject({
      cameraIp: "192.168.1.2",
      mtpSmoke: true,
      serveMjpeg: false
    });
  });

  test("parses MJPEG serve mode", () => {
    expect(
      parseArgs([
        "--camera-ip",
        "192.168.1.2",
        "--local-address",
        "192.168.1.10",
        "--serve-mjpeg"
      ])
    ).toMatchObject({
      cameraIp: "192.168.1.2",
      localAddress: "192.168.1.10",
      serveMjpeg: true
    });
  });

  test("parses camera property watch mode", () => {
    expect(
      parseArgs([
        "--camera-ip",
        "192.168.1.2",
        "--local-address",
        "192.168.1.10",
        "--camera-props-watch",
        "15"
      ])
    ).toMatchObject({
      cameraIp: "192.168.1.2",
      localAddress: "192.168.1.10",
      cameraPropsWatchSeconds: 15
    });
  });

  test("rejects invalid ports", () => {
    expect(() => parseArgs(["--camera-ip", "192.168.1.45", "--listen-port", "abc"])).toThrow(
      "Invalid --listen-port"
    );
  });
});

describe("usage", () => {
  test("documents MJPEG serve mode", () => {
    expect(usage()).toContain("--serve-mjpeg");
  });

  test("documents property diagnostics", () => {
    expect(usage()).toContain("--camera-props-watch");
  });
});
