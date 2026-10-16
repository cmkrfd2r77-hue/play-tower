// Disc access for the emulator and for the library scanner.
//
// DiscImageDevice is what the Play! core calls to read the disc image. The original
// frontend sliced the File for every request; here reads go through a chunk cache with
// read-ahead, so the sequential reads games make (streaming, FMV) are served from memory.
//
// readDiscInfo() opens an image (ISO, raw BIN, CSO) and reads SYSTEM.CNF to get the
// disc serial, which is how games are named and matched with covers.

const CHUNK_SIZE = 1 << 20;
const MAX_CHUNKS = 64;

export class DiscImageDevice {
  constructor(module) {
    this.module = module;
    this.file = null;
    this.doneFlag = true;
    this.chunks = new Map();
    this.pending = new Map();
    this.bytesRead = 0;
  }

  setFile(file) {
    this.file = file;
    this.chunks.clear();
    this.pending.clear();
    this.bytesRead = 0;
  }

  getFileSize() {
    if (!this.file) throw new Error('No disc image set.');
    return this.file.size;
  }

  isDone() {
    return this.doneFlag;
  }

  loadChunk(index) {
    const cached = this.chunks.get(index);
    if (cached) {
      this.chunks.delete(index);
      this.chunks.set(index, cached);
      return cached;
    }
    let promise = this.pending.get(index);
    if (!promise) {
      const file = this.file;
      const start = index * CHUNK_SIZE;
      promise = file.slice(start, Math.min(start + CHUNK_SIZE, file.size)).arrayBuffer().then((buffer) => {
        this.pending.delete(index);
        if (this.file !== file) return new Uint8Array(buffer);
        const bytes = new Uint8Array(buffer);
        this.chunks.set(index, bytes);
        while (this.chunks.size > MAX_CHUNKS) this.chunks.delete(this.chunks.keys().next().value);
        return bytes;
      });
      this.pending.set(index, promise);
    }
    return promise;
  }

  copyOut(dstPtr, offset, size) {
    const heap = this.module.HEAPU8;
    let written = 0;
    while (written < size) {
      const pos = offset + written;
      const index = Math.floor(pos / CHUNK_SIZE);
      const chunk = this.chunks.get(index);
      const inChunk = pos - index * CHUNK_SIZE;
      const n = Math.min(size - written, chunk.length - inChunk);
      if (n <= 0) break;
      heap.set(chunk.subarray(inChunk, inChunk + n), dstPtr + written);
      written += n;
    }
    this.bytesRead += size;
  }

  read(dstPtr, offset, size) {
    if (!this.file) throw new Error('No disc image set.');
    const first = Math.floor(offset / CHUNK_SIZE);
    const last = Math.floor((offset + Math.max(size, 1) - 1) / CHUNK_SIZE);
    const needed = [];
    for (let i = first; i <= last; i++) if (!this.chunks.has(i)) needed.push(i);
    const prefetch = () => {
      const next = last + 1;
      if (next * CHUNK_SIZE < this.file.size && !this.chunks.has(next)) this.loadChunk(next);
    };
    if (needed.length === 0) {
      for (let i = first; i <= last; i++) this.loadChunk(i);
      this.copyOut(dstPtr, offset, size);
      this.doneFlag = true;
      prefetch();
      return;
    }
    this.doneFlag = false;
    Promise.all(needed.map((i) => this.loadChunk(i))).then(() => {
      for (let i = first; i <= last; i++) {
        if (!this.chunks.has(i)) {
          // Evicted while waiting; fall back to a direct read of the exact range.
          return this.file.slice(offset, offset + size).arrayBuffer().then((buf) => {
            this.module.HEAPU8.set(new Uint8Array(buf), dstPtr);
            this.doneFlag = true;
          });
        }
      }
      this.copyOut(dstPtr, offset, size);
      this.doneFlag = true;
      prefetch();
      return null;
    }).catch((err) => {
      console.error('Disc read failed', err);
      this.doneFlag = true;
    });
  }
}

// Disc inspection ---------------------------------------------------------

const DISC_EXTENSIONS = ['iso', 'bin', 'img', 'cso', 'chd', 'isz'];
export const GAME_EXTENSIONS = [...DISC_EXTENSIONS, 'elf'];

export function extensionOf(name) {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot + 1).toLowerCase();
}

export function isGameFile(name) {
  return GAME_EXTENSIONS.includes(extensionOf(name));
}

async function readBytes(blob, start, length) {
  return new Uint8Array(await blob.slice(start, start + length).arrayBuffer());
}

