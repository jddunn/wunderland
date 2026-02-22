#!/usr/bin/env node
/**
 * Add export-hint divs to all cmd-body sections that don't already have a screenshot.
 * Extracts the command from the cmd-invocation div and adds a styled hint.
 */
const fs = require('fs');
const path = require('path');

const HTML_PATH = path.join(__dirname, '..', 'cli-reference.html');
let html = fs.readFileSync(HTML_PATH, 'utf8');

// Remove any existing export hints (idempotent)
html = html.replace(/<div class="cmd-export-hint">[\s\S]*?<\/div>\n?/g, '');

// Find all cmd-body sections
// Pattern: <div class="cmd-body">
// followed by <div class="cmd-invocation">COMMAND</div>
// If NOT followed by <div class="cmd-screenshot-wrap" before the next </div> of cmd-body
// then inject an export hint after the cmd-invocation

let count = 0;
const bodyRegex = /<div class="cmd-body">\s*\n?\s*<div class="cmd-invocation">(.*?)<\/div>/g;

const parts = [];
let lastIndex = 0;
let match;

while ((match = bodyRegex.exec(html)) !== null) {
  const fullMatch = match[0];
  const command = match[1];
  const matchEnd = match.index + fullMatch.length;

  // Look ahead 200 chars to see if there's already a screenshot wrap
  const lookAhead = html.substring(matchEnd, matchEnd + 300);
  const hasScreenshot = lookAhead.includes('cmd-screenshot-wrap');

  if (!hasScreenshot) {
    // Check if this command supports --export-png (exclude interactive ones)
    const interactive = ['setup', 'init', 'create', 'start', 'chat', 'ollama-setup'].some(
      cmd => command.startsWith('wunderland ' + cmd)
    );

    // Add export hint after cmd-invocation
    parts.push(html.substring(lastIndex, matchEnd));

    if (interactive) {
      parts.push(`\n  <div class="cmd-export-hint cmd-export-hint-interactive"><span class="export-hint-icon">\u26A1</span> Interactive command \u2014 run in terminal</div>`);
    } else {
      const escaped = command.replace(/</g, '&lt;').replace(/>/g, '&gt;');
      parts.push(`\n  <div class="cmd-export-hint"><span class="export-hint-icon">\u{1F4F8}</span> Export: <code>${escaped} --export-png output.png</code></div>`);
    }
    count++;
    lastIndex = matchEnd;
  }
}

// Append remaining
parts.push(html.substring(lastIndex));
html = parts.join('');

fs.writeFileSync(HTML_PATH, html);
console.log(`  Added ${count} export hints to cmd-body sections without screenshots.`);
