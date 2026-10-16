// Wrapper around the Play! WebAssembly core.
// Loads the core with download progress, keeps the PS2 data folder (memory cards,
// save states) in IndexedDB, and exposes boot / pause / save-state / video controls.

import { DiscImageDevice } from './disc.js';
import { unzip } from './zip.js';

const CORE_VERSION = 'd44bfa1-tower3';
const DATA_DIR = '/home/web_user/.local/share/Play Data Files';
const STATE_DIR = `${DATA_DIR}/states`;
// host: and mass: point here. It lives in memory only, so game data packs are not copied
// into IndexedDB a second time; they are unpacked from the library before each boot.
const HOST_DIR = '/hostfs';

// The core creates its AudioContext itself; track it so it can be resumed after a
// user gesture (browsers start audio suspended).
const audioContexts = [];
if (window.AudioContext && !window.AudioContext.__towerTracked) {
  const Native = window.AudioContext;
  const Tracked = class extends Native {
    constructor(...args) {
      super(...args);
      audioContexts.push(this);
    }
  };
  Tracked.__towerTracked = true;
  window.AudioContext = Tracked;
}

export function resumeAudio() {
  for (const ctx of audioContexts) if (ctx.state === 'suspended') ctx.resume().catch(() => {});
}

async function fetchWithProgress(url, onProgress) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const total = Number(res.headers.get('content-length')) || 0;
  if (!res.body || !total) return res.arrayBuffer();
  const reader = res.body.getReader();
  const out = new Uint8Array(total);
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (received + value.length > out.length) {
      // Content-Length was the compressed size; fall back to growing the buffer.
      const grown = new Uint8Array(Math.max(out.length * 2, received + value.length));
      grown.set(out.subarray(0, received));
      return finishGrowing(reader, grown, received, value, onProgress, total);
    }
    out.set(value, received);
    received += value.length;
    onProgress?.(Math.min(1, received / total));
  }
  return out.buffer.slice(0, received);
}

async function finishGrowing(reader, buffer, received, chunk, onProgress, total) {
  let buf = buffer;
  let n = received;
  let value = chunk;
  for (;;) {
    if (n + value.length > buf.length) {
      const grown = new Uint8Array(Math.max(buf.length * 2, n + value.length));
      grown.set(buf.subarray(0, n));
      buf = grown;
    }
    buf.set(value, n);
    n += value.length;
    onProgress?.(Math.min(0.99, n / (total * 1.6)));
    const next = await reader.read();
    if (next.done) break;
    value = next.value;
  }
  return buf.buffer.slice(0, n);
}

function sanitize(name) {
  return name.replace(/[^\w.-]+/g, '_').slice(0, 80) || 'game';
}

export class Emulator {
  constructor(canvas) {
    this.canvas = canvas;
    this.module = null;
    this.loading = null;
    this.running = false;
    this.game = null;
    this.stateBusy = false;
    this.syncTimer = null;
    this.syncing = false;
    this.fpsHistory = [];
    this.lastFrames = 0;
    this.version = '';
  }

  get ready() {
    return !!this.module;
  }

