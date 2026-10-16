import { t, setLang, getLang, formatBytes, timeAgo, formatDuration, formatNumber } from './i18n.js';
import { db, loadSettings, getSettings, saveSettings, requestPersistentStorage } from './store.js';
import {
  loadLibrary, getGames, getGame, updateGame, removeGame, clearLibrary, onLibraryChange,
  supportsFolderHandles, pickFolder, scanFolder, addFiles, readDrop, getGameFile, rememberFile,
  loadHomebrewCatalog, installCatalogItem, getFolders, removeFolder, rescanFolder,
  getRepoSources, removeRepoSource, scanGithubRepo,
} from './library.js';
import { loadCompat, loadGameDb, coverUrl, cover3dUrl } from './gamedb.js';
import { Emulator, resumeAudio } from './emulator.js';
import { InputManager, KEY_ACTIONS, DEFAULT_KEYS, keyLabel, BTN } from './input.js';
import { startAmbient, playBoot } from './towers.js';
import { isGameFile } from './disc.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icon = (name) => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;

const state = {
  view: 'library',
  query: '',
  catalog: [],
  compat: {},
  compatLoaded: false,
  sources: [],
  installing: new Map(),
  session: null, // { game, startedAt, playMs }
  ff: false,
};

const settings = loadSettings();
const input = new InputManager();
const emu = new Emulator($('#outputCanvas'));
input.attach(emu);
input.setKeys(settings.keys);
let ambient = null;

// Toasts and dialogs ------------------------------------------------------

function toast(message, { kind = '', glyph = '', progress = null, timeout = 3600, inPlayer = false } = {}) {
  const host = inPlayer && !$('#player').hidden ? $('#player-toast') : $('#toasts');
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.setAttribute('role', 'status');
  const render = (msg, p) => {
    el.innerHTML = `${glyph ? `<span class="glyph g-${glyph}">${{ crs: '✕', cir: '○', tri: '△', sqr: '□' }[glyph]}</span>` : ''}<span>${esc(msg)}</span>${p !== null && p !== undefined ? `<div class="progress" style="--p:${Math.round(p * 100)}%"><i></i></div>` : ''}`;
  };
  render(message, progress);
  host.append(el);
  let timer = progress === null ? setTimeout(() => el.remove(), timeout) : null;
  return {
    update(msg, p) { render(msg, p); },
    close(msg, opts = {}) {
      if (msg) render(msg, null);
      if (opts.kind) el.className = `toast ${opts.kind}`;
      clearTimeout(timer);
      timer = setTimeout(() => el.remove(), msg ? 2600 : 0);
    },
  };
}

function modal(html, wire) {
  const host = $('#modal');
  const card = $('#modal-card');
  card.innerHTML = html;
  host.hidden = false;
  const prevFocus = document.activeElement;
  return new Promise((resolve) => {
    const close = (value) => {
      host.hidden = true;
      card.innerHTML = '';
      prevFocus?.focus?.();
      resolve(value);
    };
    host.onclick = (e) => { if (e.target === host) close(null); };
    host.closeModal = close;
    wire(card, close);
    ($('.btn.primary', card) || $('button', card))?.focus();
  });
}

function confirmDialog(text, okLabel) {
  return modal(`<h2>${esc(text)}</h2><div class="modal-actions"><button class="btn" data-a="no">${esc(t('cancel'))}</button><button class="btn primary" data-a="yes">${esc(okLabel)}</button></div>`, (card, close) => {
    card.addEventListener('click', (e) => {
      const a = e.target.closest('[data-a]')?.dataset.a;
      if (a) close(a === 'yes');
    });
  });
}

function repickDialog(game) {
  return modal(`<h2>${esc(t('repickTitle'))}</h2><p>${esc(t('repickBody', { file: game.fileName }))}</p><div class="modal-actions"><button class="btn" data-a="no">${esc(t('cancel'))}</button><button class="btn primary" data-a="pick">${icon('disc')}${esc(t('choose'))}</button></div>`, (card, close) => {
    card.addEventListener('click', (e) => {
      const a = e.target.closest('[data-a]')?.dataset.a;
      if (a === 'no') close(null);
      if (a === 'pick') {
        const picker = document.createElement('input');
        picker.type = 'file';
        picker.accept = `.${game.ext}`;
        picker.onchange = () => close(picker.files[0] || null);
        picker.click();
      }
    });
  });
}

// Covers ------------------------------------------------------------------

