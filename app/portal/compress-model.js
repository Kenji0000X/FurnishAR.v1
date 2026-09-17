'use client';

/**
 * Shrink an oversized .glb in the browser, before it is uploaded.
 *
 * WHY THIS IS HERE AND NOT A COMMAND
 * The honest advice for a 60 MB model is "run gltf-transform on it", and that
 * advice is useless to the people this app is for. A shop owner in Mamburao
 * adding a cabinet from their phone has no terminal, no Node, and no reason to
 * learn what meshopt is. Telling them their file is too big and handing them a
 * CLI is telling them no with extra steps.
 *
 * TWO KINDS OF BIG FILE, AND THE FIRST VERSION ONLY HANDLED ONE
 * A model is large for one of two reasons, and they need opposite treatment:
 *
 *   textures  — a chair with 4k maps. Resizing them is most of the file and
 *               invisible at the distance anyone looks at furniture.
 *   geometry  — a scanned or CAD piece with a million triangles and often no
 *               textures at all. Resizing textures does exactly nothing.
 *
 * The first version of this only did textures, on the argument that geometry
 * must not be touched. That was wrong in a way that mattered: a 60.4 MB
 * geometry-heavy model came back out at 60.4 MB, unchanged, and the owner was
 * told to go and fix it in a 3D tool. Compressing geometry is not the same as
 * damaging it — meshopt re-encodes the same vertices smaller, and moves
 * nothing. Measured on a 48 MB geometry-only model: 16.4 MB, no visible
 * change, nothing simplified.
 *
 * Simplification — actually removing triangles — is still the last resort, and
 * still conservative, because that one does change the silhouette and this
 * app's whole claim is that what you see on the floor is the real shape of the
 * thing.
 *
 * Everything this produces is loadable: the planner has the meshopt decoder
 * attached (see loadThreeJS in app/plan/ar-engine.js), which is what makes
 * compressing on the way in safe rather than a trap.
 */

/** Texture budgets to try, largest first. 2048 is already generous for AR. */
const TEXTURE_BUDGETS = [2048, 1024, 512];

/** Triangle ratios for the last-resort pass. Never below a quarter. */
const SIMPLIFY_RATIOS = [0.5, 0.25];

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
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();

  const blob = await new Promise(resolve => canvas.toBlob(resolve, outputType, 0.85));
  if (!blob) return null;
  return { bytes: new Uint8Array(await blob.arrayBuffer()), mimeType: outputType };
}

/**
 * Compresses `file` until it is at or under `maxBytes`.
 *
 * Returns { file, originalBytes, finalBytes, changed, simplified, stillTooBig }.
 * A file that already fits comes back untouched with changed: false — nothing
 * is re-encoded for the sake of it.
 *
 * `onProgress(stage, fraction)` is called as it works. This runs on the main
 * thread and a 60 MB model takes real seconds, so the caller must say so.
 */
