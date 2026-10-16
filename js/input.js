// Input for both the console and the interface.
// Keyboard (remappable), up to two gamepads (Gamepad API, standard mapping) and the
// on-screen touch pad all write into one state per PS2 pad, which is pushed to the core
// only when a value changes.

export const BTN = {
  LX: 0, LY: 1, RX: 2, RY: 3,
  UP: 4, DOWN: 5, LEFT: 6, RIGHT: 7,
  SELECT: 8, START: 9,
  SQUARE: 10, TRIANGLE: 11, CIRCLE: 12, CROSS: 13,
  L1: 14, L2: 15, L3: 16, R1: 17, R2: 18, R3: 19,
};
const COUNT = 20;
const NEUTRAL = 0x7f;

// Digital keys bound to buttons, and pairs of keys bound to stick directions.
export const KEY_ACTIONS = [
  { id: 'UP', label: '↑' }, { id: 'DOWN', label: '↓' }, { id: 'LEFT', label: '←' }, { id: 'RIGHT', label: '→' },
  { id: 'CROSS', label: '✕' }, { id: 'CIRCLE', label: '○' }, { id: 'SQUARE', label: '□' }, { id: 'TRIANGLE', label: '△' },
  { id: 'L1', label: 'L1' }, { id: 'R1', label: 'R1' }, { id: 'L2', label: 'L2' }, { id: 'R2', label: 'R2' },
  { id: 'L3', label: 'L3' }, { id: 'R3', label: 'R3' }, { id: 'START', label: 'START' }, { id: 'SELECT', label: 'SELECT' },
  { id: 'LS_UP', label: 'L↑' }, { id: 'LS_DOWN', label: 'L↓' }, { id: 'LS_LEFT', label: 'L←' }, { id: 'LS_RIGHT', label: 'L→' },
  { id: 'RS_UP', label: 'R↑' }, { id: 'RS_DOWN', label: 'R↓' }, { id: 'RS_LEFT', label: 'R←' }, { id: 'RS_RIGHT', label: 'R→' },
];

export const DEFAULT_KEYS = {
  UP: 'ArrowUp', DOWN: 'ArrowDown', LEFT: 'ArrowLeft', RIGHT: 'ArrowRight',
  CROSS: 'KeyK', CIRCLE: 'KeyL', SQUARE: 'KeyJ', TRIANGLE: 'KeyI',
  L1: 'KeyQ', R1: 'KeyE', L2: 'Digit1', R2: 'Digit3', L3: 'KeyZ', R3: 'KeyC',
  START: 'Enter', SELECT: 'Backspace',
  LS_UP: 'KeyW', LS_DOWN: 'KeyS', LS_LEFT: 'KeyA', LS_RIGHT: 'KeyD',
  RS_UP: 'KeyT', RS_DOWN: 'KeyG', RS_LEFT: 'KeyF', RS_RIGHT: 'KeyH',
};

// Standard gamepad layout -> PS2 button
const PAD_BUTTONS = {
  0: BTN.CROSS, 1: BTN.CIRCLE, 2: BTN.SQUARE, 3: BTN.TRIANGLE,
  4: BTN.L1, 5: BTN.R1, 6: BTN.L2, 7: BTN.R2,
  8: BTN.SELECT, 9: BTN.START, 10: BTN.L3, 11: BTN.R3,
  12: BTN.UP, 13: BTN.DOWN, 14: BTN.LEFT, 15: BTN.RIGHT,
};
const HOME_BUTTON = 16;
const DEADZONE = 0.18;

export function keyLabel(code) {
  if (!code) return '—';
  return code
    .replace(/^Key/, '')
    .replace(/^Digit/, '')
    .replace(/^Numpad/, 'Num ')
    .replace('ArrowUp', '↑').replace('ArrowDown', '↓').replace('ArrowLeft', '←').replace('ArrowRight', '→')
    .replace('Backspace', '⌫').replace('Enter', '⏎').replace('Space', '␣')
    .replace('ShiftLeft', 'Shift').replace('ShiftRight', 'Shift R');
}