function hue(text) {
  let h = 0;
  for (const ch of text || '') h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

function genCover(game) {
  const tag = game.source === 'homebrew' || game.source === 'repo' ? 'HOMEBREW' : (game.format || 'PS2');
  return `<div class="gen-cover" style="--h:${hue(game.title)}"><div class="spine"><b>${esc(tag)}</b></div><div class="gen-title">${esc(game.title)}</div></div>`;
}

function caseArt(game) {
  if (game.serial) {
    return `${genCover(game)}<img class="cover" crossorigin="anonymous" loading="lazy" alt="" src="${coverUrl(game.serial)}" data-fallback="gen">`;
  }
  if (game.image) {
    return `${genCover(game)}<img class="shot" crossorigin="anonymous" loading="lazy" alt="" src="${esc(game.image)}" data-fallback="hide">`;
  }
  return genCover(game);
}

document.addEventListener('error', (e) => {
  const img = e.target;
  if (!(img instanceof HTMLImageElement) || !img.dataset.fallback) return;
  const fb = img.dataset.fallback;
  if (fb.startsWith('http')) {
    img.dataset.fallback = img.dataset.fallback2 || 'gen';
    img.classList.remove('cover3d');
    img.classList.add('cover');
    img.src = fb;
  } else {
    img.remove();
  }
}, true);

// Library view ------------------------------------------------------------

function compatOf(game) {
  if (!game.serial || !state.compatLoaded) return null;
  return state.compat[game.serial]?.state || 'unknown';
}

function virtualHomebrew() {
  const installed = new Set(getGames().map((g) => g.id));
  return state.catalog
    .filter((item) => !installed.has(`hb:${item.id}`))
    .map((item) => ({
      id: `hb:${item.id}`, virtual: true, item, title: item.title, source: 'homebrew', format: 'ELF', ext: 'elf',
      image: item.image || null, author: item.author, license: item.license, size: item.size, addedAt: 0, lastPlayed: 0,
    }));
}

function visibleGames() {
  const { filter, sort } = getSettings();
  let list = getGames().slice();
  if (filter === 'all' || filter === 'homebrew') list = list.concat(virtualHomebrew());
  if (filter === 'recent') list = list.filter((g) => g.lastPlayed);
  if (filter === 'fav') list = list.filter((g) => g.favorite);
  if (filter === 'homebrew') list = list.filter((g) => g.source === 'homebrew' || g.source === 'repo' || g.ext === 'elf');
  const q = state.query.trim().toLowerCase();
  if (q) list = list.filter((g) => `${g.title} ${g.serial || ''} ${g.fileName || ''}`.toLowerCase().includes(q));
  const by = {
    recent: (a, b) => (b.lastPlayed || 0) - (a.lastPlayed || 0) || (b.addedAt || 0) - (a.addedAt || 0),
    name: (a, b) => a.title.localeCompare(b.title),
    added: (a, b) => (b.addedAt || 0) - (a.addedAt || 0),
  }[sort] || (() => 0);
  list.sort((a, b) => (a.virtual === b.virtual ? by(a, b) : a.virtual ? 1 : -1));
  return list;
}

function findGame(id) {
  return getGame(id) || virtualHomebrew().find((g) => g.id === id) || null;
}

function renderGrid() {
  const list = visibleGames();
  const focusId = getSettings().focusId;
  $('#count').textContent = t('gamesCount', { n: formatNumber(list.length) });
  if (list.length === 0) {
    $('#grid').innerHTML = `<div class="empty-shelf">${esc(state.query ? `“${state.query}”` : t('emptyTitle'))}</div>`;
    return;
  }
  $('#grid').innerHTML = list.map((g) => {
    const c = compatOf(g);
    return `<button class="card${g.id === focusId ? ' focused' : ''}" role="listitem" data-id="${esc(g.id)}" aria-label="${esc(g.title)}">
      <div class="case">${caseArt(g)}${g.favorite ? `<span class="badge">${icon('star-fill')}</span>` : ''}</div>
      <span class="card-title">${esc(g.title)}</span>
      <span class="card-sub">${c ? `<i class="dot c-${c}"></i>` : ''}<span class="mono">${esc(g.serial || (g.virtual ? 'GitHub · ELF' : g.format || ''))}</span></span>
    </button>`;
  }).join('');
}

function renderHero() {
  const hero = $('#hero');
  const list = visibleGames();
  let game = findGame(getSettings().focusId);
  if (!game && state.session?.game) game = findGame(state.session.game.id);
  if (!game && getGames().length) game = list.find((g) => !g.virtual) || null;
  if (!game) {
    renderEmptyHero(hero);
    return;
  }
  const c = compatOf(game);
  const running = state.session?.game?.id === game.id && emu.game;
  const sourceKey = { folder: 'sourceFolder', file: 'sourceFile', homebrew: 'sourceHomebrew', repo: 'sourceRepo' }[game.source] || 'sourceFile';
  const desc = game.item?.desc?.[getLang()] || state.catalog.find((i) => `hb:${i.id}` === game.id)?.desc?.[getLang()] || '';
  const wash = game.serial ? coverUrl(game.serial) : game.image;
  hero.className = 'hero';
  hero.innerHTML = `
    ${wash ? `<div class="hero-wash" style="background-image:url('${esc(wash)}')"></div>` : ''}
    <div class="hero-art"><div class="case" id="hero-case" data-serial="${esc(game.serial || '')}">${caseArt(game)}</div></div>
    <div class="hero-info">
      <div class="chips-row">
        ${game.region ? `<span class="chip">${esc(t(`region_${game.region}`))}</span>` : ''}
        ${c ? `<span class="chip c-${c}"><i class="dot"></i>${esc(t(`compat_${c}`))}</span>` : ''}
        <span class="chip">${esc(t(sourceKey))}</span>
        ${game.license ? `<span class="chip">${esc(game.license)}</span>` : ''}
      </div>
      <h1 class="hero-title">${esc(game.title)}</h1>
      <div class="hero-meta">
        ${game.serial ? `<span class="mono">${esc(game.serial)}</span>` : ''}
        ${game.format ? `<span>${esc(game.format)}${game.size ? ` · <span class="mono">${esc(formatBytes(game.size))}</span>` : ''}</span>` : ''}
        ${game.author ? `<span>${esc(t('by', { a: game.author }))}</span>` : ''}
        <span>${esc(game.lastPlayed ? t('lastPlayed', { when: timeAgo(game.lastPlayed) }) : t('neverPlayed'))}</span>
        ${game.playTime ? `<span>${esc(t('playTime', { t: formatDuration(game.playTime) }))}</span>` : ''}
      </div>
      ${desc ? `<p class="hero-desc">${esc(desc)}</p>` : ''}
      <div class="hero-actions">
        <button class="btn primary big" data-act="play" data-id="${esc(game.id)}">${icon('play')}<span>${esc(running ? t('resume') : t('play'))}</span></button>
        ${game.virtual ? '' : `<button class="btn" data-act="fav" data-id="${esc(game.id)}">${icon(game.favorite ? 'star-fill' : 'star')}<span>${esc(game.favorite ? t('unfavorite') : t('favorite'))}</span></button>
        <button class="icon-btn" data-act="remove" data-id="${esc(game.id)}" title="${esc(t('remove'))}" aria-label="${esc(t('remove'))}">${icon('trash')}</button>`}
      </div>
      <div class="pad-hints" id="pad-hints" ${input.connectedPads().length ? '' : 'hidden'}>
        <span><i class="glyph g-crs">✕</i>${esc(t('hintPlay'))}</span>
        <span><i class="glyph g-tri">△</i>${esc(t('hintFav'))}</span>
        <span><b class="mono">START</b>${esc(t('hintMenu'))}</span>
      </div>
    </div>`;
  if (game.serial) upgradeHeroArt(game.serial);
}

// Swap the flat case for the 3D box art when the cover repository has one.
const art3d = new Map();
function upgradeHeroArt(serial) {
  const apply = () => {
    const box = $('#hero-case');
    if (!box || box.dataset.serial !== serial || art3d.get(serial) !== true) return;
    box.classList.add('free');
    box.innerHTML = `<img class="cover3d" crossorigin="anonymous" alt="" src="${cover3dUrl(serial)}">`;
  };
  if (art3d.has(serial)) { apply(); return; }
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => { art3d.set(serial, true); apply(); };
  img.onerror = () => art3d.set(serial, false);
  img.src = cover3dUrl(serial);
}

function renderEmptyHero(hero) {
  hero.className = 'hero hero-empty';
  hero.innerHTML = `
    <div class="hero-info">
      <div class="chips-row"><span class="chip">${esc(t('tagline'))}</span></div>
      <h1 class="hero-title">${esc(t('emptyTitle'))}</h1>
      <p class="hero-desc">${esc(t('emptyBody'))}</p>
      <div class="hero-actions">
        <button class="btn primary big" data-act="add-folder">${icon('folder')}<span>${esc(t('addFolder'))}</span></button>
        <button class="btn big" data-act="play" data-id="hb:glampert-dungeon">${icon('play')}<span>${esc(t('tryHomebrew'))}</span></button>
      </div>
    </div>
    <div class="hero-art"><div class="drop-hint">${icon('disc')}<b>${esc(t('dropTitle'))}</b><span class="formats">${esc(t('emptyFolderHint'))}</span></div></div>`;
}

function renderLibrary() {
  renderHero();
  renderGrid();
  for (const b of $$('#filters .filter')) b.setAttribute('aria-pressed', String(b.dataset.filter === getSettings().filter));
  $('#sort').value = getSettings().sort;
}

function setFocus(id, { scroll = false } = {}) {
  if (getSettings().focusId === id) return;
  saveSettings({ focusId: id });
  for (const card of $$('#grid .card')) card.classList.toggle('focused', card.dataset.id === id);
  renderHero();
  if (scroll) $(`#grid .card[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

// Store view --------------------------------------------------------------

function storeCard(item, source) {
  const id = source === 'homebrew' ? `hb:${item.id}` : `repo:${item.repo}:${item.path}`;
  const installed = getGame(id);
  const progress = state.installing.get(id);
  const desc = item.desc?.[getLang()] || '';
  const kind = item.kind === 'game' ? 'Game' : item.kind === 'disc' ? 'ISO' : item.kind === 'elf' ? 'ELF' : 'Demo';
  return `<article class="store-item">
    <div class="store-shot">${item.image ? `<img crossorigin="anonymous" loading="lazy" alt="" src="${esc(item.image)}" data-fallback="hide">` : genCover({ title: item.title, source: 'homebrew' })}<span class="chip store-kind">${esc(kind)}</span></div>
    <div class="store-body">
      <h3>${esc(item.title)}</h3>
      ${desc ? `<p>${esc(desc)}</p>` : '<p></p>'}
      ${progress !== undefined ? `<div class="progress" style="--p:${Math.round(progress * 100)}%"><i></i></div>` : ''}
      <div class="store-foot">
        <span class="by">${esc(t('by', { a: item.author || item.repo }))}${item.license ? ` · ${esc(item.license)}` : ''} · <span class="mono">${esc(formatBytes(item.size))}</span></span>
        ${installed
          ? `<button class="btn primary" data-act="play" data-id="${esc(id)}">${icon('play')}<span>${esc(t('play'))}</span></button>`
          : `<button class="btn" data-act="install" data-source="${source}" data-id="${esc(id)}" ${progress !== undefined ? 'disabled' : ''}>${icon('download')}<span>${esc(progress !== undefined ? t('downloading', { p: Math.round(progress * 100) }) : t('install'))}</span></button>`}
      </div>
    </div>
  </article>`;
}

function renderStore() {
  $('#store-grid').innerHTML = state.catalog.map((item) => storeCard(item, 'homebrew')).join('');
  $('#repo-sources').innerHTML = state.sources.map((src) => `
    <section class="source">
      <div class="source-head"><b>${icon('github')} ${esc(src.name)}</b><button class="btn" data-act="remove-source" data-id="${esc(src.id)}">${esc(t('removeSource'))}</button></div>
      ${src.description ? `<p class="repo-hint">${esc(src.description)}</p>` : ''}
      ${src.items.length ? `<div class="store-grid">${src.items.map((item) => storeCard(item, 'repo')).join('')}</div>` : `<p class="repo-hint">${esc(t('repoNone', { r: src.name }))}</p>`}
    </section>`).join('');
}

function catalogItemFor(id) {
  if (id.startsWith('hb:')) return { item: state.catalog.find((i) => `hb:${i.id}` === id), source: 'homebrew' };
  for (const src of state.sources) {
    const item = src.items.find((i) => `repo:${i.repo}:${i.path}` === id);
    if (item) return { item, source: 'repo' };
  }
  return { item: null, source: null };
}

async function install(id) {
  const { item, source } = catalogItemFor(id);
  if (!item || state.installing.has(id)) return getGame(id);
  state.installing.set(id, 0);
  renderStore();
  const note = toast(t('downloading', { p: 0 }), { progress: 0 });
  try {
    let last = 0;
    const game = await installCatalogItem(item, source, (p) => {
      state.installing.set(id, p);
      note.update(`${item.title} · ${t('downloading', { p: Math.round(p * 100) })}`, p);
      if (p - last > 0.04) { last = p; renderStore(); }
    });
    note.close(`${item.title} · ${t('installed')}`);
    return game;
  } catch (err) {
    console.error(err);
    note.close(t('downloadFailed', { name: item.title }), { kind: 'bad' });
    return null;
  } finally {
    state.installing.delete(id);
    renderStore();
  }
}

// Views -------------------------------------------------------------------

function showView(view) {
  state.view = view;
  $('#view-library').hidden = view !== 'library';
  $('#view-store').hidden = view !== 'store';
  for (const tab of $$('.tab')) tab.setAttribute('aria-selected', String(tab.dataset.view === view));
  if (view === 'store') renderStore();
  else renderLibrary();
}

// Adding games ------------------------------------------------------------

function scanToast() {
  const note = toast(t('scanTitle'), { progress: 0 });
  return {
    progress({ checked, found, done }) {
      if (!done) note.update(`${t('scanTitle')} · ${t('scanProgress', { n: formatNumber(checked), g: formatNumber(found) })}`, null);
    },
    finish(count) {
      note.close(count ? t('scanDone', { n: formatNumber(count) }) : t('scanNone'), { kind: count ? '' : 'bad' });
    },
    cancel() {
      note.close();
    },
  };
}

async function addFolder() {
  if (supportsFolderHandles) {
    let found;
    const note = scanToast();
    try {
      found = await pickFolder((p) => note.progress(p));
    } catch (err) {
      if (err?.name === 'AbortError') note.cancel();
      else {
        console.error(err);
        note.finish(0);
      }
      return;
    }
    note.finish(found.length);
    afterAdd(found);
  } else {
    toast(t('unsupportedFolder'), { timeout: 6000 });
    $('#dir-input').click();
  }
}

async function addPicked(fileList, { launchSingle = false, fromFolder = false } = {}) {
  const files = [...fileList].map((file) => ({ file }));
  if (!fromFolder) for (const { file } of files) if (!isGameFile(file.name)) toast(t('fileUnsupported', { name: file.name }), { kind: 'bad' });
  const note = scanToast();
  const added = await addFiles(files, (p) => note.progress(p));
  note.finish(added.length);
  afterAdd(added);
  if (launchSingle && added.length === 1) launch(added[0].id);
}

function afterAdd(added) {
  if (!added.length) return;
  requestPersistentStorage();
  if (state.view !== 'library') showView('library');
  setFocus(added[0].id, { scroll: true });
  renderLibrary();
}

// Player ------------------------------------------------------------------

const player = $('#player');
let idleTimer = 0;
let fpsTimer = 0;

function markActive() {
  player.classList.remove('idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if ($('#pause-menu').hidden && $('#hud-vol-range').hidden && !$('#hud').matches(':hover')) player.classList.add('idle');
    else markActive();
  }, 2600);
}
player.addEventListener('pointermove', (e) => { if (e.pointerType === 'mouse') markActive(); });
player.addEventListener('pointerdown', (e) => { if (!e.target.closest('.tp')) markActive(); });
// Keep the touch shoulder buttons below the HUD, whatever its height.
new ResizeObserver(() => player.style.setProperty('--hud-h', `${$('#hud').offsetHeight}px`)).observe($('#hud'));

function layoutCanvas() {
  if (player.hidden) return;
  const { aspect, resolution } = getSettings();
  const W = player.clientWidth;
  const H = player.clientHeight;
  let w = W;
  let h = H;
  if (aspect !== 'stretch') {
    const ratio = aspect === '16:9' ? 16 / 9 : 4 / 3;
    if (W / H > ratio) w = Math.round(H * ratio);
    else h = Math.round(W / ratio);
  }
  const canvas = $('#outputCanvas');
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  if (emu.ready) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const scale = Math.min(dpr, 2560 / w);
    emu.setOutputSize(w * scale, h * scale);
    emu.setPresentationMode(aspect === '4:3' ? 1 : 0);
    emu.setResolution(resolution);
  }
}
window.addEventListener('resize', layoutCanvas);

function touchWanted() {
  const mode = getSettings().touch;
  if (mode === 'on') return true;
  if (mode === 'off') return false;
  return window.matchMedia('(pointer: coarse)').matches && input.connectedPads().length === 0;
}

function updateTouch() {
  const pad = $('#touchpad');
  pad.hidden = !touchWanted() || player.hidden;
  pad.style.setProperty('--touch-opacity', getSettings().touchOpacity);
  $('#hud-touch').classList.toggle('on', !pad.hidden);
}

function drawSpark() {
  const c = $('#fps-spark');
  const ctx = c.getContext('2d');
  const hist = emu.fpsHistory;
  ctx.clearRect(0, 0, c.width, c.height);
  if (hist.length < 2) return;
  const max = Math.max(62, ...hist);
  const step = c.width / 59;
  ctx.beginPath();
  hist.forEach((v, i) => {
    const x = i * step;
    const y = c.height - 3 - (v / max) * (c.height - 6);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = '#b3ceff';
  ctx.stroke();
  ctx.lineTo((hist.length - 1) * step, c.height);
  ctx.lineTo(0, c.height);
  ctx.closePath();
  ctx.fillStyle = 'rgba(130, 169, 255, 0.18)';
  ctx.fill();
  const lx = (hist.length - 1) * step;
  const ly = c.height - 3 - (hist[hist.length - 1] / max) * (c.height - 6);
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  ctx.arc(lx - 2, ly, 3, 0, Math.PI * 2);
  ctx.fill();
}

function startFpsMeter() {
  clearInterval(fpsTimer);
  emu.sampleFps();
  fpsTimer = setInterval(() => {
    if (!emu.running) return;
    const fps = emu.sampleFps();
    const target = state.session?.game?.region === 'E' ? 50 : 60;
    $('#fps-value').textContent = fps;
    $('#fps-speed').textContent = `${Math.round((fps / target) * 100)}%`;
    drawSpark();
  }, 1000);
  $('#hud-fps').hidden = !getSettings().showFps;
}

function setBootStatus(text, progress) {
  $('#boot-status').textContent = text;
  $('#boot-bar').style.width = `${Math.round((progress ?? 0) * 100)}%`;
}

function enterPlayer(game) {
  document.activeElement?.blur?.();
  player.hidden = false;
  document.body.style.overflow = 'hidden';
  ambient?.pause();
  $('#hud-name').textContent = game.title;
  $('#hud-serial').textContent = game.serial || game.format || '';
  $('#pause-title').textContent = game.title;
  player.classList.toggle('pixelated', !getSettings().smooth);
  updateTouch();
  markActive();
}

function leavePlayer() {
  closePauseMenu(false);
  player.hidden = true;
  document.body.style.overflow = '';
  input.setInGame(false);
  ambient?.resume();
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
}

function accumulatePlayTime() {
  const s = state.session;
  if (!s || !s.startedAt) return;
  const ms = Date.now() - s.startedAt;
  s.startedAt = 0;
  const game = getGame(s.game.id);
  if (game) updateGame(game.id, { playTime: (game.playTime || 0) + ms });
}

let launching = false;

async function launch(id) {
  if (launching) return;
  launching = true;
  try {
    await launchGame(id);
  } finally {
    launching = false;
  }
}

async function launchGame(id) {
  let game = findGame(id);
  if (!game) return;
  if (!globalThis.crossOriginIsolated) {
    await modal(`<h2>${esc(t('isolationNo'))}</h2><p>${esc(t('isolationNoBody'))}</p><div class="modal-actions"><button class="btn primary" data-a="ok">${esc(t('close'))}</button></div>`, (card, close) => card.addEventListener('click', (e) => { if (e.target.closest('[data-a]')) close(); }));
    return;
  }
  resumeAudio();
  if (state.session?.game?.id === game.id && emu.game?.id === game.id) {
    enterPlayer(game);
    layoutCanvas();
    input.setInGame(true);
    emu.resume();
    state.session.startedAt = Date.now();
    $('#outputCanvas').focus();
    return;
  }
  if (game.virtual) {
    game = await install(game.id);
    if (!game) return;
    setFocus(game.id);
  }
  let file = await getGameFile(game);
  if (!file) {
    file = await repickDialog(game);
    if (!file) return;
    rememberFile(game, file);
  }

  accumulatePlayTime();
  enterPlayer(game);
  const boot = $('#boot');
  boot.hidden = false;
  boot.classList.remove('fade');
  $('#boot-title').textContent = game.title;
  const anim = playBoot($('#boot-canvas'));
  try {
    if (!emu.ready) {
      await emu.load(({ stage, progress }) => {
        if (stage === 'download') setBootStatus(t('loadingCore', { p: `${Math.round(progress * 100)}%` }), progress);
        else setBootStatus(t('startingVm'), 1);
      });
      updateStatus();
    }
    setBootStatus(t('booting'), 1);
    layoutCanvas();
    emu.setVolume(getSettings().volume);
    emu.setFrameLimit(getSettings().frameLimit);
    state.ff = false;
    $('#hud-ff').classList.remove('on');
    await emu.boot(game, file);
    state.session = { game, startedAt: Date.now() };
    input.setInGame(true);
    startFpsMeter();
    updateGame(game.id, { lastPlayed: Date.now() });
    // Reveal once the console draws its first frames (or after a few seconds).
    const t0 = performance.now();
    let frames = 0;
    await anim.done;
    while (performance.now() - t0 < 6000) {
      frames += emu.fpsHistory.at(-1) || 0;
      if (frames > 0) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    boot.classList.add('fade');
    setTimeout(() => { boot.hidden = true; anim.stop(); }, 650);
    $('#outputCanvas').focus();
  } catch (err) {
    console.error(err);
    anim.stop();
    boot.hidden = true;
    leavePlayer();
    toast(t('bootFailed', { name: game.title }), { kind: 'bad' });
  }
}

function exitToLibrary() {
  if (!state.session) { leavePlayer(); return; }
  emu.pause();
  accumulatePlayTime();
  leavePlayer();
  renderLibrary();
}

async function quitGame() {
  emu.pause();
  accumulatePlayTime();
  state.session = null;
  leavePlayer();
  renderLibrary();
}

// Pause menu and save states -----------------------------------------------

const SLOTS = [0, 1, 2, 3];

function stateKey() {
  const g = state.session?.game;
  return g ? (g.serial || g.id) : '';
}

async function renderSlots() {
  const key = stateKey();
  const thumbs = await Promise.all(SLOTS.map((s) => db.get('thumbs', `${key}:${s}`)));
  $('#slots').innerHTML = SLOTS.map((slot, i) => {
    const has = emu.hasState(slot);
    const thumb = thumbs[i];
    const when = has ? timeAgo((thumb?.at) || has.mtime?.getTime?.() || Date.now()) : '';
    return `<div class="slot">
      <div class="slot-thumb" style="${thumb?.data && has ? `background-image:url('${thumb.data}')` : ''}">${has ? '' : esc(t('emptySlot'))}</div>
      <div class="slot-meta"><b>${esc(slot === 0 ? t('quickSave') : t('slot', { n: formatNumber(slot) }))}</b><span>${esc(when)}</span></div>
      <div class="slot-actions">
        <button class="btn" data-act="save-slot" data-slot="${slot}">${icon('save')}<span>${esc(t('save'))}</span></button>
        <button class="btn" data-act="load-slot" data-slot="${slot}" ${has ? '' : 'disabled'}>${icon('load')}<span>${esc(t('loadSlot'))}</span></button>
      </div>
    </div>`;
  }).join('');
}

function openPauseMenu() {
  if (!state.session) return;
  $('#pause-menu').dir = document.documentElement.dir;
  emu.pause();
  accumulatePlayTime();
  input.setInGame(false);
  $('#pause-menu').hidden = false;
  player.classList.remove('idle');
  renderSlots();
  $('#pause-resume').focus();
}

function closePauseMenu(resume = true) {
  if ($('#pause-menu').hidden) return;
  $('#pause-menu').hidden = true;
  if (resume && state.session) {
    input.setInGame(true);
    emu.resume();
    state.session.startedAt = Date.now();
    $('#outputCanvas').focus();
    markActive();
  }
}

async function saveSlot(slot) {
  try {
    const thumb = emu.capture(320);
    const ok = await emu.saveState(slot);
    if (ok) {
      if (thumb) await db.put('thumbs', { id: `${stateKey()}:${slot}`, data: thumb.toDataURL('image/jpeg', 0.8), at: Date.now() });
      toast(t('saved', { n: slot === 0 ? t('quickSave') : formatNumber(slot) }), { glyph: 'tri', inPlayer: true });
    } else toast(t('saveFailed'), { kind: 'bad', inPlayer: true });
  } catch (err) {
    toast(err.message === 'busy' ? t('busyState') : t('saveFailed'), { kind: 'bad', inPlayer: true });
  }
  if (!$('#pause-menu').hidden) renderSlots();
}

async function loadSlot(slot) {
  if (!emu.hasState(slot)) { toast(t('loadFailed'), { kind: 'bad', inPlayer: true }); return; }
  try {
    const ok = await emu.loadState(slot);
    toast(ok ? t('loaded', { n: slot === 0 ? t('quickSave') : formatNumber(slot) }) : t('loadFailed'), { kind: ok ? '' : 'bad', glyph: ok ? 'crs' : '', inPlayer: true });
    if (ok) closePauseMenu(true);
  } catch (err) {
    toast(err.message === 'busy' ? t('busyState') : t('loadFailed'), { kind: 'bad', inPlayer: true });
  }
}

function toggleFastForward() {
  state.ff = !state.ff;
  emu.setFrameLimit(state.ff ? false : getSettings().frameLimit);
  $('#hud-ff').classList.toggle('on', state.ff);
}

function screenshot() {
  const canvas = $('#outputCanvas');
  canvas.toBlob((blob) => {
    if (!blob) return;
    const a = document.createElement('a');
    const name = (state.session?.game?.title || 'ps2').replace(/[^\w-]+/g, '_');
    a.href = URL.createObjectURL(blob);
    a.download = `${name}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    toast(t('screenshotSaved'), { glyph: 'sqr', inPlayer: true });
  }, 'image/png');
}

