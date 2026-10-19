// Portable low-CPU browser launcher — zero machine-specific paths.
//
// The whole point: Playwright's `headless: true` starts `chrome-headless-shell`, a stripped binary
// that can never get a GPU. WebGL then falls back to SwiftShader software rasterization, which pins
// 4–6 CPU cores for what should be a trivial smoke test. `channel: 'chromium'` runs full Chromium in
// new-headless mode, which DOES get hardware rendering and needs no visible window.
//
// Verified on Playwright 1.61.1: headless shell rendered on SwiftShader at ~6.3 cores, while
// channel:'chromium' rendered on the real GPU at ~0.3–1.1 cores for the same page.
//
// Usage:
//   import { launch, lowCpuUrl, VIEWPORT, checkGpu } from './launch.mjs';
//   const browser = await launch();

/**
 * Launch a browser that renders on the GPU without opening a visible window.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.headless]   Use old headless shell (NO GPU — only for GPU-less CI).
 * @param {string[]} [opts.args]      Extra Chromium flags.
 * @param {boolean} [opts.visible]    Force a real visible window (rarely needed).
 * @param {string}  [opts.channel]    Override the channel, e.g. 'chrome' or 'msedge'.
 */
export async function launch(opts = {}) {
  const { chromium } = await import('playwright');
  const { headless = false, args = [], visible = false, channel = 'chromium', ...rest } = opts;

  const NOISE = ['--mute-audio', '--no-first-run', '--no-default-browser-check'];

  // Old headless: no GPU, but works where no display exists at all.
  if (headless) {
    return chromium.launch({ headless: true, args: [...NOISE, ...args], ...rest });
  }

  // A real window (the pre-1.49 workaround: window parked off-screen).
  if (visible) {
    return chromium.launch({
      headless: false,
      args: [...NOISE, '--window-position=-2400,-2400', '--window-size=1100,760', ...args],
      ...rest,
    });
  }

  // Default: full Chromium, new headless, hardware rendering, no window.
  try {
    return await chromium.launch({ channel, args: [...NOISE, ...args], ...rest });
  } catch (err) {
    // Older Playwright has no `channel`, or the full Chromium build is missing.
    // Fall back to an off-screen window so the caller still gets GPU rendering.
    const msg = String(err && err.message);
    if (/channel|Executable doesn't exist|not found/i.test(msg)) {
      console.warn(
        '[lowcpu] channel:"' + channel + '" unavailable — falling back to an off-screen window.\n' +
        '        Install the full browser with:  npx playwright install chromium\n' +
        '        (the headless SHELL cannot do GPU rendering)',
      );
      return chromium.launch({
        headless: false,
        args: [...NOISE, '--window-position=-2400,-2400', '--window-size=1100,760', ...args],
        ...rest,
      });
    }
    throw err;
  }
}

/** Append page-side low-cost params. Pair with a page that honours ?perf / ?fps. */
export function lowCpuUrl(base, fps = 6) {
  return base + (base.includes('?') ? '&' : '?') + `perf=low&fps=${fps}`;
}

/** 1000x700 at DPR 1 — roughly half the pixels of 1440x900. */
export const VIEWPORT = { width: 1000, height: 700 };
/** Phone portrait at DPR 1. DPR 2 quadruples the pixel count. */
export const MOBILE_VIEWPORT = { width: 390, height: 844 };
/** Desktop breakpoint that still exposes desktop-only layout (below ~1180px things get hidden). */
export const DESKTOP_VIEWPORT = { width: 1200, height: 780 };

/**
 * Read the real WebGL renderer string from a live page.
 * This is the only trustworthy way to know whether you are on hardware or software — never infer it
 * from launch flags.
 *
 * @returns {Promise<{renderer: string, vendor: string, software: boolean}>}
 */
export async function checkGpu(page) {
  const info = await page.evaluate(() => {
    const cv = document.createElement('canvas');
    const gl = cv.getContext('webgl2') || cv.getContext('webgl');
    if (!gl) return { renderer: 'no-webgl', vendor: 'no-webgl' };
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return {
      renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
      vendor: ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
    };
  });
  return { ...info, software: /swiftshader|software|llvmpipe|basic render/i.test(info.renderer || '') };
}

/** Guarantees the browser is closed even when the body throws — a leaked browser keeps burning CPU. */
export async function withBrowser(fn, opts = {}) {
  const browser = await launch(opts);
  try {
    return await fn(browser);
  } finally {
    await browser.close();
  }
}