export class InputManager {
  constructor() {
    this.core = null;
    this.inGame = false;
    this.keys = { ...DEFAULT_KEYS };
    this.codeToAction = new Map();
    this.pressedKeys = new Set();
    this.touch = new Uint8Array(COUNT);
    this.touchAxes = new Uint8Array(4).fill(NEUTRAL);
    this.touchActive = false;
    this.sent = [new Int16Array(COUNT).fill(-1), new Int16Array(COUNT).fill(-1)];
    this.padOrder = [];
    this.prevPadButtons = new Map();
    this.uiRepeat = new Map();
    this.handlers = { ui: null, hotkey: null, padsChanged: null };
    this.rebindTarget = null;
    this.rebindDone = null;
    this.setKeys(DEFAULT_KEYS);

    window.addEventListener('keydown', (e) => this.onKey(e, true));
    window.addEventListener('keyup', (e) => this.onKey(e, false));
    window.addEventListener('blur', () => this.pressedKeys.clear());
    window.addEventListener('gamepadconnected', (e) => this.onPadConnected(e.gamepad, true));
    window.addEventListener('gamepaddisconnected', (e) => this.onPadConnected(e.gamepad, false));
    this.loop = this.loop.bind(this);
    requestAnimationFrame(this.loop);
  }

  on(name, fn) {
    this.handlers[name] = fn;
  }

  setKeys(keys) {
    this.keys = { ...DEFAULT_KEYS, ...(keys || {}) };
    this.codeToAction.clear();
    for (const [action, code] of Object.entries(this.keys)) if (code) this.codeToAction.set(code, action);
  }

  cancelRebind() {
    if (!this.rebindTarget) return;
    this.rebindTarget = null;
    this.rebindDone?.(null);
  }

  startRebind(action) {
    this.cancelRebind();
    return new Promise((resolve) => {
      this.rebindTarget = action;
      this.rebindDone = resolve;
    });
  }

  attach(core) {
    this.core = core;
  }

  setInGame(v) {
    this.inGame = v;
    this.pressedKeys.clear();
    this.touch.fill(0);
    this.touchAxes.fill(NEUTRAL);
    this.flush(true);
  }

