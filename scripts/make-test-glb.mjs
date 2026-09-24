/**
 * A real .glb of a given file size and physical shape, for browser checks.
 *
 * It used to be 12 header bytes and padding: enough to pass the header check
 * in uploadModel(), but not a model. The store portal now reads every chosen
 * model in the browser BEFORE uploading it (to preview it and check its
 * proportions against the furniture's dimensions), so a fixture that three.js
 * cannot parse would be refused at that step, which is exactly what should
 * happen to such a file.
 *
 * So this writes a genuine glTF-binary: one box mesh, `size` metres across
 * (width, height, depth), plus unused buffer bytes to reach `totalBytes`
 * exactly. The padding is valid glTF — a buffer may be larger than what its
 * views use — so the file loads, measures, and still exercises upload
 * progress, retries and size limits at whatever size the check asks for.
 */
export function makeTestGlb(totalBytes, { size = [1, 1, 1] } = {}) {
  if (totalBytes % 4 !== 0) throw new Error('a .glb is a whole number of 4-byte words');
  const [w, h, d] = size;
  const x = w / 2, y = h / 2, z = d / 2;
  const positions = new Float32Array([
    -x, -y, -z,  x, -y, -z,  x,  y, -z, -x,  y, -z,
    -x, -y,  z,  x, -y,  z,  x,  y,  z, -x,  y,  z
  ]);
  const indices = new Uint16Array([
    0, 2, 1, 0, 3, 2,  4, 5, 6, 4, 6, 7,  0, 1, 5, 0, 5, 4,
    3, 6, 2, 3, 7, 6,  1, 2, 6, 1, 6, 5,  0, 4, 7, 0, 7, 3
  ]);
  const geometryBytes = positions.byteLength + indices.byteLength; // 96 + 72 = 168

  const jsonFor = binLength => {
    const json = JSON.stringify({
      asset: { version: '2.0', generator: 'FurnishAR make-test-glb' },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
      buffers: [{ byteLength: binLength }],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: positions.byteLength, target: 34962 },
        { buffer: 0, byteOffset: positions.byteLength, byteLength: indices.byteLength, target: 34963 }
      ],
      accessors: [
        { bufferView: 0, componentType: 5126, count: 8, type: 'VEC3', min: [-x, -y, -z], max: [x, y, z] },
        { bufferView: 1, componentType: 5123, count: 36, type: 'SCALAR' }
      ]
    });
    const padded = json + ' '.repeat((4 - (json.length % 4)) % 4);
    return Buffer.from(padded, 'utf8');
  };

  // The JSON mentions the BIN length, and the BIN length is whatever is left
  // after the JSON — settle the two against each other.
  let binLength = totalBytes - 12 - 8 - 8 - jsonFor(0).length;
  for (let i = 0; i < 4; i += 1) {
    const json = jsonFor(binLength);
    binLength = totalBytes - 12 - 8 - json.length - 8;
  }
  const json = jsonFor(binLength);
  if (binLength < geometryBytes || binLength % 4 !== 0) {
    throw new Error(`${totalBytes} bytes is too small for a test model (needs about ${12 + 16 + json.length + geometryBytes})`);
  }

  const buffer = Buffer.alloc(totalBytes, 0);
  let offset = 0;
  buffer.write('glTF', offset, 'ascii'); offset += 4;
  buffer.writeUInt32LE(2, offset); offset += 4;
  buffer.writeUInt32LE(totalBytes, offset); offset += 4;
  buffer.writeUInt32LE(json.length, offset); offset += 4;
  buffer.write('JSON', offset, 'ascii'); offset += 4;
  json.copy(buffer, offset); offset += json.length;
  buffer.writeUInt32LE(binLength, offset); offset += 4;
  buffer.write('BIN\0', offset, 'ascii'); offset += 4;
  Buffer.from(positions.buffer).copy(buffer, offset);
  Buffer.from(indices.buffer).copy(buffer, offset + positions.byteLength);
  return buffer;
}
