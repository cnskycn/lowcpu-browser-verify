#!/usr/bin/env node
// doctor.mjs — answer one question: is my browser automation rendering on the GPU, or burning CPU in
// software?
//
// The primary signal is the WebGL renderer string read from inside a live page. That is the only
// trustworthy evidence: launch flags lie, and flag-based guesses get it wrong on every Chromium
// version that changed its headless implementation.
//
//   node scripts/doctor.mjs                  # GPU check for each launch mode
//   node scripts/doctor.mjs --url <url>      # same, but load your own page first
//   node scripts/doctor.mjs --measure <url>  # additionally measure CPU on YOUR page
//
// Why CPU numbers are opt-in and need a real URL:
// A synthetic probe page cannot stand in for your app. Software rasterization is priced per fragment
// and per draw, so a trivial probe costs nearly nothing even under SwiftShader — measuring it would
// imply software rendering is free, which is the opposite of the truth. Real WebGL scenes (three.js,
// Cesium, Mapbox) drive 4–6 cores on software. So CPU is only reported when you point it at a real
// page, and the tool says plainly that no CPU number was measured otherwise.
import { launch, checkGpu } from './launch.mjs';
import { spawn } from 'node:child_process';
import { cpus } from 'node:os';

const argv = process.argv.slice(2);
const opt = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
};
const URL_ARG = opt('--url');
const MEASURE_URL = opt('--measure');
const CORES = cpus().length;

// ---- CPU accounting (only used for --measure) -------------------------------------------------
// Per-PID deltas, and anything alive before launch is excluded. Two traps this avoids:
//   1. Summing the whole tree lets a previous run's dying processes produce a NEGATIVE delta.
//   2. Counting every browser process charges the user's own Chrome window to the measurement.
function cpuSampler() {
  const isWin = process.platform === 'win32';
  const cmd = isWin ? 'powershell' : 'ps';
  const args = isWin
    ? ['-NoProfile', '-Command',
       `Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
          Where-Object { $_.Name -match 'chrome|chromium|msedge' } |
          ForEach-Object { $p = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue
            if ($p) { "$($_.ProcessId),$($p.TotalProcessorTime.TotalSeconds)" } }`]
    : ['-eo', 'pid,times'];
  return new Promise((resolve) => {
    const r = spawn(cmd, args, { windowsHide: true });
    let out = '';
    r.stdout.on('data', (d) => (out += d));
    r.on('close', () => {
      const snap = new Map();
      for (const line of out.split(/\r?\n/)) {
        const t = line.trim();
        if (!t) continue;
        if (isWin) {
          const [pid, cpu] = t.split(',');
          if (pid && cpu !== undefined) snap.set(pid, parseFloat(cpu) || 0);
        } else {
          const m = t.match(/^(\d+)\s+([\d:.]+)/);
          if (m) {
            const p = m[2].split(':').map(Number);
            snap.set(m[1], p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : 0);
          }
        }
      }
      resolve(snap);
    });
  });
}

async function measureCpu(url, ms = 8000) {
  const pre = await cpuSampler();
  let browser;
  try {
    browser = await launch();
    const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2500);          // let the scene warm up before counting
    const gpu = await checkGpu(page);

    const before = await cpuSampler();
    const t0 = Date.now();
    await page.waitForTimeout(ms);
    const after = await cpuSampler();
    const wall = (Date.now() - t0) / 1000;

    let seconds = 0;
    for (const [pid, cpu] of after) {
      if (pre.has(pid)) continue;             // belonged to the user, not to us
      seconds += Math.max(0, cpu - (before.has(pid) ? before.get(pid) : 0));
    }
    return { ...gpu, cores: +(seconds / wall).toFixed(2), seconds: +seconds.toFixed(2),
             excluded: pre.size };
  } finally {
    if (browser) { try { await browser.close(); } catch {} }
  }
}

// ---- GPU check per launch mode ----------------------------------------------------------------
async function gpuOf(opts, url) {
  let browser;
  try {
    browser = await launch(opts);
    const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
    await page.goto(url || 'about:blank');
    if (url) await page.waitForTimeout(1200);
    return await checkGpu(page);
  } catch (e) {
    return { error: String((e && e.message) || e) };
  } finally {
    if (browser) { try { await browser.close(); } catch {} }
  }
}

console.log(`\nlowcpu-browser doctor  ·  ${CORES} logical cores  ·  ${process.platform}\n`);

const modes = [
  ["channel:'chromium'  (default)", {}],
  ['visible window', { visible: true }],
  ['headless:true (shell)', { headless: true }],
];

console.log('mode'.padEnd(30) + 'rendering'.padEnd(12) + 'renderer');
console.log('-'.repeat(112));

const seen = new Map();
for (const [label, opts] of modes) {
  const info = await gpuOf(opts, URL_ARG);
  if (info.error) {
    console.log(label.padEnd(30) + 'ERROR'.padEnd(12) + info.error.slice(0, 60));
    seen.set(label, { error: info.error });
    continue;
  }
  const kind = info.software ? 'SOFTWARE' : 'HARDWARE';
  console.log(label.padEnd(30) + kind.padEnd(12) + String(info.renderer).slice(0, 62));
  seen.set(label, info);
}

const def = seen.get("channel:'chromium'  (default)");

if (MEASURE_URL) {
  console.log(`\nmeasuring CPU on ${MEASURE_URL} …`);
  const m = await measureCpu(MEASURE_URL);
  console.log(`  rendering : ${m.software ? 'SOFTWARE' : 'HARDWARE'}`);
  console.log(`  cpu       : ${m.cores} cores  (${m.seconds}s over the window)`);
  console.log(`  excluded  : ${m.excluded} pre-existing browser processes (your own browser)`);
} else {
  console.log('\n(no CPU number: pass --measure <url> with your real page — a synthetic');
  console.log(' probe cannot represent a heavy scene, and software rendering looks cheap on it.)');
}

console.log('');

if (def.error) {
  if (/Cannot find package 'playwright'|Cannot find module 'playwright'/.test(def.error)) {
    console.log('Playwright is not installed in this directory.\n');
    console.log('  npm install playwright');
    console.log('  npx playwright install chromium     # full build required for GPU rendering\n');
    process.exit(2);
  }
  console.log('Could not launch with channel:"chromium".');
  console.log('  npx playwright install chromium     # the full build is required for GPU rendering');
  process.exit(2);
}

if (def.software) {
  console.log('VERDICT: SOFTWARE RENDERING — this is the expensive path.');
  console.log('');
  console.log('WebGL is being rasterized on the CPU. Real scenes saturate 4–6 cores this way.');
  console.log('');
  console.log('Fix:');
  console.log("  chromium.launch({ channel: 'chromium' })");
  console.log('  npx playwright install chromium');
  console.log('');
  console.log('The stripped chrome-headless-shell that headless:true starts can never use a GPU.');
  process.exit(1);
}

console.log('VERDICT: HARDWARE RENDERING — GPU is active.');
console.log(`  ${def.renderer}`);
process.exit(0);
