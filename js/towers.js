// The tower field: translucent crystal pillars on a dark plane, after the memory-card
// towers of the PS2 start-up screen. Used as the ambient background of the library
// and, sped up, as the boot sequence when a game starts.

const TAU = Math.PI * 2;

function rand(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

class Scene {
  constructor(canvas, { count = 34, seed = 7 } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    const r = rand(seed);
    this.towers = [];
    for (let i = 0; i < count; i++) {
      const a = r() * TAU;
      const d = 1.4 + Math.pow(r(), 0.8) * 7.2;
      this.towers.push({
        x: Math.cos(a) * d,
        z: Math.sin(a) * d,
        w: 0.22 + r() * 0.28,
        h: 0.5 + r() * 2.1,
        amp: 0.1 + r() * 0.5,
        speed: 0.15 + r() * 0.35,
        phase: r() * TAU,
        glow: r() < 0.28,
        hue: 210 + r() * 22,
        delay: r(),
      });
    }
    this.motes = Array.from({ length: 46 }, () => ({ x: r() * 2 - 1, y: r(), z: r(), s: 0.3 + r() * 0.7 }));
    this.dpr = 1;
    this.resize();
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    this.canvas.width = Math.max(1, Math.round(rect.width * this.dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * this.dpr));
  }

  // grow: 0..1 how far the towers have risen; flash: 0..1 white-out; cam: camera distance
  draw(t, { grow = 1, flash = 0, cam = 17, yaw = 0, lift = 1.5 } = {}) {
    const { ctx, canvas } = this;
    const W = canvas.width;
    const H = canvas.height;
    const cx = W / 2;
    const cy = H * 0.62;
    const f = Math.max(W, H) * 0.62;
    ctx.clearRect(0, 0, W, H);

    const cosA = Math.cos(yaw);
    const sinA = Math.sin(yaw);
    const project = (x, y, z) => {
      const rx = x * cosA - z * sinA;
      const rz = x * sinA + z * cosA + cam;
      const ry = y - lift;
      if (rz < 0.3) return null;
      return [cx + (f * rx) / rz, cy - (f * ry) / rz, rz];
    };

    // Horizon glow
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(W, H) * 0.7);
    g.addColorStop(0, 'rgba(70, 105, 220, 0.20)');
    g.addColorStop(0.45, 'rgba(30, 50, 140, 0.08)');
    g.addColorStop(1, 'rgba(4, 6, 14, 0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    // Floor rings
    ctx.lineWidth = Math.max(1, this.dpr);
    for (let ring = 1; ring <= 5; ring++) {
      ctx.beginPath();
      let started = false;
      for (let i = 0; i <= 64; i++) {
        const a = (i / 64) * TAU;
        const p = project(Math.cos(a) * ring * 2.2, 0, Math.sin(a) * ring * 2.2);
        if (!p) { started = false; continue; }
        if (!started) { ctx.moveTo(p[0], p[1]); started = true; } else ctx.lineTo(p[0], p[1]);
      }
      ctx.strokeStyle = `rgba(140, 175, 255, ${0.07 - ring * 0.009})`;
      ctx.stroke();
    }

    const items = [];
    for (const tw of this.towers) {
      const rise = Math.max(0, Math.min(1, (grow - tw.delay * 0.55) / 0.45));
      if (rise <= 0) continue;
      const eased = 1 - Math.pow(1 - rise, 3);
      const h = (tw.h + Math.sin(t * tw.speed + tw.phase) * tw.amp) * eased;
      const depth = (tw.x * sinA + tw.z * cosA) + cam;
      items.push({ tw, h, depth });
    }
    items.sort((a, b) => b.depth - a.depth);

    for (const { tw, h, depth } of items) {
      const w = tw.w;
      const corners = [[-w, -w], [w, -w], [w, w], [-w, w]].map(([dx, dz]) => [tw.x + dx, tw.z + dz]);
      const bottom = corners.map(([x, z]) => project(x, 0, z));
      const top = corners.map(([x, z]) => project(x, h, z));
      if (bottom.some((p) => !p) || top.some((p) => !p)) continue;
      const fog = Math.max(0.12, Math.min(1, 1.25 - depth / 22));
      const pulse = tw.glow ? 0.55 + 0.45 * Math.sin(t * 1.3 + tw.phase) : 0;

      // Side faces, drawn back to front
      const faces = [0, 1, 2, 3].map((i) => {
        const j = (i + 1) % 4;
        const mid = (bottom[i][2] + bottom[j][2]) / 2;
        return { i, j, mid };
      }).sort((a, b) => b.mid - a.mid);
      for (const { i, j } of faces) {
        ctx.beginPath();
        ctx.moveTo(bottom[i][0], bottom[i][1]);
        ctx.lineTo(bottom[j][0], bottom[j][1]);
        ctx.lineTo(top[j][0], top[j][1]);
        ctx.lineTo(top[i][0], top[i][1]);
        ctx.closePath();
        const grad = ctx.createLinearGradient(0, bottom[i][1], 0, top[i][1]);
        grad.addColorStop(0, `hsla(${tw.hue}, 80%, 62%, ${0.03 * fog})`);
        grad.addColorStop(1, `hsla(${tw.hue}, 90%, ${72 + pulse * 18}%, ${(0.16 + pulse * 0.22) * fog})`);
        ctx.fillStyle = grad;
        ctx.fill();
        ctx.strokeStyle = `hsla(${tw.hue}, 100%, 85%, ${(0.10 + pulse * 0.2) * fog})`;
        ctx.stroke();
      }
      // Top cap
      ctx.beginPath();
      top.forEach((p, k) => (k ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
      ctx.closePath();
      ctx.fillStyle = `hsla(${tw.hue}, 100%, 88%, ${(0.22 + pulse * 0.5) * fog})`;
      ctx.fill();
      if (tw.glow) {
        const c = top.reduce((acc, p) => [acc[0] + p[0] / 4, acc[1] + p[1] / 4], [0, 0]);
        const r = (f * w * 3.2) / depth;
        const halo = ctx.createRadialGradient(c[0], c[1], 0, c[0], c[1], r);
        halo.addColorStop(0, `rgba(190, 215, 255, ${0.35 * pulse * fog})`);
        halo.addColorStop(1, 'rgba(190, 215, 255, 0)');
        ctx.fillStyle = halo;
        ctx.fillRect(c[0] - r, c[1] - r, r * 2, r * 2);
      }
    }

    // Rising motes
    for (const m of this.motes) {
      const y = ((m.y + t * 0.02 * m.s) % 1);
      const x = cx + m.x * W * 0.55;
      const py = H - y * H * 0.95;
      const a = Math.sin(y * Math.PI) * 0.5 * m.z;
      ctx.fillStyle = `rgba(200, 222, 255, ${a})`;
      ctx.fillRect(x, py, 1.6 * this.dpr * m.s, 1.6 * this.dpr * m.s);
    }

    if (flash > 0) {
      ctx.fillStyle = `rgba(225, 236, 255, ${flash})`;
      ctx.fillRect(0, 0, W, H);
    }
  }
}

const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export function startAmbient(canvas) {
  const scene = new Scene(canvas);
  let running = true;
  let raf = 0;
  let last = 0;
  const start = performance.now();
  const frame = (now) => {
    if (!running) return;
    raf = requestAnimationFrame(frame);
    if (now - last < 33) return;
    last = now;
    const t = (now - start) / 1000;
    scene.draw(t, { yaw: t * 0.035, cam: 17 + Math.sin(t * 0.05) * 1.2 });
  };
  const onResize = () => { scene.resize(); if (reduceMotion()) scene.draw(4, { yaw: 0.2 }); };
  window.addEventListener('resize', onResize);
  if (reduceMotion()) scene.draw(4, { yaw: 0.2 });
  else raf = requestAnimationFrame(frame);
  return {
    pause() { running = false; cancelAnimationFrame(raf); },
    resume() {
      if (running || reduceMotion()) return;
      running = true;
      last = 0;
      raf = requestAnimationFrame(frame);
    },
  };
}

// Plays the boot sequence; resolves after `minMs`. Call the returned stop() to end it.
export function playBoot(canvas, { minMs = 1900 } = {}) {
  const scene = new Scene(canvas, { count: 40, seed: 23 });
  const start = performance.now();
  let raf = 0;
  let stopped = false;
  const quick = reduceMotion();
  const frame = (now) => {
    if (stopped) return;
    const e = (now - start) / 1000;
    const grow = quick ? 1 : Math.min(1, e / 1.3);
    const cam = quick ? 13 : 22 - Math.min(1, e / 1.6) * 9;
    const flash = quick ? 0 : Math.max(0, 1 - Math.abs(e - 1.45) / 0.22) * 0.55;
    scene.draw(e + 3, { grow, cam, yaw: 0.5 - e * 0.18, flash, lift: 1.4 + grow * 0.5 });
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);
  const done = new Promise((resolve) => setTimeout(resolve, quick ? 300 : minMs));
  return {
    done,
    stop() { stopped = true; cancelAnimationFrame(raf); },
  };
}
