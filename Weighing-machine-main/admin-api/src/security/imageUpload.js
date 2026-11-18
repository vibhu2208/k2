'use strict';

const MAX_IMAGE_BYTES = Number(process.env.MAX_UPLOAD_IMAGE_BYTES) || 5 * 1024 * 1024;
const MAX_INPUT_PIXELS = Number(process.env.MAX_UPLOAD_INPUT_PIXELS) || 40_000_000;
const MAX_UPLOAD_EDGE = Number(process.env.MAX_UPLOAD_EDGE) || 2560;

let sharp = null;
try {
  sharp = require('sharp');
} catch {
  sharp = null;
}

function sniffImage(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  ) {
    return 'image/webp';
  }
  return null;
}

async function sanitizeImageBuffer(buf) {
  if (!sharp) {
    const contentType = sniffImage(buf);
    if (!contentType) throw new Error('Only JPEG, PNG, or WebP images are allowed');
    return { buffer: buf, contentType };
  }
  const pipeline = sharp(buf, {
    failOn: 'error',
    limitInputPixels: MAX_INPUT_PIXELS,
  }).rotate();
  const meta = await pipeline.metadata();
  if (!meta.width || !meta.height) {
    throw new Error('Invalid image data');
  }
  const out = await pipeline
    .resize({
      width: MAX_UPLOAD_EDGE,
      height: MAX_UPLOAD_EDGE,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .jpeg({ quality: 85, mozjpeg: true })
    .toBuffer();
  return { buffer: out, contentType: 'image/jpeg' };
}

async function parseImageBuffer(imageBase64) {
  if (!imageBase64 || typeof imageBase64 !== 'string') {
    throw new Error('imageBase64 is required');
  }
  const match = imageBase64.match(/^data:image\/[\w+.-]+;base64,(.+)$/);
  const raw = match ? match[1] : imageBase64;
  // Rough pre-check: base64 expands ~4/3
  if (raw.length > Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 64) {
    throw new Error(`Image exceeds ${MAX_IMAGE_BYTES} byte limit`);
  }
  const buf = Buffer.from(raw, 'base64');
  if (!buf.length) throw new Error('Invalid image data');
  if (buf.length > MAX_IMAGE_BYTES) {
    throw new Error(`Image exceeds ${MAX_IMAGE_BYTES} byte limit`);
  }
  const contentType = sniffImage(buf);
  if (!contentType) {
    throw new Error('Only JPEG, PNG, or WebP images are allowed');
  }
  return sanitizeImageBuffer(buf);
}

module.exports = {
  MAX_IMAGE_BYTES,
  sniffImage,
  sanitizeImageBuffer,
  parseImageBuffer,
};
