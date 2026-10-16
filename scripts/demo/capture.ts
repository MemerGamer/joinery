/**
 * Captures README media from the seeded demo instance into docs/media/:
 * demo.mp4 (a "Screen Studio" style walkthrough, 2x HiDPI via
 * CDP screencast: fake eased cursor, click ripples, zoom applied in ffmpeg) and
 * the Tour screenshots (homebase, explore, review, thread).
 *
 *   bun scripts/demo/capture.ts            # both
 *   bun scripts/demo/capture.ts shot       # homebase.png only
 *   bun scripts/demo/capture.ts video      # demo.mp4 only
 *
 * Needs `playwright` (root devDependency) with Chromium installed
 * (`bunx playwright install chromium`) and ffmpeg on PATH. It re-seeds
 * /tmp/joinery-demo and runs its own server on the demo port (with a fake
 * `gh` and a demo gitconfig, see env.ts); your real ./data dir is never
 * touched. Run `bun run --filter '@joinery/web' build` first.
 */
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { mkdirSync, rmSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { demoEnv } from './env.ts';

const ROOT = resolve(import.meta.dir, '../..');
const OUT = join(ROOT, 'docs/media');
const PORT = process.env.JOINERY_DEMO_PORT ?? '7318';
const DEMO_DIR = process.env.JOINERY_DEMO_DIR ?? '/tmp/joinery-demo';
const BASE = `http://127.0.0.1:${PORT}/`;
const THREAD = 'article[aria-label="Thread on src/billing/proration.ts line 23"]';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const mode = process.argv[2] ?? 'all';

// ---------- demo server ----------

async function sh(cmd: string[]): Promise<void> {
  const p = Bun.spawn(cmd, { cwd: ROOT, stdout: 'ignore', stderr: 'inherit' });
  if ((await p.exited) !== 0) throw new Error(`${cmd.join(' ')} failed`);
}

async function startServer(): Promise<() => Promise<void>> {
  await sh(['bun', 'scripts/demo/seed.ts']);
  const proc = Bun.spawn(['bun', 'apps/server/src/index.ts'], {
    cwd: ROOT,
    env: { ...process.env, ...demoEnv(DEMO_DIR), JOINERY_DATA_DIR: join(DEMO_DIR, 'data'), JOINERY_PORT: PORT },
    stdout: 'ignore',
    stderr: 'ignore',
  });
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(BASE)).ok) break;
    } catch {}
    await sleep(250);
  }
  return async () => {
    proc.kill();
    await proc.exited;
  };
}

// ---------- shared setup ----------

/** The way a user picks them: localStorage keys of the theme picker and the backdrop picker. */
const PREFS_INIT = `
localStorage.setItem('joinery:theme', JSON.stringify({ chromeMode: 'dark', diffTheme: { dark: 'pierre-dark-soft', light: 'pierre-light' } }));
localStorage.setItem('homebase.backdrop', JSON.stringify({ kind: 'image', id: 'nocturne' }));
`;

async function openReview(page: Page): Promise<void> {
  await page.goto(BASE);
  await page.getByText('Currently reviewing').waitFor();
  await page.waitForTimeout(1500);
  await page.getByRole('button', { name: /Open Prorate plan/i }).click();
  await page.getByText('Proration math').waitFor();
  await page.getByText('ratios must not sum to zero').first().waitFor();
  await page.waitForTimeout(800);
}