async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else {
      await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
      await screen.orientation?.lock?.('landscape').catch(() => {});
    }
  } catch {
    // Fullscreen is optional (iOS Safari, embedded views).
  }
}
document.addEventListener('fullscreenchange', () => setTimeout(layoutCanvas, 50));

// Touch controls ------------------------------------------------------------

function wireTouchpad() {
  const pad = $('#touchpad');
  pad.addEventListener('pointerdown', (e) => {
    const btn = e.target.closest('.tp-btn');
    if (!btn) return;
    e.preventDefault();
    btn.setPointerCapture(e.pointerId);
    btn.classList.add('down');
    input.setTouch(Number(btn.dataset.b), true);
    navigator.vibrate?.(8);
  });
  const release = (e) => {
    const btn = e.target.closest('.tp-btn');
    if (!btn) return;
    btn.classList.remove('down');
    input.setTouch(Number(btn.dataset.b), false);
  };
  pad.addEventListener('pointerup', release);
  pad.addEventListener('pointercancel', release);
  pad.addEventListener('contextmenu', (e) => e.preventDefault());

  const stick = $('#tp-stick');
  const knob = $('i', stick);
  let pid = null;
  const move = (e) => {
    const r = stick.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const max = r.width * 0.36;
    let dx = e.clientX - cx;
    let dy = e.clientY - cy;
    const d = Math.hypot(dx, dy);
    if (d > max) { dx = (dx / d) * max; dy = (dy / d) * max; }
    knob.style.setProperty('--sx', `${dx}px`);
    knob.style.setProperty('--sy', `${dy}px`);
    input.setTouchAxis(BTN.LX, Math.round(127.5 + (dx / max) * 127.5));
    input.setTouchAxis(BTN.LY, Math.round(127.5 + (dy / max) * 127.5));
  };
  stick.addEventListener('pointerdown', (e) => { pid = e.pointerId; stick.setPointerCapture(pid); move(e); });
  stick.addEventListener('pointermove', (e) => { if (e.pointerId === pid) move(e); });
  const end = (e) => {
    if (e.pointerId !== pid) return;
    pid = null;
    knob.style.setProperty('--sx', '0px');
    knob.style.setProperty('--sy', '0px');
    input.setTouchAxis(BTN.LX, 0x7f);
    input.setTouchAxis(BTN.LY, 0x7f);
  };
  stick.addEventListener('pointerup', end);
  stick.addEventListener('pointercancel', end);
}

