import { describe, expect, test } from "bun:test";
import type { FrameSource, VideoFrame } from "../src/canon/frameSource";
import { ReconnectingFrameSource } from "../src/canon/reconnectingFrameSource";

describe("ReconnectingFrameSource", () => {
  test("reconnects after an upstream failure", async () => {
    const first = frame(1);
    const second = frame(2);
    const closed: number[] = [];
    let attempts = 0;
    const source = new ReconnectingFrameSource({
      retryDelayMs: 0,
      async connect() {
        attempts += 1;
        const id = attempts;
        return {
          source: scriptedSource(id === 1 ? first : second, id === 1),
          close() {
            closed.push(id);
          }
        };
      }
    });
    const controller = new AbortController();
    const iterator = source.frames(controller.signal)[Symbol.asyncIterator]();

    expect((await iterator.next()).value).toEqual(first);
    expect((await iterator.next()).value).toEqual(second);
    controller.abort();

    expect(attempts).toBe(2);
    expect(closed).toEqual([1]);
    expect(source.latestFrame()).toEqual(second);
  });
});

function scriptedSource(output: VideoFrame, failAfterFirst: boolean): FrameSource {
  return {
    latestFrame: () => null,
    async *frames() {
      yield output;
      if (failAfterFirst) {
        throw new Error("lost camera");
      }
    }
  };
}

function frame(byte: number): VideoFrame {
  return {
    bytes: new Uint8Array([byte]),
    contentType: "image/jpeg",
    capturedAt: new Date(2026, 5, 18, 12, 0, byte)
  };
}
