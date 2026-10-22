import { describe, expect, test } from "bun:test";
import type { FrameSource, VideoFrame } from "../src/canon/frameSource";
import { SharedFrameSource } from "../src/canon/sharedFrameSource";

describe("SharedFrameSource", () => {
  test("starts capture eagerly and shares the latest frame", async () => {
    const frame: VideoFrame = {
      bytes: jpegWithSize(480, 320),
      contentType: "image/jpeg",
      capturedAt: new Date("2026-06-12T00:00:00.000Z")
    };
    let starts = 0;
    const upstream: FrameSource = {
      latestFrame: () => null,
      async *frames(signal) {
        starts += 1;
        yield frame;
        while (!signal.aborted) {
          await new Promise((resolve) => setTimeout(resolve, 1));
        }
      }
    };

    const shared = new SharedFrameSource(upstream, {
      now: () => frame.capturedAt.getTime()
    });
    await waitUntil(() => shared.latestFrame() !== null);
    const controller = new AbortController();
    const result = await shared.frames(controller.signal)[Symbol.asyncIterator]().next();
    controller.abort();

    expect(starts).toBe(1);
    expect(result.value).toEqual(frame);
    expect(shared.latestFrame()).toEqual(frame);
    expect(shared.stats()).toMatchObject({
      averageFrameBytes: frame.bytes.byteLength,
      height: 320,
      status: "streaming",
      totalFrames: 1,
      width: 480
    });
    shared.close();
  });
});

function jpegWithSize(width: number, height: number): Uint8Array {
  return new Uint8Array([
    0xff, 0xd8,
    0xff, 0xc0,
    0x00, 0x0b,
    0x08,
    height >> 8, height & 0xff,
    width >> 8, width & 0xff,
    0x01, 0x01, 0x11, 0x00,
    0xff, 0xd9
  ]);
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("Timed out waiting for shared frame");
}