async function shot(browser: Browser): Promise<void> {
  // Homebase at 1x: the backdrop makes its 2x PNG about 3 MB.
  const ctx1 = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, colorScheme: 'dark' });
  await ctx1.addInitScript(PREFS_INIT);
  const home = await ctx1.newPage();
  await home.goto(BASE);
  await home.getByText('Currently reviewing').waitFor();
  await home.waitForTimeout(2500);
  await home.screenshot({ path: join(OUT, 'homebase.png') });
  await ctx1.close();

  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: 'dark' });
  await ctx.addInitScript(PREFS_INIT);
  const page = await ctx.newPage();
  await page.goto(BASE);
  await page.getByText('Currently reviewing').waitFor();
  await page.waitForTimeout(2500);

  // Explore sits below the Homebase fold.
  await page.mouse.move(700, 500);
  await page.mouse.wheel(0, 2000);
  await page.waitForTimeout(800);
  await page.mouse.wheel(0, -90);
  await page.waitForTimeout(1000);
  await page.screenshot({ path: join(OUT, 'explore.png') });

  // Review page: reading order step, diff with the Claude thread in view.
  await openReview(page);
  await page.getByText('Proration math').click();
  await page.waitForTimeout(900);
  await page.locator('li', { hasText: /^src\/billing\/\s*proration\.ts/ }).last().click();
  const thread = page.locator(THREAD);
  await thread.waitFor();
  await page.waitForTimeout(600);
  await thread.scrollIntoViewIfNeeded();
  await page.mouse.move(700, 500);
  const tb = (await thread.boundingBox())!;
  await page.mouse.wheel(0, tb.y - 150);
  await page.waitForTimeout(1000);
  await page.mouse.move(1430, 890);
  await page.screenshot({ path: join(OUT, 'review.png') });

  // Thread close-up with the reply composer and the Ask menu.
  await thread.getByRole('button', { name: 'Reply', exact: true }).click();
  await thread.locator('textarea').fill('Agreed. Let us round to the nearest day on both sides.');
  await page.waitForTimeout(500);
  const t2 = (await thread.boundingBox())!;
  const pad = 14;
  const clip = { x: Math.max(0, t2.x - pad), y: Math.max(0, t2.y - pad), width: Math.min(1440, t2.width + pad * 2), height: Math.min(900 - Math.max(0, t2.y - pad), t2.height + pad * 2) };
  await page.mouse.move(1430, 890);
  await page.screenshot({ path: join(OUT, 'thread.png'), clip });

  await ctx.close();
}

// ---------- video ----------

const CURSOR_INIT = `
(() => {
  const mount = () => {
    if (document.getElementById('__cursor')) return;
    const st = document.createElement('style');
    st.textContent = \`
      #__cursor { position: fixed; left: 0; top: 0; z-index: 2147483647; pointer-events: none; opacity: 0;
        filter: drop-shadow(0 2px 3px rgba(0,0,0,.35)); transition: opacity .3s; }
      .__ripple { position: fixed; z-index: 2147483646; pointer-events: none; width: 34px; height: 34px; margin: -17px 0 0 -17px;
        border-radius: 50%; background: rgba(99,102,241,.28); border: 2px solid rgba(99,102,241,.7);
        animation: __rip .55s ease-out forwards; }
      @keyframes __rip { from { transform: scale(.3); opacity: 1 } to { transform: scale(1.6); opacity: 0 } }
    \`;
    document.documentElement.appendChild(st);
    const c = document.createElement('div');
    c.id = '__cursor';
    c.innerHTML = '<svg width="26" height="26" viewBox="0 0 24 24"><path d="M4 2.5l15 9.2-6.4 1.5 3.6 6.6-2.9 1.6-3.6-6.6L5.6 19z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    document.documentElement.appendChild(c);
    addEventListener('mousemove', (e) => {
      c.style.opacity = '1';
      c.style.transform = 'translate(' + (e.clientX - 5) + 'px,' + (e.clientY - 3) + 'px)';
    }, true);
    addEventListener('mousedown', (e) => {
      const r = document.createElement('div');
      r.className = '__ripple';
      r.style.left = e.clientX + 'px';
      r.style.top = e.clientY + 'px';
      document.documentElement.appendChild(r);
      setTimeout(() => r.remove(), 700);
    }, true);
  };
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', mount); else mount();
})();
`;

const W = 1280;
const H = 800;
const DSF = 2;
const ZOOM_S = 1.1;
type Zoom = { s: number; tx: number; ty: number };
const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

