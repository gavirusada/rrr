export const CANON_EOS_PROPERTY = {
  APERTURE: 0xd101,
  SHUTTER_SPEED: 0xd102,
  ISO: 0xd103,
  EXPOSURE_COMPENSATION: 0xd104,
  SHOOTING_MODE: 0xd105,
  WHITE_BALANCE_MODE: 0xd105,
  DRIVE_MODE: 0xd106,
  METERING_MODE: 0xd107,
  AF_MODE: 0xd108,
  PICTURE_STYLE: 0xd109,
  WHITE_BALANCE: 0xd10a,
  FLASH_MODE: 0xd10a,
  FLASH_EXPOSURE_COMPENSATION: 0xd10d,
  CAPTURE_DESTINATION: 0xd11c,
  FLASH_FIRING: 0xd138,
  EVF_OUTPUT_DEVICE: 0xd1b0,
  EVF_MODE: 0xd1b1,
  EVF_DOF_PREVIEW: 0xd1b2,
  EVF_SHUTTER_MODE: 0xd1b3,
  MOVIE_RECORD: 0xd1b8
} as const;

export type CanonEosPropertyValueByteLength = 1 | 2 | 4;

export interface CanonPropertyOption {
  value: number;
  label: string;
}

export const CANON_ISO_OPTIONS: readonly CanonPropertyOption[] = [
  { value: 0x00, label: "AUTO" },
  { value: 0x48, label: "ISO 100" },
  { value: 0x50, label: "ISO 200" },
  { value: 0x58, label: "ISO 400" },
  { value: 0x60, label: "ISO 800" },
  { value: 0x68, label: "ISO 1600" },
  { value: 0x70, label: "ISO 3200" },
  { value: 0x78, label: "ISO 6400" }
];

export const CANON_SHUTTER_SPEED_OPTIONS: readonly CanonPropertyOption[] = [
  { value: 0x0c, label: "Bulb" },
  { value: 0x10, label: "30\"" },
  { value: 0x18, label: "15\"" },
  { value: 0x20, label: "8\"" },
  { value: 0x28, label: "4\"" },
  { value: 0x30, label: "2\"" },
  { value: 0x38, label: "1\"" },
  { value: 0x40, label: "0\"5" },
  { value: 0x48, label: "1/4" },
  { value: 0x4b, label: "1/5" },
  { value: 0x4d, label: "1/6" },
  { value: 0x50, label: "1/8" },
  { value: 0x53, label: "1/10" },
  { value: 0x55, label: "1/13" },
  { value: 0x58, label: "1/15" },
  { value: 0x5b, label: "1/20" },
  { value: 0x5d, label: "1/25" },
  { value: 0x60, label: "1/30" },
  { value: 0x63, label: "1/40" },
  { value: 0x65, label: "1/50" },
  { value: 0x68, label: "1/60" },
  { value: 0x6b, label: "1/80" },
  { value: 0x6d, label: "1/100" },
  { value: 0x70, label: "1/125" },
  { value: 0x73, label: "1/160" },
  { value: 0x75, label: "1/200" },
  { value: 0x78, label: "1/250" },
  { value: 0x7b, label: "1/320" },
  { value: 0x7d, label: "1/400" },
  { value: 0x80, label: "1/500" },
  { value: 0x83, label: "1/640" },
  { value: 0x85, label: "1/800" },
  { value: 0x88, label: "1/1000" },
  { value: 0x8b, label: "1/1250" },
  { value: 0x8d, label: "1/1600" },
  { value: 0x90, label: "1/2000" },
  { value: 0x93, label: "1/2500" },
  { value: 0x95, label: "1/3200" },
  { value: 0x98, label: "1/4000" }
];

export const CANON_APERTURE_OPTIONS: readonly CanonPropertyOption[] = [
  { value: 0x18, label: "f/1.8" },
  { value: 0x1d, label: "f/2.2" },
  { value: 0x20, label: "f/2.8" },
  { value: 0x25, label: "f/3.5" },
  { value: 0x28, label: "f/4.0" },
  { value: 0x2b, label: "f/4.5" },
  { value: 0x2d, label: "f/5.0" },
  { value: 0x30, label: "f/5.6" },
  { value: 0x33, label: "f/6.3" },
  { value: 0x35, label: "f/7.1" },
  { value: 0x38, label: "f/8.0" },
  { value: 0x3b, label: "f/9.0" },
  { value: 0x3d, label: "f/10" },
  { value: 0x40, label: "f/11" },
  { value: 0x45, label: "f/14" },
  { value: 0x48, label: "f/16" },
  { value: 0x50, label: "f/22" }
];

