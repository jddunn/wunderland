#!/usr/bin/env node
/**
 * Inject CSS for .cmd-export-hint into cli-reference.html.
 */
const fs = require('fs');
const path = require('path');

const HTML_PATH = path.join(__dirname, '..', 'cli-reference.html');
let html = fs.readFileSync(HTML_PATH, 'utf8');

// Remove old export hint CSS if present (idempotent)
html = html.replace(/\s*\/\* Export hint for sections without screenshots \*\/[\s\S]*?\.export-hint-icon\s*\{[^}]*\}\n*/g, '');

const CSS_BLOCK = `
  /* Export hint for sections without screenshots */
  .cmd-export-hint {
    padding: 0.6rem 1rem;
    background: rgba(6,182,212,0.04);
    border-bottom: 1px solid var(--border);
    font-size: 0.75rem;
    font-family: 'SF Mono', 'Fira Code', monospace;
    color: var(--text-dim);
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .cmd-export-hint code {
    background: var(--surface);
    padding: 0.15rem 0.5rem;
    border-radius: 3px;
    font-size: 0.72rem;
    color: var(--cyan);
    border: 1px solid var(--border);
  }
  .cmd-export-hint-interactive {
    background: rgba(245,158,11,0.04);
    color: var(--gold, #f59e0b);
  }
  .export-hint-icon {
    font-size: 0.85rem;
  }
`;

// Insert before "/* Text output details toggle */"
const anchor = '  /* Text output details toggle */';
if (html.includes(anchor)) {
  html = html.replace(anchor, CSS_BLOCK + '\n' + anchor);
  fs.writeFileSync(HTML_PATH, html);
  console.log('  Injected .cmd-export-hint CSS styles.');
} else {
  console.log('  ERROR: Could not find anchor comment for CSS injection.');
  process.exitCode = 1;
}