  onKey(e, down) {
    if (this.rebindTarget && down) {
      e.preventDefault();
      const action = this.rebindTarget;
      this.rebindTarget = null;
      this.rebindDone?.(e.code === 'Escape' ? null : { action, code: e.code });
      return;
    }
    const typing = e.target instanceof HTMLElement && (e.target.matches('input, textarea, select') || e.target.isContentEditable);
    if (this.inGame) {
      if (down && !e.repeat && this.handlers.hotkey?.(e.code, e)) {
        e.preventDefault();
        return;
      }
      if (this.codeToAction.has(e.code)) {
        e.preventDefault();
        if (down) this.pressedKeys.add(e.code);
        else this.pressedKeys.delete(e.code);
      }
      return;
    }
    if (!down) return;
    if (e.code === 'Escape' && this.handlers.ui?.('back', 'keyboard')) {
      e.preventDefault();
      return;
    }
    if (typing) return;
    const map = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };
    if (map[e.code] && this.handlers.ui?.(map[e.code], 'keyboard')) e.preventDefault();
  }

  onPadConnected(pad, connected) {
    if (connected) {
      if (!this.padOrder.includes(pad.index)) this.padOrder.push(pad.index);
    } else {
      this.padOrder = this.padOrder.filter((i) => i !== pad.index);
      this.prevPadButtons.delete(pad.index);
    }
    this.handlers.padsChanged?.(this.connectedPads(), connected ? pad : null);
  }

  connectedPads() {
    const pads = navigator.getGamepads ? [...navigator.getGamepads()].filter(Boolean) : [];
    return this.padOrder.map((i) => pads.find((p) => p.index === i)).filter(Boolean);
  }

  swapPlayers() {
    this.padOrder.reverse();
    this.handlers.padsChanged?.(this.connectedPads(), null);
  }

  setTouch(button, pressed) {
    this.touch[button] = pressed ? 1 : 0;
    this.touchActive = true;
  }

  // axis: BTN.LX..BTN.RY, value 0..255
  setTouchAxis(axis, value) {
    this.touchAxes[axis] = value;
    this.touchActive = true;
  }

  compute(padIndex, gamepad) {
    const v = new Uint8Array(COUNT);
    v[BTN.LX] = v[BTN.LY] = v[BTN.RX] = v[BTN.RY] = NEUTRAL;
    if (gamepad) {
      gamepad.buttons.forEach((b, i) => {
        const target = PAD_BUTTONS[i];
        if (target !== undefined && (b.pressed || b.value > 0.5)) v[target] = 1;
      });
      const axis = (n) => {
        const a = gamepad.axes[n] || 0;
        return Math.abs(a) < DEADZONE ? NEUTRAL : Math.max(0, Math.min(255, Math.round((a + 1) * 127.5)));
      };
      v[BTN.LX] = axis(0); v[BTN.LY] = axis(1); v[BTN.RX] = axis(2); v[BTN.RY] = axis(3);
    }
    if (padIndex === 0) {
      for (const code of this.pressedKeys) {
        const action = this.codeToAction.get(code);
        if (!action) continue;
        if (action in BTN) v[BTN[action]] = 1;
        else {
          const [stick, dir] = action.split('_');
          const x = stick === 'LS' ? BTN.LX : BTN.RX;
          const y = stick === 'LS' ? BTN.LY : BTN.RY;
          if (dir === 'UP') v[y] = 0;
          else if (dir === 'DOWN') v[y] = 255;
          else if (dir === 'LEFT') v[x] = 0;
          else if (dir === 'RIGHT') v[x] = 255;
        }
      }
      if (this.touchActive) {
        for (let i = 4; i < COUNT; i++) if (this.touch[i]) v[i] = 1;
        for (let a = 0; a < 4; a++) if (this.touchAxes[a] !== NEUTRAL) v[a] = this.touchAxes[a];
      }
    }
    return v;
  }

  flush(force = false) {
    if (!this.core) return;
    const pads = this.connectedPads();
    for (let p = 0; p < 2; p++) {
      const values = this.inGame ? this.compute(p, pads[p]) : this.compute(-1, null);
      const sent = this.sent[p];
      for (let b = 0; b < COUNT; b++) {
        if (force || sent[b] !== values[b]) {
          sent[b] = values[b];
          this.core.setPadInput(p, b, values[b]);
        }
      }
    }
  }

  // Gamepad buttons drive the interface when no game is running, and the
  // Home/PS button (or SELECT+START) opens the pause menu in game.
  pollUi(now) {
    for (const pad of this.connectedPads()) {
      const prev = this.prevPadButtons.get(pad.index) || [];
      const cur = pad.buttons.map((b) => b.pressed);
      const pressed = (i) => cur[i] && !prev[i];
      if (this.inGame) {
        if (pressed(HOME_BUTTON) || (cur[8] && cur[9] && (pressed(8) || pressed(9)))) this.handlers.hotkey?.('PadHome');
      } else {
        const dirs = [[12, 'up'], [13, 'down'], [14, 'left'], [15, 'right']];
        const ax = pad.axes[0] || 0;
        const ay = pad.axes[1] || 0;
        const stick = { up: ay < -0.6, down: ay > 0.6, left: ax < -0.6, right: ax > 0.6 };
        for (const [i, dir] of dirs) {
          const held = cur[i] || stick[dir];
          const key = `${pad.index}:${dir}`;
          if (held) {
            const next = this.uiRepeat.get(key);
            if (next === undefined || now >= next) {
              this.handlers.ui?.(dir, 'pad');
              this.uiRepeat.set(key, now + (next === undefined ? 380 : 120));
            }
          } else this.uiRepeat.delete(key);
        }
        if (pressed(0)) this.handlers.ui?.('accept', 'pad');
        if (pressed(1)) this.handlers.ui?.('back', 'pad');
        if (pressed(3)) this.handlers.ui?.('favorite', 'pad');
        if (pressed(9) || pressed(HOME_BUTTON)) this.handlers.ui?.('menu', 'pad');
        if (pressed(4)) this.handlers.ui?.('prevTab', 'pad');
        if (pressed(5)) this.handlers.ui?.('nextTab', 'pad');
      }
      this.prevPadButtons.set(pad.index, cur);
    }
  }

  loop(now) {
    if (navigator.getGamepads) {
      // Chrome only reports pads that were touched; make sure we track them.
      for (const pad of navigator.getGamepads()) {
        if (pad && !this.padOrder.includes(pad.index)) this.onPadConnected(pad, true);
      }
    }
    this.pollUi(now);
    if (this.inGame) this.flush();
    requestAnimationFrame(this.loop);
  }
}
