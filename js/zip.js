// Minimal ZIP reader for game data packs: reads the central directory and inflates
// entries with the browser's DecompressionStream (stored and deflate entries only).

function readU16(view, off) {
  return view.getUint16(off, true);
}

function readU32(view, off) {
  return view.getUint32(off, true);
}

async function inflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Calls onEntry(path, Uint8Array) for every file in the archive, in order.
export async function unzip(blob, onEntry, onProgress) {
  const tailSize = Math.min(blob.size, 65536 + 22);
  const tail = new Uint8Array(await blob.slice(blob.size - tailSize).arrayBuffer());
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail[i] === 0x50 && tail[i + 1] === 0x4b && tail[i + 2] === 0x05 && tail[i + 3] === 0x06) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a zip archive');
  const tv = new DataView(tail.buffer, tail.byteOffset + eocd);
  const count = readU16(tv, 10);
  const cdSize = readU32(tv, 12);
  const cdOffset = readU32(tv, 16);
  const cd = new Uint8Array(await blob.slice(cdOffset, cdOffset + cdSize).arrayBuffer());
  const cv = new DataView(cd.buffer);
  const decoder = new TextDecoder();
  let pos = 0;
  for (let n = 0; n < count; n++) {
    if (readU32(cv, pos) !== 0x02014b50) throw new Error('Bad zip directory');
    const method = readU16(cv, pos + 10);
    const compSize = readU32(cv, pos + 20);
    const nameLen = readU16(cv, pos + 28);
    const extraLen = readU16(cv, pos + 30);
    const commentLen = readU16(cv, pos + 32);
    const localOffset = readU32(cv, pos + 42);
    const name = decoder.decode(cd.subarray(pos + 46, pos + 46 + nameLen));
    pos += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    const lh = new DataView(await blob.slice(localOffset, localOffset + 30).arrayBuffer());
    const dataStart = localOffset + 30 + readU16(lh, 26) + readU16(lh, 28);
    const raw = new Uint8Array(await blob.slice(dataStart, dataStart + compSize).arrayBuffer());
    let data;
    if (method === 0) data = raw;
    else if (method === 8) data = await inflateRaw(raw);
    else throw new Error(`Unsupported zip method ${method} for ${name}`);
    await onEntry(name, data);
    onProgress?.((n + 1) / count);
  }
}
