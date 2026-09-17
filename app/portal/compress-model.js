'use client';

/**
 * Shrink an oversized .glb in the browser, before it is uploaded.
 *
 * WHY THIS IS HERE AND NOT A COMMAND
 * The honest advice for a 60 MB model is "run gltf-transform on it", and that
 * advice is useless to the people this app is for. A shop owner in Mamburao
 * adding a cabinet from their phone has no terminal, no Node, and no reason to
 * learn what Draco is. Telling them their file is too big and handing them a
 * CLI is telling them no with extra steps.
 *
 * WHAT IT DOES
 * Textures, not geometry, are almost always the problem: on this repo's own
 * armchair, geometry compression alone took 1.37 MB to 1.02 MB, while resizing
 * and re-encoding the textures took it to 131 KB. So this resizes every
 * oversized texture and re-encodes it, which is where the win is, and it does
 * so with `createImageBitmap` and a canvas — browser APIs that are already
 * there. No WASM encoder ships to the page for this.
 *
 * It works down through progressively smaller texture budgets until the file
 * fits, rather than guessing one setting: a model with four 4k textures and
 * one with a single 2k texture need different amounts of help.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * It does not touch geometry. Decimating a mesh changes the silhouette of a
 * piece of furniture, and this app's whole claim is that what you see on the
 * floor is the real size and shape of the thing. Losing texture resolution is
 * invisible at the distance someone views a chair; losing vertices is not.
 * If textures alone cannot get a model under the limit, the owner is told
 * plainly rather than handed a quietly mangled model.
 */

/** Texture budgets to try, largest first. 2048 is already generous for AR. */
const TEXTURE_BUDGETS = [2048, 1024, 512];

/** Re-encode to WebP where supported — typically half the size of JPEG. */
function bestImageType() {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  return canvas.toDataURL('image/webp').startsWith('data:image/webp')
    ? 'image/webp'
    : 'image/jpeg';
}

/**
 * Redraws one encoded image at no more than `budget` on its longest side.
 * Returns null when it is already small enough, so the caller can skip it.
 */
async function shrinkImage(bytes, mimeType, budget, outputType) {
  const bitmap = await createImageBitmap(new Blob([bytes], { type: mimeType || 'image/png' }));
  const longest = Math.max(bitmap.width, bitmap.height);
  if (longest <= budget) {
    bitmap.close?.();
    return null;
  }

  const scale = budget / longest;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext('2d');
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();

  const blob = await new Promise(resolve => canvas.toBlob(resolve, outputType, 0.85));
  if (!blob) return null;
  return { bytes: new Uint8Array(await blob.arrayBuffer()), mimeType: outputType };
}

/**
 * Compresses `file` until it is at or under `maxBytes`.
 *
 * Returns { file, originalBytes, finalBytes, budget, changed }. When the file
 * already fits, it comes back untouched with changed: false — nothing is
 * re-encoded for the sake of it.
 *
 * `onProgress(stage, fraction)` is called as it works; this runs on the main
 * thread and a 60 MB model takes real seconds, so the caller must say so.
 */
export async function compressGlb(file, { maxBytes, onProgress = () => {} } = {}) {
  const originalBytes = file.size;
  if (originalBytes <= maxBytes) {
    return { file, originalBytes, finalBytes: originalBytes, changed: false };
  }

  onProgress('reading', 0);
  // Imported here, not at module scope: this is several hundred KB that only
  // matters for an oversized upload, and most uploads are not.
  const [{ WebIO }, { ALL_EXTENSIONS }] = await Promise.all([
    import('@gltf-transform/core'),
    import('@gltf-transform/extensions')
  ]);

  const io = new WebIO().registerExtensions(ALL_EXTENSIONS);
  const original = new Uint8Array(await file.arrayBuffer());
  const outputType = bestImageType();

  for (const [index, budget] of TEXTURE_BUDGETS.entries()) {
    onProgress('compressing', index / TEXTURE_BUDGETS.length);

    // Re-read each pass from the original bytes. Re-encoding an
    // already-re-encoded texture compounds the loss for nothing.
    const doc = await io.readBinary(original);
    const textures = doc.getRoot().listTextures();

    for (const [seen, texture] of textures.entries()) {
      const image = texture.getImage();
      if (!image) continue;
      try {
        const shrunk = await shrinkImage(image, texture.getMimeType(), budget, outputType);
        if (shrunk) {
          texture.setImage(shrunk.bytes);
          texture.setMimeType(shrunk.mimeType);
        }
      } catch {
        // A texture the browser cannot decode is left exactly as it was: a
        // slightly larger file is better than a broken one.
      }
      onProgress('compressing', (index + (seen + 1) / Math.max(textures.length, 1)) / TEXTURE_BUDGETS.length);
    }

    const rebuilt = await io.writeBinary(doc);
    if (rebuilt.byteLength <= maxBytes) {
      onProgress('done', 1);
      return {
        file: new File([rebuilt], file.name, { type: 'model/gltf-binary' }),
        originalBytes,
        finalBytes: rebuilt.byteLength,
        budget,
        changed: true
      };
    }

    // Keep the smallest result so far, in case no budget gets under the limit
    // and the caller wants to report how close this got.
    if (budget === TEXTURE_BUDGETS[TEXTURE_BUDGETS.length - 1]) {
      onProgress('done', 1);
      return {
        file: new File([rebuilt], file.name, { type: 'model/gltf-binary' }),
        originalBytes,
        finalBytes: rebuilt.byteLength,
        budget,
        changed: true,
        stillTooBig: true
      };
    }
  }

  return { file, originalBytes, finalBytes: originalBytes, changed: false, stillTooBig: true };
}

/** "1.4 MB" — for saying what happened, in the units people think in. */
export function formatBytes(bytes) {
  const size = Number(bytes);
  if (!Number.isFinite(size) || size <= 0) return '0 MB';
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / 1048576).toFixed(1)} MB`;
}
