export const CANON_EOS_EVENT = {
  END: 0x00000000,
  VALUE_CHANGED: 0x0000c189,
  ALLOWED_VALUES_CHANGED: 0x0000c18a
} as const;

export type CanonEosPropertyEvent =
  | {
      type: typeof CANON_EOS_EVENT.VALUE_CHANGED;
      propertyCode: number;
      value: number;
    }
  | {
      type: typeof CANON_EOS_EVENT.ALLOWED_VALUES_CHANGED;
      propertyCode: number;
      values: number[];
    };

export function parseCanonEosPropertyEvents(bytes: Uint8Array): CanonEosPropertyEvent[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const events: CanonEosPropertyEvent[] = [];
  let offset = 0;

  while (offset < bytes.byteLength) {
    if (bytes.byteLength - offset < 8) {
      throw new Error("Malformed Canon EOS property event");
    }

    const byteLength = view.getUint32(offset, true);
    const type = view.getUint32(offset + 4, true);
    if (byteLength < 8 || offset + byteLength > bytes.byteLength) {
      throw new Error("Malformed Canon EOS property event");
    }

    if (type === CANON_EOS_EVENT.END) {
      break;
    }

    if (type === CANON_EOS_EVENT.VALUE_CHANGED) {
      events.push(parseValueChangedEvent(view, offset, byteLength));
    } else if (type === CANON_EOS_EVENT.ALLOWED_VALUES_CHANGED) {
      events.push(parseAllowedValuesChangedEvent(view, offset, byteLength));
    }

    offset += byteLength;
  }

  return events;
}

function parseValueChangedEvent(
  view: DataView,
  offset: number,
  byteLength: number
): CanonEosPropertyEvent {
  if (byteLength < 16) {
    throw new Error("Malformed Canon EOS property event");
  }

  return {
    type: CANON_EOS_EVENT.VALUE_CHANGED,
    propertyCode: view.getUint32(offset + 8, true),
    value: view.getUint32(offset + 12, true)
  };
}

function parseAllowedValuesChangedEvent(
  view: DataView,
  offset: number,
  byteLength: number
): CanonEosPropertyEvent {
  if (byteLength < 20) {
    throw new Error("Malformed Canon EOS property event");
  }

  const count = view.getUint32(offset + 16, true);
  const expectedLength = 20 + count * 4;
  if (byteLength < expectedLength) {
    throw new Error("Malformed Canon EOS property event");
  }

  const values: number[] = [];
  for (let index = 0; index < count; index += 1) {
    values.push(view.getUint32(offset + 20 + index * 4, true));
  }

  return {
    type: CANON_EOS_EVENT.ALLOWED_VALUES_CHANGED,
    propertyCode: view.getUint32(offset + 8, true),
    values
  };
}
