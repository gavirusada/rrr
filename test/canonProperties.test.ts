import { describe, expect, test } from "bun:test";
import {
  CANON_EOS_PROPERTY,
  createCanonEosPropertyValuePayload
} from "../src/canon/canonProperties";

describe("Canon EOS property helpers", () => {
  test("creates a 32-bit property value payload", () => {
    expect(createCanonEosPropertyValuePayload(CANON_EOS_PROPERTY.SHUTTER_SPEED, 0x65, 4)).toEqual(
      new Uint8Array([
        12, 0, 0, 0,
        0x02, 0xd1, 0, 0,
        0x65, 0, 0, 0
      ])
    );
  });

  test("creates a 16-bit property value payload", () => {
    expect(createCanonEosPropertyValuePayload(CANON_EOS_PROPERTY.EVF_MODE, 1, 2)).toEqual(
      new Uint8Array([
        12, 0, 0, 0,
        0xb1, 0xd1, 0, 0,
        1, 0, 0, 0
      ])
    );
  });

  test("rejects unsupported byte lengths", () => {
    expect(() => createCanonEosPropertyValuePayload(CANON_EOS_PROPERTY.ISO, 400, 3)).toThrow(
      "Unsupported Canon property value byte length: 3"
    );
  });
});
