import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Generates a valid 64x64 32-bit RGBA Windows .ico file (BMP/DIB inside ICO container)
 * depicting a professional DSLR Camera with a gold-rimmed cyan studio lens.
 */
export function generateStudioIconFile(targetPath: string): void {
  const width = 64;
  const height = 64;
  const pixelDataSize = width * height * 4;
  const maskRowBytes = Math.ceil(width / 32) * 4;
  const maskDataSize = maskRowBytes * height;
  const dibHeaderSize = 40;
  const imageSize = dibHeaderSize + pixelDataSize + maskDataSize;

  const buf = Buffer.alloc(6 + 16 + imageSize, 0);

  // ICO Header (6 bytes)
  buf.writeUInt16LE(0, 0); // Reserved
  buf.writeUInt16LE(1, 2); // Type: 1 = ICO
  buf.writeUInt16LE(1, 4); // Count: 1 image

  // ICO Directory Entry (16 bytes)
  buf.writeUInt8(width, 6);
  buf.writeUInt8(height, 7);
  buf.writeUInt8(0, 8); // Palette count
  buf.writeUInt8(0, 9); // Reserved
  buf.writeUInt16LE(1, 10); // Color planes
  buf.writeUInt16LE(32, 12); // Bits per pixel
  buf.writeUInt32LE(imageSize, 14); // Size of image data
  buf.writeUInt32LE(22, 18); // Offset of image data

  // BITMAPINFOHEADER (40 bytes)
  const dibOffset = 22;
  buf.writeUInt32LE(dibHeaderSize, dibOffset);
  buf.writeInt32LE(width, dibOffset + 4);
  buf.writeInt32LE(height * 2, dibOffset + 8); // Combined height of XOR + AND masks
  buf.writeUInt16LE(1, dibOffset + 12); // Planes
  buf.writeUInt16LE(32, dibOffset + 14); // BitCount
  buf.writeUInt32LE(0, dibOffset + 16); // Compression (BI_RGB)
  buf.writeUInt32LE(pixelDataSize + maskDataSize, dibOffset + 20);

  const pixelsOffset = dibOffset + dibHeaderSize;

  // Draw 64x64 icon (bottom-up rows in DIB format, BGRA byte order)
  for (let y = 0; y < height; y++) {
    const drawY = height - 1 - y; // Top-down Y coordinate (0..63)
    for (let x = 0; x < width; x++) {
      const idx = pixelsOffset + (y * width + x) * 4;
      let r = 0,
        g = 0,
        b = 0,
        a = 0;

      // Rounded square background badge (x: 4..59, y: 6..59)
      const inBadge =
        x >= 3 &&
        x <= 60 &&
        drawY >= 6 &&
        drawY <= 60 &&
        Math.hypot(Math.max(0, 9 - x, x - 54), Math.max(0, 12 - drawY, drawY - 54)) <= 6;

      // Top DSLR prism hump (x: 20..43, y: 3..12)
      const inPrism = x >= 20 && x <= 43 && drawY >= 3 && drawY <= 12;

      if (inBadge || inPrism) {
        a = 255;
        // Dark metallic slate body with subtle gradient
        r = 18 + Math.round((60 - drawY) * 0.35);
        g = 23 + Math.round((60 - drawY) * 0.4);
        b = 34 + Math.round((60 - drawY) * 0.55);

        // Top gold accent stripe across camera body
        if (drawY >= 14 && drawY <= 16 && x >= 6 && x <= 57) {
          r = 245;
          g = 158;
          b = 11;
        }

        // Red REC / Tally indicator dot on top-right
        const distRec = Math.hypot(x - 51, drawY - 19);
        if (distRec <= 3.3) {
          r = 239;
          g = 68;
          b = 68;
        }

        // Center Lens (cx = 32, cy = 35)
        const distLens = Math.hypot(x - 32, drawY - 35);
        if (distLens <= 19.5 && distLens >= 16.2) {
          // Outer Gold Luxury Ring
          r = 251;
          g = 191;
          b = 36;
        } else if (distLens < 16.2 && distLens >= 13.0) {
          // Dark gunmetal barrel ring
          r = 12;
          g = 16;
          b = 24;
        } else if (distLens < 13.0) {
          // Glowing Cyan/Blue Studio Optics
          const t = distLens / 13.0;
          r = Math.round(14 + (1 - t) * 45);
          g = Math.round(115 + (1 - t) * 110);
          b = Math.round(215 + (1 - t) * 40);

          // Specular highlight reflection on top-left of lens glass
          const distSpec = Math.hypot(x - 27, drawY - 30);
          if (distSpec <= 3.6) {
            r = 235;
            g = 250;
            b = 255;
          }
        }
      }

      buf[idx] = b;
      buf[idx + 1] = g;
      buf[idx + 2] = r;
      buf[idx + 3] = a;
    }
  }

  writeFileSync(targetPath, buf);
}

const assetsDir = join(process.cwd(), "assets");
mkdirSync(assetsDir, { recursive: true });
generateStudioIconFile(join(assetsDir, "gaviru-cam.ico"));
console.log("Generated assets/gaviru-cam.ico");