class Studio {
  x = 640;
  y = 400;
  z = { s: 1, tx: 0, ty: 0 };
  /** Zoom keyframes (wall-clock seconds), applied in post by ffmpeg: a CSS transform on the page would distort the diff virtualizer's measurements and make it scroll. */
  keys: { t0: number; d: number; from: Zoom; to: Zoom }[] = [];
  constructor(readonly page: Page) {}

  async moveTo(x: number, y: number, ms = 650): Promise<void> {
    const { x: x0, y: y0 } = this;
    const start = performance.now();
    for (;;) {
      const t = Math.min(1, (performance.now() - start) / ms);
      const k = ease(t);
      await this.page.mouse.move(x0 + (x - x0) * k, y0 + (y - y0) * k);
      if (t >= 1) break;
      await sleep(12);
    }
    this.x = x;
    this.y = y;
  }

  async center(sel: string | ReturnType<Page['locator']>, dx = 0.5, dy = 0.5) {
    const loc = typeof sel === 'string' ? this.page.locator(sel).first() : sel.first();
    const b = (await loc.boundingBox())!;
    return { x: b.x + b.width * dx, y: b.y + b.height * dy, box: b };
  }

  async hover(loc: ReturnType<Page['locator']>, dx = 0.5, dy = 0.5, ms = 650): Promise<void> {
    const c = await this.center(loc, dx, dy);
    await this.moveTo(c.x, c.y, ms);
  }

  async click(loc: ReturnType<Page['locator']>, dx = 0.5, dy = 0.5, ms = 650): Promise<void> {
    await this.hover(loc, dx, dy, ms);
    await sleep(180);
    await this.page.mouse.down();
    await sleep(70);
    await this.page.mouse.up();
  }

  /** Smoothly zoom so `box` (current viewport coordinates) fills the view; null zooms out. */
  async zoom(box: { x: number; y: number; width: number; height: number } | null, maxScale = 1.5): Promise<void> {
    // The page itself is never transformed, so `box` is already in layout coordinates.
    const [s, tx, ty] = [1, 0, 0];
    let next = { s: 1, tx: 0, ty: 0 };
    if (box) {
      // to unzoomed layout coordinates
      const cx = (box.x + box.width / 2 - tx) / s;
      const cy = (box.y + box.height / 2 - ty) / s;
      const bw = box.width / s;
      const bh = box.height / s;
      const ns = Math.min(maxScale, (W * 0.92) / bw, (H * 0.92) / bh);
      next = {
        s: ns,
        tx: Math.min(0, Math.max(W - ns * W, W / 2 - ns * cx)),
        ty: Math.min(0, Math.max(H - ns * H, H / 2 - ns * cy)),
      };
    }
    const t0 = Date.now() / 1000;
    this.keys.push({ t0, d: ZOOM_S, from: this.z, to: next });
    this.z = next;
    await sleep(ZOOM_S * 1000 + 150);
  }

  async scrollBy(dy: number, ms = 1100): Promise<void> {
    const start = performance.now();
    let done = 0;
    for (;;) {
      const t = Math.min(1, (performance.now() - start) / ms);
      const target = dy * ease(t);
      await this.page.mouse.wheel(0, target - done);
      done = target;
      if (t >= 1) break;
      await sleep(14);
    }
  }
}

/** Screencast frames (PNG/JPEG at deviceScaleFactor 2) with their timestamps. */
async function startScreencast(ctx: BrowserContext, page: Page, dir: string) {
  const cdp = await ctx.newCDPSession(page);
  const frames: { file: string; ts: number }[] = [];
  cdp.on('Page.screencastFrame', (f) => {
    const file = join(dir, `f${String(frames.length).padStart(6, '0')}.jpg`);
    writeFileSync(file, Buffer.from(f.data, 'base64'));
    frames.push({ file, ts: f.metadata.timestamp! });
    void cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, everyNthFrame: 1, maxWidth: W * DSF, maxHeight: H * DSF });
  return {
    frames,
    stop: async () => {
      await cdp.send('Page.stopScreencast');
    },
  };
}