export const CANON_EXPOSURE_COMP_OPTIONS: readonly CanonPropertyOption[] = [
  { value: 0xf0, label: "-2.0 EV" },
  { value: 0xf3, label: "-1.7 EV" },
  { value: 0xf4, label: "-1.5 EV" },
  { value: 0xf5, label: "-1.3 EV" },
  { value: 0xf8, label: "-1.0 EV" },
  { value: 0xfb, label: "-0.7 EV" },
  { value: 0xfc, label: "-0.5 EV" },
  { value: 0xfd, label: "-0.3 EV" },
  { value: 0x00, label: "0.0 EV" },
  { value: 0x03, label: "+0.3 EV" },
  { value: 0x04, label: "+0.5 EV" },
  { value: 0x05, label: "+0.7 EV" },
  { value: 0x08, label: "+1.0 EV" },
  { value: 0x0b, label: "+1.3 EV" },
  { value: 0x0c, label: "+1.5 EV" },
  { value: 0x0d, label: "+1.7 EV" },
  { value: 0x10, label: "+2.0 EV" }
];

export const CANON_FLASH_EXPOSURE_COMP_OPTIONS: readonly CanonPropertyOption[] = [
  { value: 0xf0, label: "-2.0 EV" },
  { value: 0xf5, label: "-1.3 EV" },
  { value: 0xf8, label: "-1.0 EV" },
  { value: 0xfd, label: "-0.3 EV" },
  { value: 0x00, label: "0.0 EV" },
  { value: 0x03, label: "+0.3 EV" },
  { value: 0x08, label: "+1.0 EV" },
  { value: 0x0b, label: "+1.3 EV" },
  { value: 0x10, label: "+2.0 EV" }
];

export const CANON_WHITE_BALANCE_OPTIONS: readonly CanonPropertyOption[] = [
  { value: 0, label: "AWB (Auto)" },
  { value: 1, label: "Daylight (5200K)" },
  { value: 2, label: "Cloudy (6000K)" },
  { value: 3, label: "Tungsten (3200K)" },
  { value: 4, label: "Fluorescent (4000K)" },
  { value: 5, label: "Flash (6000K)" },
  { value: 6, label: "Custom WB" },
  { value: 8, label: "Shade (7000K)" }
];

export const CANON_METERING_MODE_OPTIONS: readonly CanonPropertyOption[] = [
  { value: 3, label: "Evaluative Metering" },
  { value: 4, label: "Partial Metering" },
  { value: 5, label: "Center-Weighted Average" }
];

export const CANON_DRIVE_MODE_OPTIONS: readonly CanonPropertyOption[] = [
  { value: 0x00, label: "Single Shooting" },
  { value: 0x01, label: "Continuous Shooting" },
  { value: 0x10, label: "Self-Timer: 10 sec" },
  { value: 0x11, label: "Self-Timer: 2 sec" }
];

export interface CanonShootingPreset {
  id: string;
  name: string;
  description: string;
  iso: number;
  shutterSpeed: number;
  aperture: number;
  exposureComp: number;
  whiteBalance: number;
  meteringMode: number;
  driveMode: number;
  softwareBrightness: number;
  softwareContrast: number;
  lowLightBoost: number;
}