// Settings drawer -------------------------------------------------------------

function seg(name, value, options) {
  return `<div class="seg" role="group">${options.map(([v, label]) => `<button data-set="${name}" data-value="${v}" aria-pressed="${String(String(value) === String(v))}">${esc(label)}</button>`).join('')}</div>`;
}

function toggle(name, checked) {
  return `<label class="switch"><input type="checkbox" data-set="${name}" ${checked ? 'checked' : ''}><i></i></label>`;
}

async function renderSettings() {
  const s = getSettings();
  const pads = input.connectedPads();
  const folders = await getFolders();
  const keys = { ...DEFAULT_KEYS, ...(s.keys || {}) };
  const body = $('#settings-body');
  const active = body.contains(document.activeElement) ? document.activeElement : null;
  const focusKey = active ? ['set', 'value', 'act', 'action', 'id']
    .filter((k) => active.dataset[k] !== undefined)
    .map((k) => `[data-${k}="${CSS.escape(active.dataset[k])}"]`).join('') : '';
  body.innerHTML = `
    <section class="set-group">
      <h3>${esc(t('setVideo'))}</h3>
      <div class="set-row"><span>${esc(t('setResolution'))}</span>${seg('resolution', s.resolution, [[1, '1×'], [2, '2×'], [3, '3×'], [4, '4×']])}</div>
      <div class="set-row"><span>${esc(t('setAspect'))}</span>${seg('aspect', s.aspect, [['4:3', '4:3'], ['16:9', '16:9'], ['stretch', '↔']])}</div>
      <div class="set-row"><span>${esc(t('setSmooth'))}</span>${toggle('smooth', s.smooth)}</div>
      <div class="set-row"><span>${esc(t('setFrameLimit'))}</span>${toggle('frameLimit', s.frameLimit)}</div>
      <div class="set-row"><span>${esc(t('setFps'))}</span>${toggle('showFps', s.showFps)}</div>
    </section>
    <section class="set-group">
      <h3>${esc(t('setAudio'))}</h3>
      <div class="set-row"><span>${esc(t('volume'))}</span><input type="range" min="0" max="1" step="0.05" value="${s.volume}" data-set="volume" aria-label="${esc(t('volume'))}"></div>
    </section>
    <section class="set-group">
      <h3>${esc(t('setPads'))}</h3>
      <div class="pads">${pads.length ? pads.map((p, i) => `<div class="pad-row">${icon('pad')}<b>${esc(t('player', { n: formatNumber(i + 1) }))}</b><span class="grow" dir="ltr">${esc(p.id)}</span></div>`).join('') + (pads.length > 1 ? `<button class="btn" data-act="swap-pads">⇄ ${esc(t('player', { n: '1' }))} / ${esc(t('player', { n: '2' }))}</button>` : '') : `<p class="note">${esc(t('noPads'))}</p>`}</div>
      <div class="set-row"><span>${esc(t('setTouch'))}</span>${seg('touch', s.touch, [['auto', t('touchAuto')], ['on', t('touchOn')], ['off', t('touchOff')]])}</div>
      <div class="set-row"><span>${esc(t('setTouchOpacity'))}</span><input type="range" min="0.2" max="1" step="0.05" value="${s.touchOpacity}" data-set="touchOpacity" aria-label="${esc(t('setTouchOpacity'))}"></div>
    </section>
    <section class="set-group">
      <h3>${esc(t('setControls'))} · ${esc(t('keyboard'))}</h3>
      <p class="note">${esc(t('setControlsHint'))}</p>
      <div class="keys">${KEY_ACTIONS.map((a) => `<button class="key" data-act="rebind" data-action="${a.id}"><b>${esc(a.label)}</b><kbd>${esc(keyLabel(keys[a.id]))}</kbd></button>`).join('')}</div>
      <button class="btn" data-act="reset-keys">${esc(t('setResetKeys'))}</button>
    </section>
    <section class="set-group">
      <h3>${esc(t('setLibrary'))}</h3>
      <b>${esc(t('folders'))}</b>
      ${folders.length ? folders.map((f) => `<div class="folder-row">${icon('folder')}<span class="grow">${esc(f.name)}</span><button class="btn" data-act="rescan" data-id="${esc(f.id)}">${esc(t('rescan'))}</button><button class="icon-btn" data-act="remove-folder" data-id="${esc(f.id)}" aria-label="${esc(t('remove'))}">${icon('trash')}</button></div>`).join('') : `<p class="note">${esc(t('noFolders'))}</p>`}
      <button class="btn danger" data-act="clear-library">${icon('trash')}<span>${esc(t('clearLibrary'))}</span></button>
    </section>
    <section class="set-group">
      <h3>${esc(t('setLanguage'))}</h3>
      ${seg('lang', getLang(), [['ar', 'العربية'], ['en', 'English']])}
    </section>
    <section class="set-group">
      <h3>${esc(t('setAbout'))}</h3>
      <p class="note">${esc(t('aboutBody'))}</p>
      <p class="note">${esc(t('coreVersion'))}: <span class="mono">${esc(emu.version || '—')}</span> · <a href="https://github.com/jpd002/Play-" target="_blank" rel="noopener">Play!</a> · <a href="https://github.com/PCSX2/pcsx2" target="_blank" rel="noopener">PCSX2 GameIndex</a> · <a href="https://github.com/xlenore/ps2-covers" target="_blank" rel="noopener">ps2-covers</a> · <a href="https://github.com/jpd002/Play-Compatibility" target="_blank" rel="noopener">Play-Compatibility</a></p>
    </section>`;
  if (focusKey) $(focusKey, body)?.focus();
}