function ascii(bytes, start, length) {
  let s = '';
  for (let i = start; i < start + length && i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

// Returns a function that reads one 2048-byte user-data sector, or null.
async function openSectorReader(file) {
  const head = await readBytes(file, 0, 24);
  const magic = ascii(head, 0, 4);
  if (magic === 'CISO') return openCso(file, head);
  if (ascii(head, 0, 8) === 'MComprHD') return null;

  const layouts = [
    { size: 2048, offset: 0 },
    { size: 2352, offset: 24 },
    { size: 2352, offset: 16 },
    { size: 2336, offset: 8 },
  ];
  for (const layout of layouts) {
    const probe = await readBytes(file, 16 * layout.size + layout.offset, 8);
    if (ascii(probe, 1, 5) === 'CD001') {
      return (lba, count = 1) => {
        if (layout.size === 2048) return readBytes(file, lba * 2048, count * 2048);
        return (async () => {
          const raw = await readBytes(file, lba * layout.size, count * layout.size);
          const out = new Uint8Array(count * 2048);
          for (let i = 0; i < count; i++) out.set(raw.subarray(i * layout.size + layout.offset, i * layout.size + layout.offset + 2048), i * 2048);
          return out;
        })();
      };
    }
  }
  return null;
}

async function inflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function openCso(file, head) {
  const view = new DataView(head.buffer);
  const totalBytes = Number(view.getBigUint64(8, true));
  const blockSize = view.getUint32(16, true);
  const align = head[21];
  const blockCount = Math.ceil(totalBytes / blockSize);
  if (typeof DecompressionStream === 'undefined' || blockSize < 2048) return null;
  const cache = new Map();
  const readIndex = async (n) => {
    const b = await readBytes(file, 24 + n * 4, 8);
    const dv = new DataView(b.buffer);
    return [dv.getUint32(0, true), dv.getUint32(4, true)];
  };
  const readBlock = async (n) => {
    if (cache.has(n)) return cache.get(n);
    const [a, b] = await readIndex(n);
    const plain = (a & 0x80000000) !== 0;
    const pos = (a & 0x7fffffff) * 2 ** align;
    const end = (b & 0x7fffffff) * 2 ** align;
    let data = await readBytes(file, pos, end - pos);
    if (!plain) data = await inflateRaw(data);
    cache.set(n, data);
    return data;
  };
  return async (lba, count = 1) => {
    const out = new Uint8Array(count * 2048);
    for (let i = 0; i < count; i++) {
      const offset = (lba + i) * 2048;
      const block = Math.floor(offset / blockSize);
      if (block >= blockCount) break;
      const data = await readBlock(block);
      const inBlock = offset - block * blockSize;
      out.set(data.subarray(inBlock, inBlock + 2048), i * 2048);
    }
    return out;
  };
}

function parseDirectory(bytes) {
  const entries = [];
  let pos = 0;
  while (pos < bytes.length) {
    const len = bytes[pos];
    if (len === 0) {
      pos = (Math.floor(pos / 2048) + 1) * 2048;
      continue;
    }
    const dv = new DataView(bytes.buffer, bytes.byteOffset + pos, len);
    const nameLen = bytes[pos + 32];
    const name = ascii(bytes, pos + 33, nameLen);
    entries.push({
      name: name.replace(/;\d+$/, '').toUpperCase(),
      lba: dv.getUint32(2, true),
      size: dv.getUint32(10, true),
      isDir: (bytes[pos + 25] & 2) !== 0,
    });
    pos += len;
  }
  return entries;
}

export function normalizeSerial(raw) {
  const m = /([A-Z]{4})[-_ ]?(\d{3})\.?(\d{2})/i.exec(raw || '');
  return m ? `${m[1].toUpperCase()}-${m[2]}${m[3]}` : null;
}

// Reads SYSTEM.CNF from the disc. Returns { serial, format } or { serial: null, format }.
export async function readDiscInfo(file) {
  const ext = extensionOf(file.name);
  if (ext === 'chd' || ext === 'isz' || ext === 'elf') return { serial: null, format: ext.toUpperCase() };
  try {
    const readSectors = await openSectorReader(file);
    if (!readSectors) return { serial: null, format: ext.toUpperCase() };
    const pvd = await readSectors(16, 1);
    const root = new DataView(pvd.buffer, pvd.byteOffset + 156, 34);
    const rootLba = root.getUint32(2, true);
    const rootSize = root.getUint32(10, true);
    const dir = await readSectors(rootLba, Math.min(Math.ceil(rootSize / 2048), 16));
    const entry = parseDirectory(dir).find((e) => e.name === 'SYSTEM.CNF');
    if (!entry) return { serial: null, format: ext.toUpperCase(), ps1: false };
    const cnf = await readSectors(entry.lba, Math.max(1, Math.ceil(Math.min(entry.size, 4096) / 2048)));
    const text = new TextDecoder('latin1').decode(cnf.subarray(0, entry.size));
    const boot = /BOOT2\s*=\s*cdrom0:\\?([^;\s]+)/i.exec(text);
    return { serial: boot ? normalizeSerial(boot[1]) : null, format: ext.toUpperCase(), ps1: !boot && /BOOT\s*=/i.test(text) };
  } catch (err) {
    console.warn('Could not read disc info for', file.name, err);
    return { serial: null, format: ext.toUpperCase() };
  }
}
