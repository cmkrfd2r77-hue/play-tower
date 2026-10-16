// The game library: folders scanned from disk, single files, and homebrew pulled
// from GitHub. Records live in IndexedDB; file access comes from persisted
// File System Access handles (Chrome, Edge), cached blobs, or files picked this session.

import { db } from './store.js';
import { extensionOf, isGameFile, readDiscInfo } from './disc.js';
import { identifyFromName, lookupSerial, prettyTitle } from './gamedb.js';

const sessionFiles = new Map();
let games = [];
const listeners = new Set();

export const supportsFolderHandles = typeof window.showDirectoryPicker === 'function';

export function onLibraryChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit() {
  for (const fn of listeners) fn(games);
}

export async function loadLibrary() {
  games = await db.all('games');
  emit();
  return games;
}

export function getGames() {
  return games;
}

export function getGame(id) {
  return games.find((g) => g.id === id) || null;
}

export async function updateGame(id, patch) {
  const game = getGame(id);
  if (!game) return null;
  Object.assign(game, patch);
  await db.put('games', game);
  emit();
  return game;
}

export async function removeGame(id) {
  games = games.filter((g) => g.id !== id);
  sessionFiles.delete(id);
  await db.del('games', id);
  emit();
}

export async function clearLibrary() {
  games = [];
  sessionFiles.clear();
  await Promise.all([db.clear('games'), db.clear('dirs')]);
  emit();
}

async function upsert(records) {
  const byId = new Map(games.map((g) => [g.id, g]));
  for (const r of records) {
    const prev = byId.get(r.id);
    byId.set(r.id, prev ? { ...r, addedAt: prev.addedAt, lastPlayed: prev.lastPlayed, playTime: prev.playTime, favorite: prev.favorite } : r);
  }
  games = [...byId.values()];
  await db.putMany('games', records.map((r) => byId.get(r.id)));
  emit();
}

async function describe(file) {
  const ext = extensionOf(file.name);
  const info = ext === 'elf' ? { serial: null, format: 'ELF' } : await readDiscInfo(file);
  let meta = info.serial ? await lookupSerial(info.serial) : null;
  if (!meta) meta = await identifyFromName(file.name);
  return {
    title: meta?.title || prettyTitle(file.name),
    serial: info.serial || meta?.serial || null,
    region: meta?.region || null,
    format: info.format,
    ext,
    fileName: file.name,
    size: file.size,
  };
}

// Folders ---------------------------------------------------------------

async function* walkHandle(dir, path = '', depth = 0) {
  if (depth > 6) return;
  for await (const [name, handle] of dir.entries()) {
    if (name.startsWith('.')) continue;
    const rel = path ? `${path}/${name}` : name;
    if (handle.kind === 'directory') yield* walkHandle(handle, rel, depth + 1);
    else if (isGameFile(name)) yield { handle, path: rel };
  }
}

export async function pickFolder(onProgress) {
  const dir = await window.showDirectoryPicker({ id: 'ps2-games', mode: 'read' });
  return scanFolder(dir, onProgress);
}

export async function scanFolder(dirHandle, onProgress, existingId) {
  let dirId = existingId;
  if (!dirId) {
    // Adding a folder that is already in the library rescans it instead of duplicating it.
    for (const dir of await db.all('dirs')) {
      let same = false;
      try {
        same = (await dir.handle?.isSameEntry?.(dirHandle)) === true;
      } catch {
        same = false;
      }
      if (same) {
        dirId = dir.id;
        break;
      }
    }
  }
  dirId ||= `${dirHandle.name}:${Date.now().toString(36)}`;
  await db.put('dirs', { id: dirId, name: dirHandle.name, handle: dirHandle, scannedAt: Date.now() });
  const found = [];
  let checked = 0;
  for await (const { handle, path } of walkHandle(dirHandle)) {
    checked++;
    onProgress?.({ checked, found: found.length, name: path });
    try {
      const file = await handle.getFile();
      const meta = await describe(file);
      const id = `dir:${dirId}:${path}`;
      found.push({ id, ...meta, source: 'folder', dirId, path, handle, addedAt: Date.now(), lastPlayed: 0, playTime: 0, favorite: false });
      sessionFiles.set(id, file);
    } catch (err) {
      console.warn('Skipped', path, err);
    }
  }
  onProgress?.({ checked, found: found.length, done: true });
  await upsert(found);
  return found;
}

