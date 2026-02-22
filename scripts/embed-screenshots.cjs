#!/usr/bin/env node
/**
 * Embed screenshot PNGs as base64 data URIs directly into cli-reference.html.
 * Handles both fresh HTML (file paths) and previously-embedded HTML (data URIs).
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const HTML_PATH = path.join(ROOT, 'cli-reference.html');
const SCREENSHOT_DIR = path.join(ROOT, 'screenshots');

const SCREENSHOTS = {
  'help.png':         { alt: 'wunderland --help',       dl: 'wunderland-help.png' },
  'version.png':      { alt: 'wunderland version',      dl: 'wunderland-version.png' },
  'doctor.png':       { alt: 'wunderland doctor',       dl: 'wunderland-doctor.png' },
  'status.png':       { alt: 'wunderland status',       dl: 'wunderland-status.png' },
  'list-presets.png': { alt: 'wunderland list-presets',  dl: 'wunderland-list-presets.png' },
  'models.png':       { alt: 'wunderland models',       dl: 'wunderland-models.png' },
  'skills.png':       { alt: 'wunderland skills list',   dl: 'wunderland-skills.png' },
  'plugins.png':      { alt: 'wunderland plugins',      dl: 'wunderland-plugins.png' },
};

let html = fs.readFileSync(HTML_PATH, 'utf8');

// Step 1: Strip ALL existing data:image/png;base64 URIs back to placeholder
html = html.replace(/src="data:image\/png;base64,[A-Za-z0-9+\/=]+"/g, 'src="__B64__"');
html = html.replace(/href="data:image\/png;base64,[A-Za-z0-9+\/=]+"/g, 'href="__B64__"');

// Step 2: Restore file paths using known alt/download attributes as anchors
for (const [file, meta] of Object.entries(SCREENSHOTS)) {
  const altEsc = meta.alt.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&');
  const dlEsc = meta.dl.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&');

  // img: src="__B64__" ... alt="wunderland ..."
  html = html.replace(
    new RegExp(`src="__B64__"(\\s[^>]*?alt="${altEsc}")`, 'g'),
    `src="screenshots/${file}"$1`,
  );

  // download link: href="__B64__" ... download="wunderland-NAME.png"
  html = html.replace(
    new RegExp(`href="__B64__"(\\s[^>]*?download="${dlEsc}")`, 'g'),
    `href="screenshots/${file}"$1`,
  );
}

// Also restore file paths that were already file:// paths (not b64)
// These won't have __B64__ so they're fine.

// Check for any remaining placeholders
const leftover = (html.match(/__B64__/g) || []).length;
if (leftover > 0) {
  console.log(`  WARNING: ${leftover} unresolved placeholders`);
  // Clean them up — set to empty
  html = html.replace(/"__B64__"/g, '""');
}

// Step 3: Embed fresh base64
let embedded = 0;
for (const file of Object.keys(SCREENSHOTS)) {
  const imgPath = path.join(SCREENSHOT_DIR, file);
  if (!fs.existsSync(imgPath)) {
    console.log(`  SKIP ${file} (not found)`);
    continue;
  }

  const b64 = fs.readFileSync(imgPath).toString('base64');
  const dataUri = 'data:image/png;base64,' + b64;

  const srcOld = `src="screenshots/${file}"`;
  const srcNew = `src="${dataUri}"`;
  if (html.includes(srcOld)) {
    html = html.split(srcOld).join(srcNew);
    embedded++;
    console.log(`  \u2713 ${file} (${Math.round(b64.length / 1024)}KB)`);
  } else {
    console.log(`  SKIP ${file} (no src to replace)`);
  }

  const hrefOld = `href="screenshots/${file}"`;
  const hrefNew = `href="${dataUri}"`;
  html = html.split(hrefOld).join(hrefNew);
}

fs.writeFileSync(HTML_PATH, html);
const sizeMB = (fs.statSync(HTML_PATH).size / (1024 * 1024)).toFixed(1);
console.log(`\n  Done: ${embedded} screenshots embedded. HTML size: ${sizeMB}MB`);
