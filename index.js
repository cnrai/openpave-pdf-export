#!/usr/bin/env node
/**
 * OpenPAVE PDF-Export Skill
 *
 * Exports HTML slide decks to PDF by spawning a Puppeteer-based
 * export script as a child process (bypassing sandbox wrapper).
 *
 * Features:
 *   - Auto-detects Chrome/Chromium path (macOS, Linux, Windows)
 *   - Auto-detects puppeteer-core location
 *   - Per-slide screenshot capture at 2x retina resolution
 *   - Clickable link preservation (native PDF link annotations)
 *   - Video-to-link swap (.hide-for-pdf / .video-link-pdf CSS classes)
 *   - Instant-complete animations (no opacity:0 artifacts)
 *   - Configurable slide selector, dimensions, and scale factor
 *
 * Usage (from PAVE chat):
 *   pdf-export export -i /path/to/index.html -o /path/to/output.pdf
 *   pdf-export export -i /path/to/index.html              (auto-names output)
 *   pdf-export export                                       (uses CWD defaults)
 */

var fs = require('fs');
var path = require('path');
var args = process.argv.slice(2);

// ── System exec (sandbox-compatible) ────────────────────────────

function execCommand(cmd) {
  if (typeof __ipc__ === 'function') {
    var safeCmd = 'unset NODE_OPTIONS; ' + cmd;
    var result = __ipc__('system.exec', safeCmd);
    if (result.err) throw new Error(result.err);
    return { stdout: result.stdout || '', stderr: result.stderr || '', exitCode: result.exitCode || 0 };
  }
  try {
    var cp = require('child_process');
    var out = cp.execSync(cmd, { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
    return { stdout: out, stderr: '', exitCode: 0 };
  } catch (e) {
    return { stdout: e.stdout || '', stderr: e.stderr || '', exitCode: e.status || 1 };
  }
}

function exec(cmd) { return execCommand(cmd); }

function shellEscape(s) {
  if (!s) return "''";
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

// ── Path existence check (robust against macOS extended attrs) ──

function pathExists(p) {
  try { fs.statSync(p); return true; } catch (e) { return false; }
}

// ── Chrome/Chromium auto-detection ─────────────────────────────

function detectChromePath() {
  var candidates = [];

  // macOS
  candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  candidates.push('/Applications/Chromium.app/Contents/MacOS/Chromium');
  candidates.push('/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary');
  candidates.push('/Applications/Brave Browser.app/Contents/MacOS/Brave Browser');
  candidates.push('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');

  // Linux
  candidates.push('/usr/bin/google-chrome');
  candidates.push('/usr/bin/google-chrome-stable');
  candidates.push('/usr/bin/chromium');
  candidates.push('/usr/bin/chromium-browser');
  candidates.push('/snap/bin/chromium');

  // Windows (via WSL or native)
  candidates.push('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
  candidates.push('C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe');
  candidates.push(process.env.LOCALAPPDATA ? process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe' : '');

  for (var i = 0; i < candidates.length; i++) {
    if (candidates[i] && pathExists(candidates[i])) {
      return candidates[i];
    }
  }

  // Try `which` as last resort
  try {
    var result = execCommand('which google-chrome || which chromium || which chromium-browser 2>/dev/null');
    var found = (result.stdout || '').trim().split('\n')[0];
    if (found && pathExists(found)) return found;
  } catch (e) {}

  return null;
}

// ── Puppeteer-core auto-detection ──────────────────────────────

function detectNodePath(inputFile) {
  var paths = [];
  var checked = {};

  function walkUp(startDir) {
    var dir = startDir;
    var prev = '';
    while (dir !== prev) {
      var candidate = path.join(dir, 'node_modules');
      if (!checked[candidate]) {
        checked[candidate] = true;
        if (pathExists(path.join(candidate, 'puppeteer-core'))) {
          paths.push(candidate);
          return;
        }
      }
      prev = dir;
      dir = path.dirname(dir);
    }
  }

  // 1. Check PAVE_NODE_PATH env var (user override)
  if (process.env.PAVE_NODE_PATH) {
    paths.push(process.env.PAVE_NODE_PATH);
  }

  // 2. Walk up from CWD looking for node_modules with puppeteer-core
  walkUp(process.cwd());

  // 3. Walk up from input file's directory (common case: puppeteer-core is
  //    in a parent node_modules relative to the project, not the skill)
  if (inputFile) {
    walkUp(path.dirname(inputFile));
  }

  // 4. Check npm global root
  try {
    var result = execCommand('npm root -g 2>/dev/null');
    var globalRoot = (result.stdout || '').trim();
    if (globalRoot && pathExists(path.join(globalRoot, 'puppeteer-core'))) {
      paths.push(globalRoot);
    }
  } catch (e) {}

  // 5. Common global locations
  var globalCandidates = [
    '/usr/local/lib/node_modules',
    '/usr/lib/node_modules',
    '/opt/homebrew/lib/node_modules'
  ];
  // Home-relative paths
  var home = process.env.HOME || process.env.USERPROFILE || '';
  if (home) {
    globalCandidates.push(path.join(home, '.nvm/versions/node'));
    globalCandidates.push(path.join(home, 'node_modules'));
    globalCandidates.push(path.join(home, '.npm-global/lib/node_modules'));
  }
  for (var i = 0; i < globalCandidates.length; i++) {
    var p = globalCandidates[i];
    if (pathExists(path.join(p, 'puppeteer-core'))) {
      paths.push(p);
    }
  }

  return paths.length > 0 ? paths.join(':') : null;
}

// ── Argument parser ─────────────────────────────────────────────

function parseArgs() {
  var parsed = { command: null, options: {} };
  var i = 0;
  if (i < args.length && !args[i].startsWith('-')) {
    parsed.command = args[i]; i++;
  }
  for (; i < args.length; i++) {
    var a = args[i];
    if (a.startsWith('--')) {
      var eq = a.indexOf('=');
      if (eq !== -1) {
        parsed.options[a.slice(2, eq)] = a.slice(eq + 1);
      } else if (i + 1 < args.length && !args[i + 1].startsWith('-')) {
        parsed.options[a.slice(2)] = args[i + 1]; i++;
      } else {
        parsed.options[a.slice(2)] = true;
      }
    } else if (a.startsWith('-') && a.length === 2) {
      if (i + 1 < args.length && !args[i + 1].startsWith('-')) {
        parsed.options[a.slice(1)] = args[i + 1]; i++;
      } else {
        parsed.options[a.slice(1)] = true;
      }
    }
  }
  return parsed;
}

// ── Inline export script generator ──────────────────────────────

function buildExportScript(opts) {
  var inputFile = opts.input;
  var outputFile = opts.output;
  var chromePath = opts.chrome;
  var width = parseInt(opts.width, 10) || 1920;
  var height = parseInt(opts.height, 10) || 1080;
  var scale = parseInt(opts.scale, 10) || 2;
  var selector = opts.selector || '.slide';

  // Generate a self-contained Node.js script as a string
  return `
const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');

const CHROME_PATH = ${JSON.stringify(chromePath)};
const HTML_FILE = ${JSON.stringify(inputFile)};
const OUTPUT_PDF = ${JSON.stringify(outputFile)};
const WIDTH = ${width};
const HEIGHT = ${height};
const SCALE = ${scale};
const SELECTOR = ${JSON.stringify(selector)};

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function exportToPDF() {
    console.log('Starting PDF export...');
    console.log('Input:  ' + HTML_FILE);
    console.log('Output: ' + OUTPUT_PDF);

    const browser = await puppeteer.launch({
        executablePath: CHROME_PATH,
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu',
               '--disable-web-security', '--allow-file-access-from-files']
    });

    const page = await browser.newPage();
    await page.setViewport({ width: WIDTH, height: HEIGHT, deviceScaleFactor: SCALE });

    const fileUrl = 'file://' + HTML_FILE;
    await page.goto(fileUrl, { waitUntil: 'networkidle0', timeout: 30000 });
    await page.evaluate(() => document.fonts.ready);
    await delay(2000);

    const slideCount = await page.evaluate((sel) => document.querySelectorAll(sel).length, SELECTOR);

    if (slideCount === 0) {
        console.error('ERROR: No slides found with selector "' + SELECTOR + '"');
        console.error('Check that your HTML contains elements matching this selector.');
        console.error('Use --selector to specify a different CSS selector.');
        await browser.close();
        process.exit(1);
    }

    console.log('Detected ' + slideCount + ' slides (selector: ' + SELECTOR + ')');

    // One-time setup: disable transitions, handle video/pdf swaps, hide UI chrome
    await page.evaluate((sel) => {
        // Mark html+body so author CSS can guard animation initial states via
        //   body:not(.pdf-export) .anim { opacity: 0 }
        // Must be set BEFORE author scripts are removed so any pre-removal JS
        // and all class-based CSS guards see it.
        document.documentElement.classList.add('pdf-export');
        document.body.classList.add('pdf-export');

        document.querySelectorAll('script').forEach(el => el.remove());
        document.querySelectorAll('video').forEach(v => { v.style.display = 'none'; });
        document.querySelectorAll('.video-link-pdf').forEach(link => { link.style.display = 'block'; });
        document.querySelectorAll('.hide-for-pdf').forEach(el => { el.style.display = 'none'; });

        // Kill transitions, instantly complete animations to final state
        // Uses 0.001s duration + fill-mode:forwards so animated opacity values
        // resolve to their intended final state (not 0). For robustness, author
        // CSS should also gate animation-initial-state rules with
        // `body:not(.pdf-export)` so no animation runs during export at all.
        const killStyle = document.createElement('style');
        killStyle.textContent = '*, *::before, *::after { transition: none !important; transition-delay: 0s !important; animation-delay: 0s !important; animation-duration: 0.001s !important; animation-fill-mode: forwards !important; }';
        document.head.appendChild(killStyle);

        // Hide common navigation/overlay elements
        ['.nav-controls', '.controls', '.slide-number', '.overlay',
         '[class*="toolbar"]', '[class*="navigation"]'].forEach(s => {
            document.querySelectorAll(s).forEach(el => { el.style.display = 'none'; });
        });
    }, SELECTOR);

    const slideBuffers = [];
    const slideLinks = [];
    for (let i = 0; i < slideCount; i++) {
        await page.evaluate((idx, total, sel, w, h) => {
            const slides = document.querySelectorAll(sel);
            for (let j = 0; j < total; j++) {
                const slide = slides[j];
                if (j === idx) {
                    slide.style.display = '';
                    slide.style.opacity = '1';
                    slide.style.visibility = 'visible';
                    slide.style.zIndex = '10';
                    slide.style.position = 'absolute';
                    slide.style.top = '0';
                    slide.style.left = '0';
                    // Pin the active slide to the capture viewport so that any
                    // absolutely-positioned chrome (brand bars with bottom:0,
                    // slide numbers, footers) anchors to the page edges rather
                    // than collapsing to content height. Without this, a slide
                    // whose CSS doesn't set an explicit height will shrink-wrap
                    // and `bottom:0` elements float into the middle of the slide.
                    slide.style.width = w + 'px';
                    slide.style.height = h + 'px';
                    slide.classList.add('active');
                } else {
                    slide.style.display = 'none';
                    slide.style.opacity = '0';
                    slide.style.visibility = 'hidden';
                    slide.style.zIndex = '-1';
                    slide.classList.remove('active');
                }
            }
        }, i, slideCount, SELECTOR, WIDTH, HEIGHT);

        await delay(300);

        // Collect visible link bounding boxes for PDF annotations
        const links = await page.evaluate(() => {
            const results = [];
            document.querySelectorAll('a[href]').forEach(a => {
                const href = a.getAttribute('href');
                if (!href || href.startsWith('#') || href.startsWith('javascript')) return;
                const rect = a.getBoundingClientRect();
                if (rect.width > 0 && rect.height > 0 && rect.top < window.innerHeight && rect.bottom > 0) {
                    results.push({ href: href, x: rect.x, y: rect.y, w: rect.width, h: rect.height });
                }
            });
            return results;
        });
        slideLinks.push(links);

        const screenshot = await page.screenshot({
            type: 'png',
            clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT }
        });
        slideBuffers.push(screenshot);
        process.stdout.write('\\r  Captured slide ' + (i + 1) + '/' + slideCount);
    }
    console.log('');

    // Report detected links
    let totalLinks = 0;
    slideLinks.forEach((links, idx) => {
        if (links.length > 0) {
            totalLinks += links.length;
            console.log('  Slide ' + (idx + 1) + ': ' + links.length + ' clickable link(s)');
        }
    });
    if (totalLinks > 0) console.log('  Total: ' + totalLinks + ' link(s) will be clickable in PDF');

    // Assemble PDF — write temp HTML file to avoid setContent timeout on large decks
    console.log('Assembling PDF...');
    const tmpHtmlPath = OUTPUT_PDF.replace(/\\.pdf$/i, '') + '-tmp-assembly.html';
    const pdfPage = await browser.newPage();
    const slidesHtml = slideBuffers.map((buf, idx) => {
        const base64 = buf.toString('base64');
        // Overlay clickable transparent links on top of the screenshot
        let linkOverlays = '';
        if (slideLinks[idx] && slideLinks[idx].length > 0) {
            slideLinks[idx].forEach(link => {
                linkOverlays += '<a href="' + link.href.replace(/"/g, '&quot;') + '" style="' +
                    'position: absolute;' +
                    'left: ' + link.x + 'px;' +
                    'top: ' + link.y + 'px;' +
                    'width: ' + link.w + 'px;' +
                    'height: ' + link.h + 'px;' +
                    'display: block;' +
                    'z-index: 10;' +
                    '"></a>';
            });
        }
        return '<div class="slide-page" style="position: relative;">' +
            '<img src="data:image/png;base64,' + base64 + '" />' +
            linkOverlays +
            '</div>';
    }).join('\\n');

    const pdfHtml = '<!DOCTYPE html><html><head><style>' +
        '@page { size: ' + WIDTH + 'px ' + HEIGHT + 'px; margin: 0; }' +
        '* { margin: 0; padding: 0; box-sizing: border-box; }' +
        'body { margin: 0; padding: 0; }' +
        '.slide-page { width: ' + WIDTH + 'px; height: ' + HEIGHT + 'px; page-break-after: always; page-break-inside: avoid; }' +
        '.slide-page:last-child { page-break-after: auto; }' +
        '.slide-page img { width: ' + WIDTH + 'px; height: ' + HEIGHT + 'px; display: block; }' +
        '</style></head><body>' + slidesHtml + '</body></html>';

    fs.writeFileSync(tmpHtmlPath, pdfHtml);
    await pdfPage.goto('file://' + tmpHtmlPath, { waitUntil: 'networkidle0', timeout: 120000 });
    await pdfPage.pdf({
        path: OUTPUT_PDF,
        width: WIDTH + 'px',
        height: HEIGHT + 'px',
        printBackground: true,
        margin: { top: 0, right: 0, bottom: 0, left: 0 }
    });
    try { fs.unlinkSync(tmpHtmlPath); } catch(e) {}

    await browser.close();

    const stats = fs.statSync(OUTPUT_PDF);
    const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);
    console.log('');
    console.log('PDF exported successfully!');
    console.log('  File:  ' + OUTPUT_PDF);
    console.log('  Pages: ' + slideCount);
    console.log('  Size:  ' + sizeMB + ' MB');
}

exportToPDF().catch(err => {
    console.error('Export failed:', err.message);
    process.exit(1);
});
`;
}

// ── Main ────────────────────────────────────────────────────────

function main() {
  var parsed = parseArgs();

  if (!parsed.command || parsed.command === 'help' || parsed.options.help || parsed.options.h) {
    console.log('PDF Slide Deck Exporter');
    console.log('');
    console.log('Usage:');
    console.log('  pdf-export export -i <html-file> [-o <pdf-file>] [options]');
    console.log('');
    console.log('Options:');
    console.log('  -i, --input <file>       HTML slide deck to export (default: ./index.html)');
    console.log('  -o, --output <file>      Output PDF path (default: <dir>/<dirname>.pdf)');
    console.log('  --chrome <path>          Chrome/Chromium executable path (auto-detected)');
    console.log('  --width <px>             Slide width in pixels (default: 1920)');
    console.log('  --height <px>            Slide height in pixels (default: 1080)');
    console.log('  --scale <n>              Device scale factor for retina (default: 2)');
    console.log('  --selector <css>         Slide element CSS selector (default: .slide)');
    console.log('  --node-path <paths>      NODE_PATH for finding puppeteer-core (auto-detected)');
    console.log('  --open                   Open PDF after export');
    console.log('');
    console.log('CSS Class Conventions:');
    console.log('  .hide-for-pdf            Hidden during PDF export (e.g. video players)');
    console.log('  .video-link-pdf          Shown during PDF export (e.g. video link cards)');
    console.log('');
    console.log('Requirements:');
    console.log('  - Google Chrome or Chromium');
    console.log('  - puppeteer-core (npm install puppeteer-core)');
    console.log('');
    console.log('Examples:');
    console.log('  pdf-export export -i slides/index.html -o slides/deck.pdf');
    console.log('  pdf-export export --width 1280 --height 720 --scale 1');
    console.log('  pdf-export export --selector "section.slide" --open');
    return;
  }

  if (parsed.command !== 'export') {
    console.error('Unknown command: ' + parsed.command);
    console.error('Use: pdf-export export -i <file>');
    process.exit(1);
  }

  // ── Resolve input ──────────────────────────────────────────────

  var inputFile = parsed.options.i || parsed.options.input;
  if (!inputFile) {
    var defaultInput = path.join(process.cwd(), 'index.html');
    if (pathExists(defaultInput)) {
      inputFile = defaultInput;
    } else {
      console.error('Error: No input file specified and no index.html found in CWD.');
      console.error('Use: pdf-export export -i /path/to/index.html');
      process.exit(1);
    }
  }
  inputFile = path.isAbsolute(inputFile) ? inputFile : path.join(process.cwd(), inputFile);

  if (!pathExists(inputFile)) {
    console.error('Error: Input file not found: ' + inputFile);
    process.exit(1);
  }

  // ── Resolve output ─────────────────────────────────────────────

  var outputFile = parsed.options.o || parsed.options.output;
  if (!outputFile) {
    var dir = path.dirname(inputFile);
    var base = path.basename(dir) || 'slides';
    outputFile = path.join(dir, base + '.pdf');
  }
  outputFile = path.isAbsolute(outputFile) ? outputFile : path.join(process.cwd(), outputFile);

  // ── Detect Chrome ──────────────────────────────────────────────

  var chromePath = parsed.options.chrome || detectChromePath();
  if (!chromePath) {
    console.error('Error: Chrome/Chromium not found.');
    console.error('');
    console.error('Install Google Chrome or specify the path manually:');
    console.error('  pdf-export export -i deck.html --chrome /path/to/chrome');
    console.error('');
    console.error('Searched locations:');
    console.error('  macOS:  /Applications/Google Chrome.app/...');
    console.error('  Linux:  /usr/bin/google-chrome, /usr/bin/chromium');
    console.error('  Other:  which google-chrome, which chromium');
    process.exit(1);
  }

  // ── Detect puppeteer-core ──────────────────────────────────────

  var nodePath = parsed.options['node-path'] || detectNodePath(inputFile);
  if (!nodePath) {
    console.error('Error: puppeteer-core not found.');
    console.error('');
    console.error('Install it with:');
    console.error('  npm install puppeteer-core');
    console.error('  # or globally:');
    console.error('  npm install -g puppeteer-core');
    console.error('');
    console.error('Or specify the NODE_PATH manually:');
    console.error('  pdf-export export -i deck.html --node-path /path/to/node_modules');
    console.error('');
    console.error('You can also set the PAVE_NODE_PATH environment variable.');
    process.exit(1);
  }

  var opts = {
    input: inputFile,
    output: outputFile,
    chrome: chromePath,
    width: parsed.options.width || '1920',
    height: parsed.options.height || '1080',
    scale: parsed.options.scale || '2',
    selector: parsed.options.selector || '.slide'
  };

  // ── Write temp script and execute ──────���───────────────────────

  var tmpScript = '/tmp/pave-pdf-export-' + Date.now() + '.cjs';
  var scriptContent = buildExportScript(opts);
  fs.writeFileSync(tmpScript, scriptContent);

  console.log('Exporting slide deck to PDF...');
  console.log('  Input:    ' + inputFile);
  console.log('  Output:   ' + outputFile);
  console.log('  Chrome:   ' + chromePath);
  console.log('  Size:     ' + opts.width + 'x' + opts.height + ' @' + opts.scale + 'x');
  console.log('  Selector: ' + opts.selector);
  console.log('');

  var result = exec('NODE_PATH=' + shellEscape(nodePath) + ' node ' + shellEscape(tmpScript));

  // Output results
  if (result.stdout) console.log(result.stdout.trim());
  if (result.stderr) console.error(result.stderr.trim());

  // Cleanup temp script
  try { fs.unlinkSync(tmpScript); } catch (e) {}

  if (result.exitCode !== 0) {
    console.error('');
    console.error('PDF export failed (exit code ' + result.exitCode + ')');
    process.exit(1);
  }

  // Open if requested
  if (parsed.options.open) {
    try {
      // Cross-platform open
      var openCmd = process.platform === 'darwin' ? 'open'
        : process.platform === 'win32' ? 'start'
        : 'xdg-open';
      exec(openCmd + ' ' + shellEscape(outputFile));
      console.log('Opened PDF in default viewer.');
    } catch (e) {}
  }
}

main();
