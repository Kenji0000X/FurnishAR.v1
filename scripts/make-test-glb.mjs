/**
 * A .glb of a given size that passes the header check in uploadModel().
 *
 * The upload path now refuses anything whose first 12 bytes are not a real
 * glTF-binary header (magic "glTF", a version, and a length that matches the
 * file). That is the point of it — a renamed .gltf or a half-copied file never
 * reaches storage. It also means a test fixture cannot be Buffer.alloc() any
 * more, which is how this helper came to exist.
 *
 * The body is padding, not real glTF chunks: these fixtures exercise upload
 * mechanics — progress, retries, size limits — and never parse the model.
 * A test that needs a model three.js can actually read should use the real
 * public/models/cane-back-armchair.glb instead.
 */
export function makeTestGlb(totalBytes) {
  if (totalBytes < 12) throw new Error('a .glb is at least its 12-byte header');
  const buffer = Buffer.alloc(totalBytes, 7);
  buffer.write('glTF', 0, 'ascii');       // magic
  buffer.writeUInt32LE(2, 4);             // version
  buffer.writeUInt32LE(totalBytes, 8);    // total length, must match the file
  return buffer;
}
