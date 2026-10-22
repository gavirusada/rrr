import { describe, expect, test } from "bun:test";
import { collectCanonPropertyEvents } from "../src/canon/canonPropertyDiagnostics";
import { CANON_EOS_EVENT } from "../src/canon/canonPropertyEvents";
import { CANON_EOS_PROPERTY } from "../src/canon/canonProperties";

class ScriptedCommands {
  readonly requests: Array<{ operationCode: number; parameters?: number[]; acceptedResponseCodes: number[] }> = [];

  constructor(private readonly responses: Uint8Array[]) {}

  async executeCameraCommand(request: {
    operationCode: number;
    parameters?: number[];
    acceptedResponseCodes: number[];
  }): Promise<{ responseCode: number; bytes: Uint8Array }> {
    this.requests.push(request);
    const bytes = this.responses.shift();
    if (bytes === undefined) {
      throw new Error("No scripted response available");
    }

    return { responseCode: 0x2001, bytes };
  }
}

describe("Canon property diagnostics", () => {
  test("collects parsed property events until the deadline", async () => {
    const commands = new ScriptedCommands([
      concat(valueChangedEvent(CANON_EOS_PROPERTY.ISO, 0x58), endEvent()),
      concat(allowedValuesChangedEvent(CANON_EOS_PROPERTY.SHUTTER_SPEED, [0x60, 0x65]), endEvent())
    ]);
    let now = 0;

    const events = await collectCanonPropertyEvents(commands, {
      durationMs: 2,
      pollDelayMs: 1,
      now: () => now,
      delay: async (milliseconds) => {
        now += milliseconds;
      }
    });

    expect(events).toEqual([
      {
        type: CANON_EOS_EVENT.VALUE_CHANGED,
        propertyCode: CANON_EOS_PROPERTY.ISO,
        value: 0x58
      },
      {
        type: CANON_EOS_EVENT.ALLOWED_VALUES_CHANGED,
        propertyCode: CANON_EOS_PROPERTY.SHUTTER_SPEED,
        values: [0x60, 0x65]
      }
    ]);
    expect(commands.requests.map((request) => request.operationCode)).toEqual([0x9116, 0x9116]);
  });

  test("rejects non-OK Canon event responses", async () => {
    const commands = {
      async executeCameraCommand(): Promise<{ responseCode: number; bytes: Uint8Array }> {
        return { responseCode: 0x2019, bytes: new Uint8Array() };
      }
    };

    await expect(
      collectCanonPropertyEvents(commands, {
        durationMs: 1,
        pollDelayMs: 1,
        now: () => 0,
        delay: async () => {}
      })
    ).rejects.toThrow("Canon property event polling failed with response 0x2019");
  });
});

function valueChangedEvent(propertyCode: number, value: number): Uint8Array {
  const event = new Uint8Array(16);
  const view = new DataView(event.buffer);
  view.setUint32(0, event.byteLength, true);
  view.setUint32(4, CANON_EOS_EVENT.VALUE_CHANGED, true);
  view.setUint32(8, propertyCode, true);
  view.setUint32(12, value, true);
  return event;
}

function allowedValuesChangedEvent(propertyCode: number, values: number[]): Uint8Array {
  const event = new Uint8Array(20 + values.length * 4);
  const view = new DataView(event.buffer);
  view.setUint32(0, event.byteLength, true);
  view.setUint32(4, CANON_EOS_EVENT.ALLOWED_VALUES_CHANGED, true);
  view.setUint32(8, propertyCode, true);
  view.setUint32(12, 0, true);
  view.setUint32(16, values.length, true);
  values.forEach((value, index) => {
    view.setUint32(20 + index * 4, value, true);
  });
  return event;
}

function endEvent(): Uint8Array {
  const event = new Uint8Array(8);
  const view = new DataView(event.buffer);
  view.setUint32(0, event.byteLength, true);
  view.setUint32(4, CANON_EOS_EVENT.END, true);
  return event;
}

function concat(...chunks: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}