export async function getFolders() {
  return db.all('dirs');
}

export async function removeFolder(dirId) {
  const ids = games.filter((g) => g.dirId === dirId).map((g) => g.id);
  for (const id of ids) await removeGame(id);
  await db.del('dirs', dirId);
}

export async function rescanFolder(dirId, onProgress) {
  const dir = await db.get('dirs', dirId);
  if (!dir) return [];
  if (!(await ensurePermission(dir.handle))) return [];
  return scanFolder(dir.handle, onProgress, dirId);
}

async function ensurePermission(handle) {
  try {
    if ((await handle.queryPermission({ mode: 'read' })) === 'granted') return true;
    return (await handle.requestPermission({ mode: 'read' })) === 'granted';
  } catch {
    return false;
  }
}

// Files picked or dropped -------------------------------------------------

// items: array of { file, handle?, path? }
export async function addFiles(items, onProgress) {
  const added = [];
  let checked = 0;
  for (const { file, handle } of items) {
    checked++;
    if (!isGameFile(file.name)) continue;
    onProgress?.({ checked, found: added.length, name: file.name });
    const meta = await describe(file);
    const existing = games.find((g) => g.fileName === file.name && g.size === file.size);
    const id = existing?.id || `file:${file.name}:${file.size}`;
    const record = { id, ...meta, source: existing?.source || 'file', addedAt: Date.now(), lastPlayed: 0, playTime: 0, favorite: false };
    if (existing?.dirId) Object.assign(record, { dirId: existing.dirId, path: existing.path });
    if (handle) record.handle = handle;
    else if (existing?.handle) record.handle = existing.handle;
    if (meta.ext === 'elf' && file.size < 64 * 1024 * 1024) {
      // ELFs are small: keep a copy so they play again without picking the file.
      record.blobId = `blob:${id}`;
      await db.put('blobs', { id: record.blobId, name: file.name, data: file });
    }
    sessionFiles.set(id, file);
    added.push(record);
  }
  onProgress?.({ checked, found: added.length, done: true });
  await upsert(added);
  return added;
}

async function collectEntry(entry, out, path = '') {
  if (entry.isFile) {
    const file = await new Promise((res, rej) => entry.file(res, rej));
    out.push({ file, path: path + entry.name });
  } else if (entry.isDirectory) {
    const reader = entry.createReader();
    let batch;
    do {
      batch = await new Promise((res, rej) => reader.readEntries(res, rej));
      for (const child of batch) await collectEntry(child, out, `${path}${entry.name}/`);
    } while (batch.length > 0);
  }
}

// Turns a drop event into folders to scan and files to add.
export async function readDrop(dataTransfer) {
  const folders = [];
  const files = [];
  const items = [...(dataTransfer.items || [])].filter((i) => i.kind === 'file');
  // The drop data is only readable synchronously, so take everything before the first await.
  const entries = items.map((i) => (i.webkitGetAsEntry ? i.webkitGetAsEntry() : null));
  const plain = items.map((i) => i.getAsFile());
  const handlePromises = items[0]?.getAsFileSystemHandle ? items.map((i) => i.getAsFileSystemHandle().catch(() => null)) : [];
  const handles = await Promise.all(handlePromises);
  for (let i = 0; i < items.length; i++) {
    const handle = handles[i];
    if (handle?.kind === 'directory') folders.push(handle);
    else if (handle?.kind === 'file') files.push({ file: await handle.getFile(), handle });
    else if (entries[i]?.isDirectory) await collectEntry(entries[i], files);
    else if (plain[i]) files.push({ file: plain[i] });
  }
  return { folders, files };
}

