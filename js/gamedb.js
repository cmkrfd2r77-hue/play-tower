// Game metadata: titles and regions (PCSX2 GameIndex), compatibility with the Play!
// core (Play-Compatibility tracker) and cover art (xlenore/ps2-covers), all from GitHub.

import { normalizeSerial } from './disc.js';

const COVER_BASE = 'https://raw.githubusercontent.com/xlenore/ps2-covers/main/covers';

let gamesPromise = null;
let compatPromise = null;
let titleIndex = null;

export function loadGameDb() {
  if (!gamesPromise) {
    gamesPromise = fetch('data/gamedb.json')
      .then((r) => (r.ok ? r.json() : { games: {} }))
      .then((d) => d.games || {})
      .catch(() => ({}));
  }
  return gamesPromise;
}

export function loadCompat() {
  if (!compatPromise) {
    compatPromise = fetch('data/compat.json')
      .then((r) => (r.ok ? r.json() : { games: {} }))
      .then((d) => d.games || {})
      .catch(() => ({}));
  }
  return compatPromise;
}

export async function lookupSerial(serial) {
  if (!serial) return null;
  const games = await loadGameDb();
  const hit = games[serial];
  return hit ? { serial, title: hit[0], region: hit[1] } : null;
}

export async function compatFor(serial) {
  if (!serial) return null;
  const compat = await loadCompat();
  return compat[serial] || null;
}

function normalizeTitle(s) {
  return s
    .toLowerCase()
    .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9À-ɏ぀-ヿ一-鿿]+/g, ' ')
    .replace(/^the /, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function regionHint(name) {
  const s = name.toLowerCase();
  if (/\b(usa|us|ntsc-u|america)\b/.test(s)) return 'U';
  if (/\b(europe|eur|pal|uk|france|germany|spain|italy|en,fr|australia)\b/.test(s)) return 'E';
  if (/\b(japan|jpn|ntsc-j|jp)\b/.test(s)) return 'J';
  if (/\b(korea|kor)\b/.test(s)) return 'K';
  return null;
}

async function getTitleIndex() {
  if (titleIndex) return titleIndex;
  const games = await loadGameDb();
  titleIndex = new Map();
  for (const [serial, [title, region]] of Object.entries(games)) {
    const key = normalizeTitle(title);
    if (!titleIndex.has(key)) titleIndex.set(key, []);
    titleIndex.get(key).push({ serial, region });
  }
  return titleIndex;
}

// Identify a game from its file name when the disc itself cannot be read (CHD, ISZ)
// or carries no serial. Accepts names like "SLUS_200.62.Grand Theft Auto 3.iso" or
// "Shadow of the Colossus (USA).iso".
export async function identifyFromName(fileName) {
  const base = fileName.replace(/\.[^.]+$/, '');
  const serial = normalizeSerial(base);
  if (serial) {
    const hit = await lookupSerial(serial);
    if (hit) return hit;
  }
  const index = await getTitleIndex();
  const candidates = index.get(normalizeTitle(base));
  if (!candidates || candidates.length === 0) return null;
  const hint = regionHint(base);
  const pick = candidates.find((c) => c.region === hint) || candidates.find((c) => c.region === 'U') || candidates[0];
  return lookupSerial(pick.serial);
}

export function coverUrl(serial) {
  return serial ? `${COVER_BASE}/default/${serial}.jpg` : null;
}

export function cover3dUrl(serial) {
  return serial ? `${COVER_BASE}/3d/${serial}.png` : null;
}

export function prettyTitle(fileName) {
  return fileName
    .replace(/\.[^.]+$/, '')
    .replace(/^[A-Z]{4}[_-]\d{3}\.?\d{2}[ ._-]*/i, '')
    .replace(/[_.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim() || fileName;
}