/** Constant-frame-rate MP4 from timestamped frames (held for as long as nothing changed). */
async function assemble(frames: { file: string; ts: number }[], tmp: string, endHold: number, keys: Studio['keys']): Promise<void> {
  const lines: string[] = [];
  frames.forEach((f, i) => {
    const next = frames[i + 1]?.ts;
    const d = next === undefined ? endHold : Math.max(0.001, next - f.ts);
    lines.push(`file '${f.file}'`, `duration ${d.toFixed(4)}`);
  });
  lines.push(`file '${frames[frames.length - 1]!.file}'`);
  const list = join(tmp, 'list.txt');
  writeFileSync(list, lines.join('\n'));
  // Zoom = scale up then crop, both driven by the recorded keyframes (smoothstep easing).
  const t0 = frames[0]!.ts;
  const E = (k: Studio['keys'][number]) => `(st(0,clip((t-${(k.t0 - t0).toFixed(3)})/${k.d},0,1))*ld(0)*ld(0)*(3-2*ld(0)))`;
  const sum = (get: (z: Zoom) => number) => keys.map((k) => `(${get(k.to) - get(k.from)})*${E(k)}`).join('+') || '0';
  const S = `(1+${sum((z) => z.s - 1)})`;
  const TX = `(${sum((z) => z.tx)})`;
  const TY = `(${sum((z) => z.ty)})`;
  const filter = [
    'fps=30',
    `scale=w='trunc(${W * DSF}*${S}/2)*2':h='trunc(${H * DSF}*${S}/2)*2':eval=frame:flags=bicubic`,
    `crop=${W * DSF}:${H * DSF}:x='clip(-${DSF}*${TX},0,iw-ow)':y='clip(-${DSF}*${TY},0,ih-oh)'`,
  ].join(',');
  const fscript = join(tmp, 'filter.txt');
  writeFileSync(fscript, filter);
  const base = ['ffmpeg', '-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-an'];
  const enc = ['-c:v', 'libx264', '-preset', 'slow', '-pix_fmt', 'yuv420p', '-r', '30', '-movflags', '+faststart'];
  await sh([...base, '-filter_script:v', fscript, ...enc, '-crf', '20', join(OUT, 'demo.mp4')]);
}

