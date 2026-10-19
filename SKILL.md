---
name: lowcpu-browser-verify
description: Cut CPU cost of Playwright browser verification / screenshots / interaction tests. The usual culprit is headless mode silently falling back to SwiftShader software rendering, which pins 4-6 cores on any real WebGL scene; `channel:'chromium'` restores hardware rendering. Use when browser verification saturates the CPU, the fans spin up, or screenshots look wrong/slow in headless CI.
license: MIT
---

# Low-CPU browser verification

Your headless browser is probably rendering on the CPU.

Playwright's `headless: true` launches `chrome-headless-shell`, a stripped binary with **no GPU
support at all**. WebGL falls back to SwiftShader — software rasterization — which pins 4–6 CPU
cores on a scene that should cost a fraction of one. The usual advice ("headless is cheaper than
headed") is simply wrong for anything that draws.

## The fix is one line

```js
import { chromium } from 'playwright';

// ❌ software rendering: the stripped headless shell has no GPU
const bad = await chromium.launch({ headless: true });

// ✅ hardware rendering, still no visible window
const good = await chromium.launch({ channel: 'chromium' });
```

`channel: 'chromium'` runs **full Chromium in new-headless mode**: real GPU, no window, no desktop
needed. It requires the full browser build:

```bash
npx playwright install chromium
```

## Verify it — don't take it on faith

Flags lie, and Chromium's headless implementation has changed more than once. The only trustworthy
evidence is the WebGL renderer string read from inside a live page:

```js
import { checkGpu } from './scripts/launch.mjs';

const info = await checkGpu(page);
console.log(info.renderer, info.software ? 'SOFTWARE' : 'HARDWARE');
// HARDWARE: ANGLE (Intel, Intel(R) HD Graphics 630 ..., D3D11)
// SOFTWARE: ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)
```

This repo ships a doctor for exactly that:

```bash
node scripts/doctor.mjs                              # is each launch mode on the GPU?
node scripts/doctor.mjs --measure http://localhost:5173/   # plus CPU cost on your own page
```

It exits non-zero when the default path is software rendering, so it works as a CI gate.

## The three modes, and which one you want

| Launch | Binary | GPU | Notes |
| --- | --- | --- | --- |
| `headless: true` | `chrome-headless-shell` | ❌ never | SwiftShader; 4–6 cores on real scenes |
| `channel: 'chromium'` | full Chromium, new headless | ✅ | **default here** — no window needed |
| `headless: false` | full Chromium | ✅ | needs a display; use `--window-position=-2400,-2400` to hide |

`--headless=new` as a raw argv flag also works, but `channel` is the supported API (Playwright ≥ 1.49).

## Beyond the renderer: two more cheap wins

**1. Cap the frame rate.** A three.js / rAF loop runs `setAnimationLoop` flat out; a screenshot does
not need 60 fps. Honor a query param and skip frames you are not going to look at:

```js
function lowCpuUrl(base, fps = 6) {
  return base + (base.includes('?') ? '&' : '?') + `perf=low&fps=${fps}`;
}
```

```js
// page side
const MIN = 1000 / fps;
let last = 0;
function loop(t) {
  requestAnimationFrame(loop);
  if (t - last < MIN) return;   // not due yet — render nothing
  last = t;
  render();
}
```

**2. Keep the pixel count small.** `DPR 1` and a modest viewport. DPR 2 quadruples the pixels, which
is the last thing a verification run needs.

| Viewport | Pixels |
| --- | --- |
| 1000×700 | 0.70 MP |
| 1200×780 | 0.94 MP — use for desktop-breakpoint assertions |
| 390×844 | 0.33 MP — phone portrait |

## Always close the browser

A leaked browser keeps burning CPU long after the test ends. Two separate leaks of this kind cost
500 CPU-seconds each in one afternoon. Use `try/finally`, or the helper:

```js
import { withBrowser } from './scripts/launch.mjs';

await withBrowser(async (browser) => {
  const page = await browser.newPage();
  // ...
});   // closed even if the body throws
```

## Hard requirement: don't trust flags, assert the renderer

If you take one thing away: **add a GPU assertion to your smoke test.** Perf regressions here are
invisible — the test passes, the screenshots look fine, and you only notice the laptop fan. A single
assertion makes it loud:

```js
const { software, renderer } = await checkGpu(page);
if (software) throw new Error(`software rendering: ${renderer}`);
```

## What is in this repo

| File | Purpose |
| --- | --- |
| `scripts/launch.mjs` | `launch()`, `lowCpuUrl()`, `checkGpu()`, `withBrowser()`, viewports |
| `scripts/doctor.mjs` | GPU diagnosis + optional CPU measurement, CI-gateable |
| `SKILL.md` | this document |

## Scope and limits

- Measured on **Playwright 1.61.1 / Chromium 1228, Windows, Intel HD 630**. The mechanism
  (headless shell has no GPU) is Chromium-wide; exact CPU figures will differ on your hardware.
- GPU rendering still needs *a* GPU. On a headless server with no GPU and no virtual display, there
  is nothing to switch to — cap the frame rate and shrink the viewport instead, and expect software
  rendering.
- Hybrid-graphics laptops: which GPU Chromium picks is a driver/OS decision. Do not chase the
  discrete GPU — forcing it on an Optimus laptop measured **slower** first paint, because the panel
  is wired to the integrated GPU and every frame has to be copied across.