// Getting the bytes to play -----------------------------------------------

// Returns a File/Blob for the game, or null when the user must pick it again.
export async function getGameFile(game) {
  const live = sessionFiles.get(game.id);
  if (live) return live;
  if (game.blobId) {
    const blob = await db.get('blobs', game.blobId);
    if (blob?.data) return blob.data;
  }
  if (game.handle) {
    const dir = game.dirId ? await db.get('dirs', game.dirId) : null;
    const ok = await ensurePermission(dir?.handle || game.handle);
    if (ok) {
      try {
        const file = await game.handle.getFile();
        sessionFiles.set(game.id, file);
        return file;
      } catch (err) {
        console.warn('Handle no longer valid', err);
      }
    }
  }
  return null;
}

export function rememberFile(game, file) {
  sessionFiles.set(game.id, file);
}

// Homebrew from GitHub ----------------------------------------------------

let catalogPromise = null;

export function loadHomebrewCatalog() {
  if (!catalogPromise) {
    catalogPromise = fetch('data/homebrew.json').then((r) => r.json()).then((d) => d.items || []).catch(() => []);
  }
  return catalogPromise;
}

async function download(url, onProgress) {
  const res = await fetch(url, { mode: 'cors' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  if (!res.body || !total) return res.blob();
  const reader = res.body.getReader();
  const parts = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    received += value.length;
    onProgress?.(Math.min(1, received / total));
  }
  return new Blob(parts);
}

export async function installCatalogItem(item, source, onProgress) {
  const data = await download(item.url, onProgress);
  const fileName = item.url.split('/').pop();
  const id = source === 'homebrew' ? `hb:${item.id}` : `repo:${item.repo}:${item.path}`;
  const blobId = `blob:${id}`;
  await db.put('blobs', { id: blobId, name: fileName, data });
  const record = {
    id,
    title: item.title,
    serial: null,
    region: null,
    format: extensionOf(fileName).toUpperCase(),
    ext: extensionOf(fileName),
    fileName,
    size: data.size,
    source,
    blobId,
    image: item.image || null,
    author: item.author || item.repo,
    repo: item.repo,
    license: item.license || null,
    addedAt: Date.now(),
    lastPlayed: 0,
    playTime: 0,
    favorite: false,
  };
  await upsert([record]);
  return getGame(id);
}

export async function getRepoSources() {
  return db.all('sources');
}

export async function removeRepoSource(id) {
  await db.del('sources', id);
}

// Lists ELF and ISO files in a public GitHub repository through the GitHub API.
export async function scanGithubRepo(input) {
  const repo = input.trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/$/, '');
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('bad-repo');
  const api = `https://api.github.com/repos/${repo}`;
  const info = await fetch(api).then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); });
  const branch = info.default_branch;
  const tree = await fetch(`${api}/git/trees/${encodeURIComponent(branch)}?recursive=1`).then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); });
  const items = (tree.tree || [])
    .filter((n) => n.type === 'blob' && ['elf', 'iso'].includes(extensionOf(n.path)) && n.size > 1024 && n.size < 1024 ** 3)
    .slice(0, 60)
    .map((n) => ({
      id: `${repo}:${n.path}`,
      title: prettyTitle(n.path.split('/').pop()),
      path: n.path,
      repo,
      author: repo.split('/')[0],
      license: info.license?.spdx_id && info.license.spdx_id !== 'NOASSERTION' ? info.license.spdx_id : null,
      url: `https://raw.githubusercontent.com/${repo}/${encodeURIComponent(branch)}/${n.path.split('/').map(encodeURIComponent).join('/')}`,
      size: n.size,
      kind: extensionOf(n.path) === 'elf' ? 'elf' : 'disc',
      desc: info.description ? { ar: info.description, en: info.description } : null,
    }));
  const source = { id: repo, name: repo, description: info.description || '', stars: info.stargazers_count || 0, license: info.license?.spdx_id || null, items, scannedAt: Date.now() };
  await db.put('sources', source);
  return source;
}
