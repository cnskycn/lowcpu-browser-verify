# lowcpu-browser-verify

**Your headless Playwright browser is probably rendering on the CPU.**

`headless: true` starts `chrome-headless-shell` — a stripped binary with no GPU support. WebGL falls
back to SwiftShader software rasterization, which pins **4–6 CPU cores** on a scene that should cost
a fraction of one. The common belief that "headless is the cheap option" is exactly backwards for
anything that draws.

```js
// ❌ software rendering — the headless shell can never reach the GPU
const bad = await chromium.launch({ headless: true });

// ✅ hardware rendering, still no visible window
const good = await chromium.launch({ channel: 'chromium' });
```

Measured on Playwright 1.61.1, Windows, Intel HD 630, same page, same 20 s window:

| Launch | Renderer | CPU |
| --- | --- | --- |
| `headless: true` | SwiftShader (software) | **6.4 cores** |
| `channel: 'chromium'` | Intel HD 630 (hardware) | **0.3–1.1 cores** |

That is a 6–20× difference from a one-word change, with no window and no desktop required.

## Quick start

```bash
git clone <this repo>
cd lowcpu-browser-verify
npm install playwright
npx playwright install chromium        # the FULL build — the headless shell cannot do GPU

node scripts/doctor.mjs
```

```
lowcpu-browser doctor  ·  8 logical cores  ·  win32

mode                          rendering   renderer
--------------------------------------------------------------------------------
channel:'chromium'  (default) HARDWARE    ANGLE (Intel, Intel(R) HD Graphics 630 ...
visible window                HARDWARE    ANGLE (Intel, Intel(R) HD Graphics 630 ...
headless:true (shell)         SOFTWARE    ANGLE (Google, Vulkan 1.3.0 (SwiftShader ...

VERDICT: HARDWARE RENDERING — GPU is active.
```

Point it at your own page to also get a CPU number:

```bash
node scripts/doctor.mjs --measure http://localhost:5173/
```

It exits non-zero when the default path is software rendering, so you can use it as a CI gate.

## In your own test

```js
import { launch, lowCpuUrl, checkGpu, withBrowser, VIEWPORT } from './scripts/launch.mjs';

await withBrowser(async (browser) => {
  const page = await browser.newPage({ viewport: VIEWPORT });
  await page.goto(lowCpuUrl('http://localhost:5173/', 6));

  const gpu = await checkGpu(page);
  if (gpu.software) throw new Error('software rendering: ' + gpu.renderer);

  // ... assertions / screenshots
});   // closed even if the body throws
```

Add that assertion. Perf regressions here are invisible otherwise: the test passes, the screenshots
look right, and the only symptom is a laptop fan.

## Why this is not just "use headed mode"

The usual workaround is `headless: false` with the window parked off-screen. That works, but it needs
a display server, and it is a workaround rather than the actual fix. `channel: 'chromium'` selects
**full Chromium in new-headless mode**, which gets hardware rendering with no window at all. In the
measurements above it matched or beat the off-screen-window approach.

| Launch | Binary | GPU | Window | Display needed |
| --- | --- | --- | --- | --- |
| `headless: true` | `chrome-headless-shell` | ❌ | no | no |
| `channel: 'chromium'` | full Chromium | ✅ | no | no |
| `headless: false` | full Chromium | ✅ | yes | yes |

## Two more cheap wins

**Cap the frame rate.** A `requestAnimationFrame` loop runs flat out; a screenshot does not need
60 fps. Let the page skip frames it will never show:

```js
const MIN = 1000 / fps;
let last = 0;
function loop(t) {
  requestAnimationFrame(loop);
  if (t - last < MIN) return;   // not due yet
  last = t;
  render();
}
```

**Keep the pixel count small.** DPR 2 quadruples the pixels. DPR 1 at 1000×700 is 0.70 MP;
1200×780 (0.94 MP) for desktop-breakpoint assertions; 390×844 for phone portrait.

**Always close the browser.** A leaked browser keeps burning CPU after the run ends. `withBrowser()`
guarantees it.

## Verify, don't infer

Launch flags lie, and Chromium's headless implementation has changed more than once. The only
trustworthy evidence is the WebGL renderer string read inside a live page:

```js
const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
const ext = gl.getExtension('WEBGL_debug_renderer_info');
gl.getParameter(ext.UNMASKED_RENDERER_WEBGL);
// HARDWARE -> "ANGLE (Intel, Intel(R) HD Graphics 630 ..., D3D11)"
// SOFTWARE -> "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)"
```

## Scope and limits

- Measured on **Playwright 1.61.1 / Chromium 1228, Windows, Intel HD 630**. The mechanism is
  Chromium-wide; absolute CPU numbers will differ on your hardware.
- Hardware rendering needs *a* GPU. On a GPU-less headless server there is nothing to switch to —
  cap the frame rate, shrink the viewport, and expect software rendering.
- **Hybrid-graphics laptops: do not chase the discrete GPU.** Forcing it
  (`--force_high_performance_gpu`) measured *slower* first paint (1.6 s vs 0.5 s) because the panel is
  wired to the integrated GPU and every frame must be copied across. Let the OS decide.
- `--headless=new` as a raw argv flag also works, but `channel` is the supported API (Playwright ≥ 1.49).

## License

MIT