function openSettings() {
  renderSettings();
  $('#settings').hidden = false;
  $('#scrim').hidden = false;
  $('#settings-close').focus();
}

function closeSettings() {
  if ($('#settings').hidden) return false;
  input.cancelRebind();
  $('#settings').hidden = true;
  $('#scrim').hidden = true;
  return true;
}

function applySetting(name, raw) {
  const num = ['resolution', 'volume', 'touchOpacity'];
  const value = num.includes(name) ? Number(raw) : raw;
  if (name === 'lang') {
    saveSettings({ lang: value });
    setLang(value);
    $('#btn-lang').textContent = value === 'ar' ? 'EN' : 'ع';
    renderLibrary();
    renderStore();
    renderSettings();
    updateStatus();
    return;
  }
  saveSettings({ [name]: value });
  if (name === 'volume') emu.setVolume(value);
  if (name === 'frameLimit' && !state.ff) emu.setFrameLimit(value);
  if (name === 'resolution' || name === 'aspect') layoutCanvas();
  if (name === 'smooth') player.classList.toggle('pixelated', !value);
  if (name === 'showFps') $('#hud-fps').hidden = !value;
  if (name === 'touch' || name === 'touchOpacity') updateTouch();
  if (!['volume', 'touchOpacity'].includes(name)) renderSettings();
}