  load(onProgress) {
    if (this.loading) return this.loading;
    this.loading = (async () => {
      const base = new URL('core/', document.baseURI);
      const wasmUrl = new URL(`Play.wasm?v=${CORE_VERSION}`, base).href;
      const jsUrl = new URL(`Play.js?v=${CORE_VERSION}`, base).href;
      const [wasmBinary, mod] = await Promise.all([
        fetchWithProgress(wasmUrl, (p) => onProgress?.({ stage: 'download', progress: p })),
        import(jsUrl),
      ]);
      onProgress?.({ stage: 'init', progress: 1 });
      const Play = mod.default;
      const module = await Play({
        wasmBinary,
        locateFile: (path) => new URL(`${path}?v=${CORE_VERSION}`, base).href,
        mainScriptUrlOrBlob: jsUrl,
        print: (s) => console.log('[Play!]', s),
        printErr: (s) => console.warn('[Play!]', s),
      });
      module.FS.mkdirTree(DATA_DIR);
      try {
        module.FS.mount(module.FS.filesystems.IDBFS, {}, DATA_DIR);
        await new Promise((resolve) => module.FS.syncfs(true, (err) => {
          if (err) console.warn('Could not restore saved data', err);
          resolve();
        }));
      } catch (err) {
        console.warn('IndexedDB storage unavailable; saves last for this session only', err);
      }
      module.FS.mkdirTree(STATE_DIR);
      module.FS.mkdirTree('/boot');
      module.FS.mkdirTree(HOST_DIR);
      module.discImageDevice = new DiscImageDevice(module);
      module.ccall('initVm', '', [], []);
      // Must follow initVm: creating the VM registers the default host directory.
      module.setHostDirectory(HOST_DIR);
      this.version = module.getVersion();
      this.module = module;
      this.syncTimer = setInterval(() => this.persist(), 15000);
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') this.persist();
      });
      window.addEventListener('pagehide', () => this.persist());
      return module;
    })();
    this.loading.catch(() => { this.loading = null; });
    return this.loading;
  }

  setPadInput(pad, button, value) {
    this.module?.setPadInput(pad, button, value);
  }

  persist() {
    const m = this.module;
    if (!m || this.syncing) return Promise.resolve();
    this.syncing = true;
    return new Promise((resolve) => m.FS.syncfs(false, (err) => {
      this.syncing = false;
      if (err) console.warn('Saving data failed', err);
      resolve();
    }));
  }

  clearHost() {
    const FS = this.module.FS;
    const remove = (dir) => {
      for (const name of FS.readdir(dir)) {
        if (name === '.' || name === '..') continue;
        const path = `${dir}/${name}`;
        if (FS.isDir(FS.stat(path).mode)) {
          remove(path);
          FS.rmdir(path);
        } else FS.unlink(path);
      }
    };
    remove(HOST_DIR);
  }

  writeHostFile(path, bytes) {
    const FS = this.module.FS;
    const full = `${HOST_DIR}/${path.replace(/^\/+/, '')}`;
    FS.mkdirTree(full.slice(0, full.lastIndexOf('/')));
    FS.writeFile(full, bytes);
  }

  // extras: { data: [{ blob, name, unzip }], args: [] } for games that read files from host:/mass:
  async boot(game, file, extras = {}, onStatus) {
    const m = this.module;
    if (this.running) m.pauseVm();
    const isElf = game.ext === 'elf';
    const data = extras.data || [];
    const args = extras.args || [];
    if (isElf && (data.length || args.length)) {
      this.clearHost();
      for (const item of data) {
        onStatus?.(item.name);
        if (item.unzip) await unzip(item.blob, (path, bytes) => this.writeHostFile(path, bytes));
        else this.writeHostFile(item.name, new Uint8Array(await item.blob.arrayBuffer()));
      }
      const name = sanitize(game.fileName);
      this.writeHostFile(name, new Uint8Array(await file.arrayBuffer()));
      m.bootVirtualElf(`host:${name}`, args.join('\n'));
    } else if (isElf) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const path = `/boot/${sanitize(game.fileName)}`;
      m.FS.writeFile(path, bytes);
      m.bootElf(path);
    } else {
      m.discImageDevice.setFile(file);
      m.bootDiscImage(sanitize(game.fileName));
    }
    this.game = game;
    this.running = true;
    this.lastFrames = 0;
    this.fpsHistory = [];
    resumeAudio();
  }

  pause() {
    if (!this.module || !this.running) return;
    this.module.pauseVm();
    this.running = false;
    this.persist();
  }

  resume() {
    if (!this.module || this.running || !this.game) return;
    this.module.resumeVm();
    this.running = true;
    resumeAudio();
  }

  sampleFps() {
    if (!this.module) return 0;
    const f = this.module.getFrames();
    this.module.clearStats();
    this.fpsHistory.push(f);
    if (this.fpsHistory.length > 60) this.fpsHistory.shift();
    return f;
  }

  statePath(slot) {
    const key = sanitize(this.game?.serial || this.game?.id || 'game');
    return `${STATE_DIR}/${key}.p${slot}`;
  }

  hasState(slot) {
    try {
      return this.module.FS.stat(this.statePath(slot));
    } catch {
      return null;
    }
  }

  async runStateOp(op, slot) {
    const m = this.module;
    if (!m || !this.game) return false;
    if (this.stateBusy) throw new Error('busy');
    this.stateBusy = true;
    try {
      // The emulator thread services these requests between frames, paused or not.
      const started = op === 'save' ? m.saveState(this.statePath(slot)) : m.loadState(this.statePath(slot));
      if (!started) throw new Error('busy');
      let result = 0;
      const deadline = performance.now() + 20000;
      while ((result = m.getStateResult()) === 0 && performance.now() < deadline) {
        await new Promise((r) => setTimeout(r, 30));
      }
      if (op === 'save' && result === 1) await this.persist();
      return result === 1;
    } finally {
      this.stateBusy = false;
    }
  }

  saveState(slot) {
    return this.runStateOp('save', slot);
  }

  loadState(slot) {
    return this.runStateOp('load', slot);
  }

  setOutputSize(w, h) {
    this.module?.setOutputSize(Math.round(w), Math.round(h));
  }

  setResolution(factor) {
    this.module?.setResolutionFactor(factor);
  }

  setFrameLimit(on) {
    this.module?.setFrameLimit(on);
  }

  setVolume(v) {
    this.module?.setVolume(v);
  }

  setPresentationMode(mode) {
    // 0 fill, 1 fit, 2 original
    this.module?.setPresentationMode(mode);
  }

  capture(width = 320) {
    const c = this.canvas;
    if (!c.width) return null;
    const out = document.createElement('canvas');
    out.width = width;
    out.height = Math.round((width * c.height) / c.width);
    out.getContext('2d').drawImage(c, 0, 0, out.width, out.height);
    return out;
  }
}
