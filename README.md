# OpenPAVE PDF-Export Skill

Export HTML slide decks to high-fidelity PDF. Captures each slide as a retina screenshot, preserves clickable links as native PDF annotations, and handles video-to-link swaps for print output.

## Features

- **Per-slide capture** — Each slide rendered individually at 2x retina resolution (configurable)
- **Clickable links** — `<a>` elements detected and overlaid as native PDF link annotations
- **Video handling** — Elements with `.hide-for-pdf` hidden; elements with `.video-link-pdf` shown
- **Animation handling** — Animations instantly completed to final state (no opacity:0 artifacts)
- **Auto-detection** — Chrome/Chromium path and `puppeteer-core` location found automatically
- **Cross-platform** — macOS, Linux, Windows

## Requirements

- **Google Chrome** or **Chromium** (auto-detected, or specify with `--chrome`)
- **puppeteer-core** — `npm install puppeteer-core` (project-local or global)
- **Node.js** >= 16

## Installation

```bash
pave install pdf-export
```

Or install from the marketplace registry:

```bash
pave skill install pdf-export
```

## Usage

```bash
# Export slide deck in current directory (looks for index.html)
pdf-export export

# Specify input and output
pdf-export export -i slides/index.html -o slides/deck.pdf

# Custom dimensions (e.g. 720p)
pdf-export export -i deck.html --width 1280 --height 720

# Different slide selector
pdf-export export -i deck.html --selector "section.slide"

# Open PDF after export
pdf-export export -i deck.html --open

# Specify Chrome path manually
pdf-export export -i deck.html --chrome /usr/bin/chromium

# Specify puppeteer-core location
pdf-export export -i deck.html --node-path /opt/node_modules
```

## Options

| Option | Default | Description |
|--------|---------|-------------|
| `-i, --input <file>` | `./index.html` | HTML slide deck file path |
| `-o, --output <file>` | `<dir>/<dirname>.pdf` | Output PDF file path |
| `--chrome <path>` | auto-detected | Chrome/Chromium executable path |
| `--width <px>` | `1920` | Slide viewport width in pixels |
| `--height <px>` | `1080` | Slide viewport height in pixels |
| `--scale <n>` | `2` | Device scale factor (2 = retina) |
| `--selector <css>` | `.slide` | CSS selector matching slide elements |
| `--node-path <paths>` | auto-detected | `NODE_PATH` for finding puppeteer-core |
| `--open` | `false` | Open PDF in default viewer after export |

## How It Works

1. **Launch Chrome** via `puppeteer-core` in headless mode
2. **Navigate** to the HTML file with `file://` protocol
3. **Prepare the page** — disable transitions, instantly complete animations, hide videos, show PDF link cards, remove navigation UI
4. **Capture each slide** — iterate through slides, showing one at a time, taking a PNG screenshot at the configured resolution
5. **Collect links** — for each visible slide, gather bounding boxes of all `<a>` elements
6. **Assemble PDF** — create a temporary HTML file with base64 screenshots as `<img>` tags, overlay transparent `<a>` elements at the same positions, render to PDF via Puppeteer's `page.pdf()`
7. **Clean up** — remove temp files

### Why a temp script?

PAVE's sandbox wraps `require()` which breaks deep module chains like Puppeteer's use of `node:fs/promises`. The skill writes a self-contained CJS script to `/tmp/` and executes it via `system.exec` with `NODE_OPTIONS` unset, bypassing the sandbox wrapper entirely.

## CSS Class Conventions

Add these classes to your HTML slide deck for PDF-specific behavior:

| Class | Effect |
|-------|--------|
| `.hide-for-pdf` | Element is hidden during PDF export (e.g. `<video>` players) |
| `.video-link-pdf` | Element is shown during PDF export (default `display:none` in browser). Use for video link cards with Google Drive URLs |
| `.slide` | Default slide selector (configurable with `--selector`) |

### Example: Video with PDF link card

```html
<div class="slide">
  <!-- Plays in browser, hidden in PDF -->
  <video class="hide-for-pdf" autoplay loop muted>
    <source src="demo.mp4" type="video/mp4">
  </video>

  <!-- Hidden in browser, shown in PDF -->
  <div class="video-link-pdf" style="display: none;">
    <a href="https://drive.google.com/file/d/xxxxx/view">
      Watch Demo Video
    </a>
  </div>
</div>
```

## Chrome Auto-Detection

The skill searches these locations in order:

**macOS:**
- `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`
- `/Applications/Chromium.app/Contents/MacOS/Chromium`
- `/Applications/Google Chrome Canary.app/...`
- `/Applications/Brave Browser.app/...`
- `/Applications/Microsoft Edge.app/...`

**Linux:**
- `/usr/bin/google-chrome`
- `/usr/bin/google-chrome-stable`
- `/usr/bin/chromium`
- `/usr/bin/chromium-browser`
- `/snap/bin/chromium`

**Fallback:** `which google-chrome || which chromium`

## Puppeteer-Core Auto-Detection

The skill searches for `puppeteer-core` in:

1. `PAVE_NODE_PATH` environment variable (user override)
2. `./node_modules/` (project-local)
3. Parent directories walking up from CWD
4. `npm root -g` (global npm root)
5. Common global paths (`/usr/local/lib/node_modules`, `/opt/homebrew/lib/node_modules`, etc.)

## Animation Handling

Instead of `animation: none !important` (which kills animations and leaves elements at `opacity: 0`), the skill uses:

```css
animation-duration: 0.001s !important;
animation-fill-mode: forwards !important;
animation-delay: 0s !important;
```

This causes animations to complete instantly to their **final state**, preserving intentional opacity values on decorative elements (e.g. brackets at 0.15, arch-lines at 0.06).

## Environment Variables

| Variable | Description |
|----------|-------------|
| `PAVE_NODE_PATH` | Override NODE_PATH for finding puppeteer-core |

## Troubleshooting

### "Chrome/Chromium not found"
Install Google Chrome or specify the path: `--chrome /path/to/chrome`

### "puppeteer-core not found"
```bash
npm install puppeteer-core
# or globally:
npm install -g puppeteer-core
```

### "No slides found"
Check that your HTML contains elements matching the selector (default `.slide`). Use `--selector` to change it.

### Large PDFs
Each slide is captured as a 2x PNG screenshot. For a 32-slide 1920x1080 deck, expect ~35-40 MB. Reduce with `--scale 1` for non-retina output (~10-15 MB).

## License

MIT - C&R Wise AI Limited