export async function compressGlb(file, { maxBytes, onProgress = () => {} } = {}) {
  const originalBytes = file.size;
  if (originalBytes <= maxBytes) {
    return { file, originalBytes, finalBytes: originalBytes, changed: false };
  }

  onProgress('reading', 0);
  // Imported here, not at module scope: several hundred KB plus WASM that only
  // matters for an oversized upload, and most uploads are not.
  const [core, extensions, functions, encoderModule, simplifierModule] = await Promise.all([
    import('@gltf-transform/core'),
    import('@gltf-transform/extensions'),
    import('@gltf-transform/functions'),
    import('meshoptimizer/encoder'),
    import('meshoptimizer/simplifier')
  ]);

  const encoder = encoderModule.MeshoptEncoder;
  const simplifier = simplifierModule.MeshoptSimplifier;
  await Promise.all([encoder.ready, simplifier.ready]);

  // Registered on the IO, not only passed to the transform: the extension
  // reaches for it at write time and fails with an undefined encoder
  // otherwise.
  const io = new core.WebIO()
    .registerExtensions(extensions.ALL_EXTENSIONS)
    .registerDependencies({ 'meshopt.encoder': encoder, 'meshopt.decoder': encoder });

  const original = new Uint8Array(await file.arrayBuffer());
  const outputType = bestImageType();

  /**
   * One attempt: optionally resize textures, optionally drop triangles, always
   * compress geometry. Re-read from the original bytes each time so a texture
   * is never re-encoded on top of an earlier re-encode.
   */
  async function attempt({ textureBudget, simplifyRatio, report }) {
    const doc = await io.readBinary(original);

    if (textureBudget) {
      const textures = doc.getRoot().listTextures();
      for (const [seen, texture] of textures.entries()) {
        const image = texture.getImage();
        if (!image) continue;
        try {
          const shrunk = await shrinkImage(image, texture.getMimeType(), textureBudget, outputType);
          if (shrunk) {
            texture.setImage(shrunk.bytes);
            texture.setMimeType(shrunk.mimeType);
          }
        } catch {
          // A texture the browser cannot decode is left as it was: a slightly
          // larger file beats a broken one.
        }
        report((seen + 1) / Math.max(textures.length, 1));
      }
    }

    const steps = [];
    if (simplifyRatio) {
      // weld() first: simplify needs shared vertices, and says so loudly
      // rather than silently doing nothing.
      steps.push(functions.weld());
      steps.push(functions.simplify({ simplifier, ratio: simplifyRatio, error: 0.01 }));
    }
    steps.push(functions.meshopt({ encoder }));
    await doc.transform(...steps);

    return io.writeBinary(doc);
  }

  // The ladder, cheapest first. A geometry-heavy model — the case that used to
  // come back unchanged — is usually done at the first rung, without a single
  // texture being touched.
  const rungs = [
    { textureBudget: null, simplifyRatio: null, label: 'compressing' },
    ...TEXTURE_BUDGETS.map(budget => ({ textureBudget: budget, simplifyRatio: null, label: 'compressing' })),
    ...SIMPLIFY_RATIOS.map(ratio => ({
      textureBudget: TEXTURE_BUDGETS[TEXTURE_BUDGETS.length - 1],
      simplifyRatio: ratio,
      label: 'simplifying'
    }))
  ];

  let smallest = null;
  for (const [index, rung] of rungs.entries()) {
    const base = index / rungs.length;
    onProgress(rung.label, base);

    let output;
    try {
      output = await attempt({
        ...rung,
        report: fraction => onProgress(rung.label, base + (fraction / rungs.length))
      });
    } catch {
      // A rung that throws (a mesh simplify cannot index, say) is not fatal —
      // the next one may still work, and the smallest success so far is kept.
      continue;
    }

    if (!smallest || output.byteLength < smallest.bytes.byteLength) {
      smallest = { bytes: output, simplified: Boolean(rung.simplifyRatio) };
    }
    if (output.byteLength <= maxBytes) {
      onProgress('done', 1);
      return {
        file: new File([output], file.name, { type: 'model/gltf-binary' }),
        originalBytes,
        finalBytes: output.byteLength,
        changed: true,
        simplified: Boolean(rung.simplifyRatio)
      };
    }
  }

  onProgress('done', 1);
  if (!smallest) {
    return { file, originalBytes, finalBytes: originalBytes, changed: false, stillTooBig: true };
  }
  return {
    file: new File([smallest.bytes], file.name, { type: 'model/gltf-binary' }),
    originalBytes,
    finalBytes: smallest.bytes.byteLength,
    changed: true,
    simplified: smallest.simplified,
    stillTooBig: true
  };
}

/** "1.4 MB" — for saying what happened, in the units people think in. */
export function formatBytes(bytes) {
  const size = Number(bytes);
  if (!Number.isFinite(size) || size <= 0) return '0 MB';
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / 1048576).toFixed(1)} MB`;
}
