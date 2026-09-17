/**
 * Builds a .glb too big to upload, for testing the automatic shrinker.
 *
 * Generated rather than committed: the point is a file over the limit, and a
 * 40 MB fixture in git to prove a 40 MB limit is a bad trade. The textures are
 * random noise on purpose — noise does not compress, so the file really is the
 * size it claims, and the shrinker has to do actual work rather than getting a
 * free win from PNG's own deflate.
 */
import { NodeIO } from '@gltf-transform/core';
import { deflateSync, crc32 } from 'node:zlib';

/** Minimal PNG encoder: IHDR, one IDAT, IEND. Enough for a decodable image. */
function encodePng(width, height, pixels) {
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([length, body, crc]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;     // bit depth
  ihdr[9] = 6;     // colour type: RGBA
  // 10-12 stay zero: deflate, default filter, no interlace.

  // Each scanline is prefixed with its filter byte (0 = none).
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 1 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/**
 * A .glb of roughly `targetBytes`, built from `sourceGlb` with its textures
 * replaced by large noise images.
 */
export async function makeOversizedGlb(sourceGlb, targetBytes) {
  const io = new NodeIO();
  const doc = await io.readBinary(new Uint8Array(sourceGlb));

  const size = 2048;
  const pixels = Buffer.alloc(size * size * 4);
  for (let i = 0; i < pixels.length; i++) pixels[i] = (Math.random() * 256) | 0;
  const png = encodePng(size, size, pixels);

  const root = doc.getRoot();
  const material = root.listMaterials()[0];
  let texture = root.listTextures()[0];
  if (!texture) {
    texture = doc.createTexture('bulk');
    material?.setBaseColorTexture(texture);
  }
  texture.setImage(new Uint8Array(png)).setMimeType('image/png');

  // One 2048² noise PNG is ~16 MB; add more until the target is passed.
  let added = 1;
  while (added * png.length < targetBytes) {
    const extra = doc.createTexture(`bulk-${added}`).setImage(new Uint8Array(png)).setMimeType('image/png');
    const slot = doc.createMaterial(`bulk-mat-${added}`).setBaseColorTexture(extra);
    // Attached to a material so nothing prunes it as unused.
    doc.createMesh(`bulk-mesh-${added}`).addPrimitive(
      doc.createPrimitive().setMaterial(slot).setAttribute(
        'POSITION',
        doc.createAccessor().setType('VEC3').setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]))
      )
    );
    added += 1;
  }

  return Buffer.from(await io.writeBinary(doc));
}
