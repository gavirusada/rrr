import {
  CANON_EOS_PROPERTY,
  createCanonEosPropertyValuePayload,
  type CanonEosPropertyValueByteLength
} from "./canonProperties";

export const CANON_EOS_OPERATION = {
  GET_STORAGE_IDS: 0x9101,
  GET_STORAGE_INFO: 0x9102,
  GET_OBJECT_INFO: 0x9103,
  GET_OBJECT: 0x9104,
  REMOTE_RELEASE: 0x910f,
  SET_DEVICE_PROP_VALUE_EX: 0x9110,
  SET_REMOTE_MODE: 0x9114,
  SET_EVENT_MODE: 0x9115,
  GET_EVENT: 0x9116,
  SET_PC_CONNECT_MODE: 0x911a,
  SET_UI_LOCK: 0x911b,
  RESET_UI_LOCK: 0x911c,
  REMOTE_RELEASE_ON: 0x9128,
  REMOTE_RELEASE_OFF: 0x9129,
  GET_PARTIAL_OBJECT: 0x912c,
  GET_THUMBNAIL_EX: 0x9136,
  SET_CAPACITY: 0x913d,
  GET_VIEWFINDER_DATA: 0x9153,
  DO_AF: 0x9154,
  DRIVE_LENS: 0x9155,
  GET_VIEWFINDER_OSD: 0x9156,
  CANCEL_AF: 0x9160
} as const;

export const CANON_LENS_DRIVE_STEP = {
  NEAR_1: 0x0001,
  NEAR_2: 0x0002,
  NEAR_3: 0x0003,
  FAR_1: 0x8001,
  FAR_2: 0x8002,
  FAR_3: 0x8003
} as const;

export const CANON_EVF_OUTPUT = {
  OFF: 0,
  TFT_LCD: 1,
  PC: 2,
  TFT_AND_PC: 3,
  WIFI_PC: 8,
  WIFI_AND_LCD: 9
} as const;

export { CANON_EOS_PROPERTY };

export interface CanonEosPropertyWrite {
  propertyCode: number;
  value: number;
  valueByteLength: 2 | 4;
}

const JPEG_BLOB_TYPES = new Set([1, 9, 11]);
const SCREEN_BLOB_TYPES = new Set([1, 2, 6, 8, 9, 11, 12, 14]);

export function createCanonEosLiveViewStartWrites(
  currentMode: number,
  currentOutputDevice: number,
  requestedOutputMask: number
): CanonEosPropertyWrite[] {
  const writes: CanonEosPropertyWrite[] = [];

  if (currentMode === 0) {
    writes.push({
      propertyCode: CANON_EOS_PROPERTY.EVF_MODE,
      value: 1,
      valueByteLength: 2
    });
  }

  writes.push({
    propertyCode: CANON_EOS_PROPERTY.EVF_OUTPUT_DEVICE,
    value: currentOutputDevice | requestedOutputMask,
    valueByteLength: 4
  });

  return writes;
}

export function createCanonEosLiveViewStopWrites(): CanonEosPropertyWrite[] {
  return [
    {
      propertyCode: CANON_EOS_PROPERTY.EVF_OUTPUT_DEVICE,
      value: CANON_EVF_OUTPUT.OFF,
      valueByteLength: 4
    },
    {
      propertyCode: CANON_EOS_PROPERTY.EVF_MODE,
      value: 0,
      valueByteLength: 2
    }
  ];
}

export function createCanonEosPropertyPayload(
  propertyCode: number,
  value: number,
  valueByteLength: CanonEosPropertyValueByteLength
): Uint8Array {
  return createCanonEosPropertyValuePayload(propertyCode, value, valueByteLength);
}

export function extractCanonEosJpeg(frame: Uint8Array): Uint8Array {
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  let offset = 0;

  while (offset < frame.byteLength) {
    if (frame.byteLength - offset < 8) {
      throw new Error("Malformed Canon EOS viewfinder blob");
    }

    const byteLength = view.getUint32(offset, true);
    const type = view.getUint32(offset + 4, true);
    if (byteLength < 8 || offset + byteLength > frame.byteLength) {
      throw new Error("Malformed Canon EOS viewfinder blob");
    }

    if (JPEG_BLOB_TYPES.has(type)) {
      const candidate = frame.slice(offset + 8, offset + byteLength);
      if (
        candidate.byteLength >= 4 &&
        candidate[0] === 0xff &&
        candidate[1] === 0xd8 &&
        candidate[candidate.byteLength - 2] === 0xff &&
        candidate[candidate.byteLength - 1] === 0xd9
      ) {
        return candidate;
      }
    }

    offset += byteLength;
  }

  throw new Error("Canon EOS viewfinder response did not contain a valid JPEG");
}

/**
 * Extracts a JPEG from either a standard Canon viewfinder blob (0x9153),
 * an OSD/screen capture blob (0x9153 with OSD params, 0x9156, 0x9136, 0x912C),
 * or a raw payload containing an embedded SOI (0xFFD8) .. EOI (0xFFD9) JPEG stream.
 */
export function extractCanonEosScreenOrJpeg(frame: Uint8Array): Uint8Array | null {
  try {
    return extractCanonEosJpeg(frame);
  } catch {
    // Fallback 1: check structured Canon blob headers with extended screen blob types
    if (frame.byteLength >= 12) {
      const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
      let offset = 0;
      while (offset + 8 <= frame.byteLength) {
        const byteLength = view.getUint32(offset, true);
        const type = view.getUint32(offset + 4, true);
        if (byteLength < 8 || offset + byteLength > frame.byteLength) {
          break;
        }
        if (SCREEN_BLOB_TYPES.has(type)) {
          const payload = frame.slice(offset + 8, offset + byteLength);
          const embedded = findEmbeddedJpeg(payload);
          if (embedded !== null) {
            return embedded;
          }
        }
        offset += byteLength;
      }
    }

    // Fallback 2: scan raw bytes for JPEG SOI..EOI (used by 0x9136 / 0x912C / raw thumbnail responses)
    return findEmbeddedJpeg(frame);
  }
}

function findEmbeddedJpeg(bytes: Uint8Array): Uint8Array | null {
  if (bytes.byteLength < 4) {
    return null;
  }

  let start = -1;
  for (let i = 0; i < bytes.byteLength - 1; i += 1) {
    if (bytes[i] === 0xff && bytes[i + 1] === 0xd8) {
      start = i;
      break;
    }
  }
  if (start === -1) {
    return null;
  }

  for (let j = bytes.byteLength - 2; j > start + 1; j -= 1) {
    if (bytes[j] === 0xff && bytes[j + 1] === 0xd9) {
      return bytes.slice(start, j + 2);
    }
  }

  return null;
}
