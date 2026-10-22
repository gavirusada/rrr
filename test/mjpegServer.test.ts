import { describe, expect, test } from "bun:test";
import {
  createMjpegResponse,
  createRemoteWatchPage,
  createServerStatus,
  createStatusPage,
  createStudioControlPage
} from "../src/server/mjpegServer";

describe("createMjpegResponse", () => {
  test("builds an MJPEG multipart response with jpeg content", async () => {
    const response = createMjpegResponse(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), "frame");

    expect(response.headers.get("content-type")).toBe("multipart/x-mixed-replace; boundary=frame");

    const body = await response.text();
    expect(body).toContain("--frame");
    expect(body).toContain("Content-Type: image/jpeg");
    expect(body).toContain("Content-Length: 4");
  });
});

describe("status and studio control pages", () => {
  test("builds public stream status from observable frame source", () => {
    expect(
      createServerStatus(
        {
          latestFrame: () => null,
          async *frames() {},
          stats: () => ({
            averageFrameBytes: 98_000,
            error: null,
            fps: 12.5,
            height: 320,
            lastFrameAt: new Date("2026-06-18T12:00:00.000Z"),
            status: "streaming",
            totalFrames: 120,
            width: 480
          })
        },
        "127.0.0.1",
        8787
      )
    ).toMatchObject({
      frame: {
        fps: 12.5,
        status: "streaming",
        width: 480
      },
      snapshotUrl: "http://127.0.0.1:8787/snapshot.jpg",
      streamUrl: "http://127.0.0.1:8787/live.mjpg"
    });
  });

  test("renders the local preview page", () => {
    const html = createStatusPage();

    expect(html).toContain("/status.json");
    expect(html).toContain("/snapshot.jpg");
    expect(html).toContain("Rivet");
    expect(html).toContain("Gaviru E400D Cam");
  });

  test("renders the Gaviru E400D Cam Studio Web Control Panel with EVF toggle, Cam LCD Display toggle, OSD Screen mode, Portrait 9:16, and Cloud Tunnel", () => {
    const controlHtml = createStudioControlPage();

    expect(controlHtml).toContain("Gaviru E400D Cam");
    expect(controlHtml).toContain("Live View Preview: ON");
    expect(controlHtml).toContain("Cam Display:");
    expect(controlHtml).toContain("/api/display/toggle");
    expect(controlHtml).toContain("Camera Screen / Menu Preview (Photo OSD Mode)");
    expect(controlHtml).toContain("Portrait 9:16");
    expect(controlHtml).toContain("/api/tunnel/start");
    expect(controlHtml).toContain("0x910F");
  });

  test("renders the WebRTC Remote Watcher page", () => {
    const watchHtml = createRemoteWatchPage();

    expect(watchHtml).toContain("Gaviru E400D Cam");
    expect(watchHtml).toContain("WebRTC");
    expect(watchHtml).toContain("/stream");
  });
});