async function video(): Promise<void> {
  // Headless screencast ignores per-context deviceScaleFactor; this flag makes frames come out at 2x.
  const browser = await chromium.launch({ args: [`--force-device-scale-factor=${DSF}`] });
  const tmp = '/tmp/joinery-demo-frames';
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, colorScheme: 'dark' });
  await ctx.addInitScript(PREFS_INIT);
  await ctx.addInitScript(CURSOR_INIT);
  const page = await ctx.newPage();
  await page.goto(BASE);
  await page.getByText('Currently reviewing').waitFor();
  await page.waitForTimeout(1200);
  const cast = await startScreencast(ctx, page, tmp);
  const m = new Studio(page);
  await page.mouse.move(900, 620);

  // 1. Homebase: hover a couple of rows, open the richest review.
  await sleep(2000);
  const row = (name: RegExp) => page.getByRole('button', { name });
  await m.hover(row(/Open Reject replayed/i), 0.35, 0.5, 700);
  await sleep(400);
  await m.hover(row(/Open Slide-over cart/i), 0.3, 0.5, 550);
  await sleep(300);
  await m.click(row(/Open Prorate plan/i), 0.3, 0.5, 600);
  await page.getByText('Proration math').waitFor();
  await page.getByText('ratios must not sum to zero').first().waitFor();
  await sleep(900);

  // 2. Reading order: step through two steps.
  await m.click(page.getByText('Money gets a new home'), 0.5, 0.5, 600);
  await sleep(700);
  await m.click(page.getByText('Proration math'), 0.5, 0.5, 650);
  await sleep(1200);
  await m.click(page.locator('li', { hasText: /^src\/billing\/\s*proration\.ts/ }).last(), 0.5, 0.5, 700);
  await page.locator(THREAD).waitFor();
  await sleep(1000);

  // 3. Scroll to the thread with Claude's reply, zoom in once, reply, post, zoom out once.
  const thread = page.locator(THREAD);
  await m.moveTo(700, 420, 500);
  const tb = (await thread.boundingBox())!;
  // Leave room under the thread for the reply composer (the app focuses its
  // textarea on open, which scrolls the diff if it would land below the fold).
  await m.scrollBy(tb.y - 104, 1300);
  await sleep(500);
  const top = (await thread.boundingBox())!;
  await m.zoom({ ...top, height: top.height + 140 }, 1.4);
  await sleep(1800);
  await m.hover(thread.getByRole('button', { name: 'Reply', exact: true }), 0.5, 0.5, 900);
  await holdScroll(page, 1200);
  await sleep(180);
  await page.mouse.down();
  await sleep(70);
  await page.mouse.up();
  await sleep(500);
  await thread.locator('textarea').waitFor();
  await page.keyboard.type('Agreed. Let us round to the nearest day on both sides.', { delay: 28 });
  await sleep(700);
  await m.click(thread.getByRole('button', { name: /Comment/ }), 0.5, 0.5, 700);
  await sleep(1300);
  await m.zoom(null);
  await sleep(600);

  // 4. Resolve the other thread, keep the pane filled, mark the file viewed.
  const other = page.locator('article[aria-label="Thread on src/billing/proration.ts line 26"]');
  await m.click(other.getByRole('button', { name: 'Resolve thread' }), 0.5, 0.5, 700);
  await sleep(1700);
  const viewedBtns = page.getByRole('checkbox', { name: /Viewed/ });
  for (let i = 0; i < (await viewedBtns.count()); i++) {
    const b = await viewedBtns.nth(i).boundingBox();
    if (b && b.y >= 0 && b.y < 120) {
      await m.click(viewedBtns.nth(i), 0.5, 0.5, 800);
      break;
    }
  }
  await sleep(900);

  // 5. Back to Homebase; hide the cursor for a clean last view.
  await m.click(page.getByRole('button').first(), 0.5, 0.5, 800);
  await page.evaluate(() => (document.getElementById('__cursor')!.style.opacity = '0'));
  await page.getByText('Currently reviewing').waitFor();
  await sleep(2200);

  await cast.stop();
  await ctx.close();
  await assemble(cast.frames, tmp, 0.5, m.keys);
  rmSync(tmp, { recursive: true, force: true });
  await browser.close();
}

/**
 * Opening the reply composer makes the thread taller and the diff view
 * (@pierre/diffs CodeView, see its pending layout anchor) re-anchors its scroll
 * position, so the thread visibly jumps up. Pin scrollTop for a moment so the
 * thread grows downward instead.
 */
async function holdScroll(page: Page, ms: number): Promise<void> {
  await page.evaluate((ms) => {
    let el: HTMLElement | null = document.querySelector('article[aria-label^="Thread on"]')!.parentElement;
    while (el && el.scrollHeight <= el.clientHeight + 1) el = el.parentElement;
    if (!el) return;
    const pinned = el.scrollTop;
    const end = performance.now() + ms;
    const tick = () => {
      if (el!.scrollTop !== pinned) el!.scrollTop = pinned;
      if (performance.now() < end) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, ms);
}

// ---------- main ----------

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
try {
  if (mode === 'all' || mode === 'shot') {
    const stop = await startServer();
    try {
      await shot(browser);
    } finally {
      await stop();
    }
  }
  if (mode === 'all' || mode === 'video') {
    const stop = await startServer();
    try {
      await video();
    } finally {
      await stop();
    }
  }
} finally {
  await browser.close();
}

for (const f of readdirSync(OUT).sort()) console.log(`${f}  ${(statSync(join(OUT, f)).size / 1024).toFixed(0)} KB`);
