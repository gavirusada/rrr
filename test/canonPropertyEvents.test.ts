import { describe, expect, test } from "bun:test";
import {
  CANON_EOS_EVENT,
  parseCanonEosPropertyEvents
} from "../src/canon/canonPropertyEvents";
import { CANON_EOS_PROPERTY } from "../src/canon/canonProperties";

describe("Canon EOS property event parser", () => {
  test("parses value-changed events", () => {
    const events = parseCanonEosPropertyEvents(
      concat(
        valueChangedEvent(CANON_EOS_PROPERTY.ISO, 0x58),
        endEvent()
      )
    );

    expect(events).toEqual([
      {
        type: CANON_EOS_EVENT.VALUE_CHANGED,
        propertyCode: CANON_EOS_PROPERTY.ISO,
        value: 0x58
      }
    ]);
  });

  test("parses allowed-values-changed events", () => {
    const events = parseCanonEosPropertyEvents(
      concat(
        allowedValuesChangedEvent(CANON_EOS_PROPERTY.APERTURE, [0x15, 0x18, 0x1b]),
        endEvent()
      )
    );

    expect(events).toEqual([
      {
        type: CANON_EOS_EVENT.ALLOWED_VALUES_CHANGED,
        propertyCode: CANON_EOS_PROPERTY.APERTURE,
        values: [0x15, 0x18, 0x1b]
      }
    ]);
  });

  test("parses empty allowed-values lists", () => {
    const events = parseCanonEosPropertyEvents(
      concat(
        allowedValuesChangedEvent(CANON_EOS_PROPERTY.SHUTTER_SPEED, []),
        endEvent()
      )
    );

    expect(events).toEqual([
      {
        type: CANON_EOS_EVENT.ALLOWED_VALUES_CHANGED,
        propertyCode: CANON_EOS_PROPERTY.SHUTTER_SPEED,
        values: []
      }
    ]);
  });

  test("ignores unknown events and stops at end marker", () => {
    const events = parseCanonEosPropertyEvents(
      concat(
        unknownEvent(0xc199),
        endEvent(),
        valueChangedEvent(CANON_EOS_PROPERTY.ISO, 0x60)
      )
    );

    expect(events).toEqual([]);
  });

  test("rejects truncated events", () => {
    expect(() => parseCanonEosPropertyEvents(new Uint8Array([12, 0, 0, 0, 0x89]))).toThrow(
      "Malformed Canon EOS property event"
    );
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

function unknownEvent(type: number): Uint8Array {
  const event = new Uint8Array(12);
  const view = new DataView(event.buffer);
  view.setUint32(0, event.byteLength, true);
  view.setUint32(4, type, true);
  view.setUint32(8, 0, true);
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