export const CANON_SHOOTING_PRESETS: Record<string, CanonShootingPreset> = {
  manual: {
    id: "manual",
    name: "Manual (M)",
    description: "Balanced studio manual baseline",
    iso: 0x58, // ISO 400
    shutterSpeed: 0x68, // 1/60
    aperture: 0x28, // f/4.0
    exposureComp: 0x00,
    whiteBalance: 0,
    meteringMode: 3,
    driveMode: 0x00,
    softwareBrightness: 100,
    softwareContrast: 100,
    lowLightBoost: 0
  },
  obs_studio: {
    id: "obs_studio",
    name: "OBS Studio Live",
    description: "30fps 180-degree shutter (1/60s, ISO 400, f/3.5, AWB)",
    iso: 0x58, // ISO 400
    shutterSpeed: 0x68, // 1/60
    aperture: 0x25, // f/3.5
    exposureComp: 0x00,
    whiteBalance: 0, // AWB
    meteringMode: 3,
    driveMode: 0x00,
    softwareBrightness: 105,
    softwareContrast: 105,
    lowLightBoost: 0
  },
  portrait: {
    id: "portrait",
    name: "Portrait",
    description: "Shallow depth of field (f/1.8-f/3.5, ISO 200, 1/125s, Daylight WB)",
    iso: 0x50, // ISO 200
    shutterSpeed: 0x70, // 1/125
    aperture: 0x25, // f/3.5
    exposureComp: 0x03, // +0.3 EV
    whiteBalance: 1, // Daylight
    meteringMode: 3,
    driveMode: 0x00,
    softwareBrightness: 104,
    softwareContrast: 98,
    lowLightBoost: 0
  },
  low_light: {
    id: "low_light",
    name: "Low Light / Night",
    description: "High sensitivity & slow shutter (ISO 3200, 1/30s, f/3.5 + Low-Light Boost)",
    iso: 0x70, // ISO 3200
    shutterSpeed: 0x60, // 1/30
    aperture: 0x25, // f/3.5
    exposureComp: 0x05, // +0.7 EV
    whiteBalance: 0,
    meteringMode: 5,
    driveMode: 0x00,
    softwareBrightness: 120,
    softwareContrast: 108,
    lowLightBoost: 35
  },
  sports: {
    id: "sports",
    name: "Sports / Fast Action",
    description: "Fast shutter freeze & continuous drive (1/500s, ISO 1600, Continuous)",
    iso: 0x68, // ISO 1600
    shutterSpeed: 0x80, // 1/500
    aperture: 0x28, // f/4.0
    exposureComp: 0x00,
    whiteBalance: 1,
    meteringMode: 3,
    driveMode: 0x01, // Continuous
    softwareBrightness: 100,
    softwareContrast: 106,
    lowLightBoost: 0
  }
};

export function formatCanonPropertyValue(propertyCode: number, value: number): string {
  const lookup = (options: readonly CanonPropertyOption[]): string | undefined =>
    options.find((opt) => opt.value === value)?.label;

  switch (propertyCode) {
    case CANON_EOS_PROPERTY.ISO:
      return lookup(CANON_ISO_OPTIONS) ?? `0x${value.toString(16)}`;
    case CANON_EOS_PROPERTY.SHUTTER_SPEED:
      return lookup(CANON_SHUTTER_SPEED_OPTIONS) ?? `0x${value.toString(16)}`;
    case CANON_EOS_PROPERTY.APERTURE:
      return lookup(CANON_APERTURE_OPTIONS) ?? `0x${value.toString(16)}`;
    case CANON_EOS_PROPERTY.EXPOSURE_COMPENSATION:
      return lookup(CANON_EXPOSURE_COMP_OPTIONS) ?? `0x${value.toString(16)}`;
    case CANON_EOS_PROPERTY.FLASH_EXPOSURE_COMPENSATION:
      return lookup(CANON_FLASH_EXPOSURE_COMP_OPTIONS) ?? `0x${value.toString(16)}`;
    case CANON_EOS_PROPERTY.WHITE_BALANCE:
      return lookup(CANON_WHITE_BALANCE_OPTIONS) ?? `0x${value.toString(16)}`;
    case CANON_EOS_PROPERTY.METERING_MODE:
      return lookup(CANON_METERING_MODE_OPTIONS) ?? `0x${value.toString(16)}`;
    case CANON_EOS_PROPERTY.DRIVE_MODE:
      return lookup(CANON_DRIVE_MODE_OPTIONS) ?? `0x${value.toString(16)}`;
    default:
      return `0x${value.toString(16)}`;
  }
}

export function createCanonEosPropertyValuePayload(
  propertyCode: number,
  value: number,
  valueByteLength: number
): Uint8Array {
  if (valueByteLength !== 1 && valueByteLength !== 2 && valueByteLength !== 4) {
    throw new Error(`Unsupported Canon property value byte length: ${valueByteLength}`);
  }

  const payload = new Uint8Array(12);
  const view = new DataView(payload.buffer);
  view.setUint32(0, payload.byteLength, true);
  view.setUint32(4, propertyCode, true);

  if (valueByteLength === 1) {
    view.setUint8(8, value & 0xff);
  } else if (valueByteLength === 2) {
    view.setUint16(8, value & 0xffff, true);
  } else {
    view.setUint32(8, value >>> 0, true);
  }

  return payload;
}