// Spatial navigation for controllers and arrow keys ---------------------------

function navScope() {
  if (!$('#modal').hidden) return $('#modal');
  if (!$('#settings').hidden) return $('#settings');
  if (!player.hidden) return $('#pause-menu').hidden ? null : $('#pause-menu');
  return $(`#view-${state.view}`).parentElement.parentElement;
}

function focusables(scope) {
  return $$('button:not([disabled]), input, select, a[href], [tabindex="0"]', scope).filter((el) => {
    if (el.closest('[hidden]')) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  });
}

function moveFocus(dir) {
  const scope = navScope();
  if (!scope) return false;
  const items = focusables(scope);
  if (!items.length) return false;
  const cur = document.activeElement && items.includes(document.activeElement) ? document.activeElement : null;
  if (!cur) {
    const start = $('.card.focused', scope) || $('[data-act="play"]', scope) || items[0];
    start.focus();
    return true;
  }
  const a = cur.getBoundingClientRect();
  const ax = a.left + a.width / 2;
  const ay = a.top + a.height / 2;
  let best = null;
  let bestScore = Infinity;
  for (const el of items) {
    if (el === cur) continue;
    const b = el.getBoundingClientRect();
    const dx = b.left + b.width / 2 - ax;
    const dy = b.top + b.height / 2 - ay;
    const primary = { up: -dy, down: dy, left: -dx, right: dx }[dir];
    if (primary <= 4) continue;
    const cross = dir === 'up' || dir === 'down' ? Math.abs(dx) : Math.abs(dy);
    const score = primary + cross * 2.2;
    if (score < bestScore) { bestScore = score; best = el; }
  }
  if (best) {
    best.focus();
    best.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  }
  return true;
}

