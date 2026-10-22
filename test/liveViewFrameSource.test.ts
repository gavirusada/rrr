import { describe, expect, test } from "bun:test";
import { CanonLiveViewFrameSource } from "../src/canon/liveViewFrameSource";

const OK = 0x2001;
const OBJECT_NOT_READY = 0xa102;

describe("CanonLiveViewFrameSource", () => {
  test("retries ObjectNotReady and publishes the next valid JPEG", async () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 1, 2, 0xff, 0xd9]);
    const responses = [
      { responseCode: OBJECT_NOT_READY, bytes: new Uint8Array() },
      { responseCode: OK, bytes: canonBlob(1, jpeg) }
    ];
    let eventPolls = 0;
    let frameRequests = 0;
    const capturedAt = new Date("2026-06-12T12:00:00.000Z");
    const source = new CanonLiveViewFrameSource({
      async pollEvents() {
        eventPolls += 1;
      },
      async getViewfinderData() {
        frameRequests += 1;
        const response = responses.shift();
        if (response === undefined) {
          throw new Error("No scripted Canon response");
        }
        return response;
      },
      retryDelayMs: 0,
      now: () => capturedAt
    });
    const controller = new AbortController();

    const iterator = source.frames(controller.signal)[Symbol.asyncIterator]();
    const result = await iterator.next();
    controller.abort();

    expect(result).toEqual({
      done: false,
      value: {
        bytes: jpeg,
        contentType: "image/jpeg",
        capturedAt
      }
    });
    expect(source.latestFrame()).toEqual(result.value);
    expect(frameRequests).toBe(2);
    expect(eventPolls).toBe(1);
  });

  test("executes queued commands strictly between GetViewFinderData frames", async () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 4, 5, 0xff, 0xd9]);
    const executionOrder: string[] = [];
    const source = new CanonLiveViewFrameSource({
      async pollEvents() {},
      async getViewfinderData() {
        executionOrder.push("frame");
        return { responseCode: OK, bytes: canonBlob(1, jpeg) };
      },
      retryDelayMs: 0
    });

    const queuedPromise = source.enqueueCommand(async () => {
      executionOrder.push("queued-cmd");
      return "done";
    });

    const controller = new AbortController();
    const iterator = source.frames(controller.signal)[Symbol.asyncIterator]();
    await iterator.next();
    controller.abort();

    expect(await queuedPromise).toBe("done");
    expect(executionOrder).toEqual(["queued-cmd", "frame"]);
  });

  test("does not publish malformed viewfinder payloads", async () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 7, 8, 0xff, 0xd9]);
    const responses = [
      { responseCode: OK, bytes: canonBlob(1, new Uint8Array([1, 2, 3])) },
      { responseCode: OK, bytes: canonBlob(9, jpeg) }
    ];
    const source = new CanonLiveViewFrameSource({
      async pollEvents() {},
      async getViewfinderData() {
        const response = responses.shift();
        if (response === undefined) {
          throw new Error("No scripted Canon response");
        }
        return response;
      },
      retryDelayMs: 0
    });
    const controller = new AbortController();

    const iterator = source.frames(controller.signal)[Symbol.asyncIterator]();
    const result = await iterator.next();
    controller.abort();

    expect(result.done).toBe(false);
    expect(result.value?.bytes).toEqual(jpeg);
    expect(source.latestFrame()?.bytes).toEqual(jpeg);
  });

  test("stops polling when the signal is aborted", async () => {
    const controller = new AbortController();
    let frameRequests = 0;
    const source = new CanonLiveViewFrameSource({
      async pollEvents() {},
      async getViewfinderData() {
        frameRequests += 1;
        controller.abort();
        return { responseCode: OBJECT_NOT_READY, bytes: new Uint8Array() };
      },
      retryDelayMs: 0
    });

    const iterator = source.frames(controller.signal)[Symbol.asyncIterator]();

    expect(await iterator.next()).toEqual({ done: true, value: undefined });
    expect(frameRequests).toBe(1);
    expect(source.latestFrame()).toBeNull();
  });
});

function canonBlob(type: number, bytes: Uint8Array): Uint8Array {
  const blob = new Uint8Array(8 + bytes.byteLength);
  const view = new DataView(blob.buffer);
  view.setUint32(0, blob.byteLength, true);
  view.setUint32(4, type, true);
  blob.set(bytes, 8);
  return blob;
}