input.on('ui', (action) => {
  if (action === 'up' || action === 'down' || action === 'left' || action === 'right') return moveFocus(action);
  const active = document.activeElement;
  if (action === 'accept') {
    if (active && active !== document.body) active.click();
    else moveFocus('down');
    return true;
  }
  if (action === 'back') {
    if (!$('#modal').hidden) { $('#modal').closeModal?.(null); return true; }
    if (closeSettings()) return true;
    if (!$('#pause-menu').hidden) { closePauseMenu(true); return true; }
    return false;
  }
  if (action === 'favorite') {
    const id = getSettings().focusId;
    const g = getGame(id);
    if (g) updateGame(id, { favorite: !g.favorite });
    return true;
  }
  if (action === 'menu') {
    if (!$('#pause-menu').hidden) { closePauseMenu(true); return true; }
    if (!closeSettings()) openSettings();
    return true;
  }
  if (action === 'prevTab' || action === 'nextTab') {
    if (player.hidden) showView(state.view === 'library' ? 'store' : 'library');
    return true;
  }
  return false;
});

input.on('hotkey', (code) => {
  if (code === 'Escape' || code === 'F1' || code === 'PadHome') {
    if ($('#pause-menu').hidden) openPauseMenu();
    else closePauseMenu(true);
    return true;
  }
  if (code === 'F5') { saveSlot(0); return true; }
  if (code === 'F8' || code === 'F9') { loadSlot(0); return true; }
  if (code === 'Tab') { toggleFastForward(); return true; }
  return false;
});

input.on('padsChanged', (pads, connected) => {
  if (connected) toast(t('gamepadOn', { name: connected.id.replace(/\(.*?\)/g, '').trim().slice(0, 40) }), { glyph: 'crs', inPlayer: true });
  $('#pad-hints')?.toggleAttribute('hidden', pads.length === 0);
  updateTouch();
  if (!$('#settings').hidden) renderSettings();
});

// Status ------------------------------------------------------------------------

function updateStatus() {
  const ok = globalThis.crossOriginIsolated;
  $('#status').classList.toggle('bad', !ok);
  $('#status-text').textContent = `${ok ? t('isolationOk') : t('isolationNo')}${emu.version ? ` · Play! ${emu.version}` : ''}`;
}

// Events ------------------------------------------------------------------------

function wireEvents() {
  $('.tabs').addEventListener('click', (e) => {
    const tab = e.target.closest('.tab');
    if (tab) showView(tab.dataset.view);
  });
  $('#search').addEventListener('input', (e) => {
    state.query = e.target.value;
    if (state.view !== 'library') showView('library');
    renderGrid();
  });
  $('#filters').addEventListener('click', (e) => {
    const b = e.target.closest('.filter');
    if (!b) return;
    saveSettings({ filter: b.dataset.filter });
    renderLibrary();
  });
  $('#sort').addEventListener('change', (e) => { saveSettings({ sort: e.target.value }); renderGrid(); });
  $('#btn-add-folder').addEventListener('click', addFolder);
  $('#btn-open-file').addEventListener('click', () => $('#file-input').click());
  $('#file-input').addEventListener('change', (e) => { addPicked(e.target.files, { launchSingle: true }); e.target.value = ''; });
  $('#dir-input').addEventListener('change', (e) => { addPicked(e.target.files, { fromFolder: true }); e.target.value = ''; });
  $('#btn-settings').addEventListener('click', openSettings);
  $('#btn-lang').addEventListener('click', () => applySetting('lang', getLang() === 'ar' ? 'en' : 'ar'));
  $('#settings-close').addEventListener('click', closeSettings);
  $('#scrim').addEventListener('click', closeSettings);

  // Cards: first click selects, a click on the selected card plays.
  const grid = $('#grid');
  grid.addEventListener('click', (e) => {
    const card = e.target.closest('.card');
    if (!card) return;
    if (getSettings().focusId === card.dataset.id) launch(card.dataset.id);
    else setFocus(card.dataset.id);
  });
  grid.addEventListener('dblclick', (e) => {
    const card = e.target.closest('.card');
    if (card) launch(card.dataset.id);
  });
  grid.addEventListener('focusin', (e) => {
    const card = e.target.closest('.card');
    if (card && e.target.matches(':focus-visible')) setFocus(card.dataset.id);
  });
  grid.addEventListener('pointermove', (e) => {
    const c = e.target.closest('.case');
    if (!c || e.pointerType !== 'mouse') return;
    const r = c.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    const y = (e.clientY - r.top) / r.height;
    c.style.setProperty('--ry', `${(x - 0.5) * 16}deg`);
    c.style.setProperty('--rx', `${(0.5 - y) * 12}deg`);
    c.style.setProperty('--gx', `${x * 100}%`);
    c.style.setProperty('--gy', `${y * 100}%`);
  });
  grid.addEventListener('pointerout', (e) => {
    const c = e.target.closest('.case');
    if (c && !c.contains(e.relatedTarget)) { c.style.removeProperty('--rx'); c.style.removeProperty('--ry'); }
  });

  document.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-act]');
    if (!el || el.closest('#grid')) return;
    const { act, id } = el.dataset;
    if (act === 'play') launch(id);
    else if (act === 'add-folder') addFolder();
    else if (act === 'fav') { const g = getGame(id); if (g) updateGame(id, { favorite: !g.favorite }); }
    else if (act === 'remove') {
      const g = getGame(id);
      if (g && await confirmDialog(t('confirmRemove', { name: g.title }), t('remove'))) {
        await removeGame(id);
        saveSettings({ focusId: null });
        renderLibrary();
      }
    } else if (act === 'install') {
      const game = await install(id);
      if (game) renderLibrary();
    } else if (act === 'remove-source') {
      await removeRepoSource(id);
      state.sources = await getRepoSources();
      renderStore();
    } else if (act === 'save-slot') saveSlot(Number(el.dataset.slot));
    else if (act === 'load-slot') loadSlot(Number(el.dataset.slot));
    else if (act === 'rebind') {
      el.classList.add('listening');
      $('kbd', el).textContent = t('pressKey');
      const res = await input.startRebind(el.dataset.action);
      if (res) {
        const keys = { ...DEFAULT_KEYS, ...(getSettings().keys || {}) };
        for (const [k, v] of Object.entries(keys)) if (v === res.code) keys[k] = null;
        keys[res.action] = res.code;
        saveSettings({ keys });
        input.setKeys(keys);
      }
      renderSettings();
    } else if (act === 'reset-keys') {
      saveSettings({ keys: null });
      input.setKeys(null);
      renderSettings();
    } else if (act === 'swap-pads') {
      input.swapPlayers();
    } else if (act === 'rescan') {
      const note = scanToast();
      try {
        const found = await rescanFolder(id, (p) => note.progress(p));
        note.finish(found.length);
      } catch (err) {
        console.error(err);
        note.finish(0);
      }
      renderSettings();
    } else if (act === 'remove-folder') {
      await removeFolder(id);
      renderSettings();
    } else if (act === 'clear-library') {
      if (await confirmDialog(t('clearConfirm'), t('clearConfirmBtn'))) {
        await clearLibrary();
        saveSettings({ focusId: null });
        renderSettings();
      }
    }
  });

  $('#settings-body').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-set]');
    if (b) applySetting(b.dataset.set, b.dataset.value);
  });
  $('#settings-body').addEventListener('change', (e) => {
    const el = e.target.closest('input[data-set]');
    if (!el) return;
    applySetting(el.dataset.set, el.type === 'checkbox' ? el.checked : el.value);
  });
  $('#settings-body').addEventListener('input', (e) => {
    const el = e.target.closest('input[type="range"][data-set]');
    if (el) applySetting(el.dataset.set, el.value);
  });

  $('#repo-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const repo = $('#repo-input').value.trim();
    if (!repo) return;
    const note = toast(t('repoScanning', { r: repo }), { progress: 0.3 });
    $('#repo-submit').disabled = true;
    try {
      const src = await scanGithubRepo(repo);
      state.sources = await getRepoSources();
      renderStore();
      note.close(src.items.length ? t('repoFound', { n: formatNumber(src.items.length), r: src.name }) : t('repoNone', { r: src.name }));
    } catch (err) {
      console.error(err);
      note.close(t('repoError', { r: repo }), { kind: 'bad' });
    } finally {
      $('#repo-submit').disabled = false;
    }
  });

  // Player HUD
  $('#hud-back').addEventListener('click', exitToLibrary);
  $('#hud-pause').addEventListener('click', openPauseMenu);
  $('#hud-ff').addEventListener('click', toggleFastForward);
  $('#hud-save').addEventListener('click', () => saveSlot(0));
  $('#hud-load').addEventListener('click', () => loadSlot(0));
  $('#hud-shot').addEventListener('click', screenshot);
  $('#hud-full').addEventListener('click', toggleFullscreen);
  $('#hud-settings').addEventListener('click', () => { openPauseMenu(); openSettings(); });
  $('#hud-touch').addEventListener('click', () => {
    applySetting('touch', $('#touchpad').hidden ? 'on' : 'off');
  });
  $('#hud-vol').addEventListener('click', () => {
    const r = $('#hud-vol-range');
    r.value = getSettings().volume;
    r.hidden = !r.hidden;
    if (!r.hidden) r.focus();
  });
  $('#hud-vol-range').addEventListener('input', (e) => applySetting('volume', e.target.value));
  $('#hud-vol-range').addEventListener('change', (e) => { e.target.hidden = true; $('#outputCanvas').focus(); });
  $('#pause-resume').addEventListener('click', () => closePauseMenu(true));
  $('#pause-quit').addEventListener('click', quitGame);
  $('#pause-settings').addEventListener('click', openSettings);
  $('#pause-reset').addEventListener('click', async () => {
    const game = state.session?.game;
    if (!game) return;
    closePauseMenu(false);
    const file = await getGameFile(game);
    if (!file) return;
    await emu.boot(game, file);
    state.session.startedAt = Date.now();
    input.setInGame(true);
    $('#outputCanvas').focus();
  });
  $('#stage').addEventListener('pointerdown', () => { resumeAudio(); $('#outputCanvas').focus(); });

  // Drag and drop anywhere
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => {
    if (![...(e.dataTransfer?.types || [])].includes('Files') || !player.hidden) return;
    dragDepth++;
    $('#drop').hidden = false;
  });
  window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('#drop').hidden = true; });
  window.addEventListener('dragover', (e) => { if (!$('#drop').hidden) e.preventDefault(); });
  window.addEventListener('drop', async (e) => {
    if ($('#drop').hidden) return;
    e.preventDefault();
    dragDepth = 0;
    $('#drop').hidden = true;
    const note = scanToast();
    let added = [];
    try {
      const { folders, files } = await readDrop(e.dataTransfer);
      for (const dir of folders) added = added.concat(await scanFolder(dir, (p) => note.progress(p)));
      if (files.length) added = added.concat(await addFiles(files, (p) => note.progress(p)));
    } catch (err) {
      console.error(err);
    }
    note.finish(added.length);
    afterAdd(added);
  });

  // Pause while the tab is hidden and continue when it comes back.
  let autoPaused = false;
  document.addEventListener('visibilitychange', () => {
    if (player.hidden || !state.session) return;
    if (document.visibilityState === 'hidden' && emu.running) {
      emu.pause();
      accumulatePlayTime();
      autoPaused = true;
    } else if (document.visibilityState === 'visible' && autoPaused) {
      autoPaused = false;
      if ($('#pause-menu').hidden) {
        emu.resume();
        state.session.startedAt = Date.now();
      }
    }
  });

  onLibraryChange(() => {
    if (state.view === 'library') renderLibrary();
    else renderStore();
  });
}

// Boot ----------------------------------------------------------------------------

async function init() {
  setLang(settings.lang);
  $('#btn-lang').textContent = settings.lang === 'ar' ? 'EN' : 'ع';
  ambient = startAmbient($('#ambient'));
  wireEvents();
  wireTouchpad();
  updateStatus();
  state.catalog = await loadHomebrewCatalog();
  state.sources = await getRepoSources();
  await loadLibrary();
  renderLibrary();
  loadCompat().then((compat) => {
    state.compat = compat;
    state.compatLoaded = Object.keys(compat).length > 0;
    if (state.compatLoaded) renderLibrary();
  });
  // Warm the game database so scans and title matching are instant.
  setTimeout(() => loadGameDb(), 1500);
}

// Handle for debugging from the browser console.
window.__tower = { emu, input, state };

init();
