/**
 * @fileoverview Chat UI rendering helpers — frame drawing, header printing,
 * assistant reply formatting, prompt styling.
 * Extracted from chat.ts for readability.
 */

import chalk from 'chalk';
import {
  HEX,
  accent,
  success as sColor,
  warn as wColor,
  dim,
} from '../ui/theme.js';
import { visibleLength } from '../ui/ansi-utils.js';
import { glyphs } from '../ui/glyphs.js';
import { getUiRuntime } from '../ui/runtime.js';
import type { ToolInstance } from '../../runtime/tool-calling.js';

// ── Chat Frame Palette (mirrors dashboard.ts) ──────────────────────────────

export const C = HEX;

export const frameBorder = chalk.hex(C.cyan);
const accentBorder = chalk.hex(C.lavender);

export function chatFrameGlyphs(): {
  tl: string;
  tr: string;
  bl: string;
  br: string;
  h: string;
  v: string;
} {
  const ui = getUiRuntime();
  if (ui.ascii) return { tl: '+', tr: '+', bl: '+', br: '+', h: '-', v: '|' };
  return { tl: '╔', tr: '╗', bl: '╚', br: '╝', h: '═', v: '║' };
}

/** Get terminal width, floored at 60. */
export function getChatWidth(): number {
  return Math.max((process.stdout.columns || 80) - 4, 60);
}

/** Frame a content line inside ║ ... ║ borders. */
export function frameLine(content: string, innerWidth: number): string {
  const frame = chatFrameGlyphs();
  const vLen = visibleLength(content);
  const pad = Math.max(0, innerWidth - vLen);
  return `  ${frameBorder(frame.v)}${content}${' '.repeat(pad)}${frameBorder(frame.v)}`;
}

/** Print the framed chat startup header. */
export function printChatHeader(info: {
  agentName: string;
  provider: string;
  model: string;
  tools: number;
  skills: boolean;
  fallback: boolean;
  lazyTools: boolean;
  autoApprove: boolean;
  turnApproval: string;
  securityTier: string;
  toolProfile: string;
  cliExecution: boolean;
}): void {
  const contentWidth = getChatWidth();
  const innerWidth = contentWidth - 2;

  const frame = chatFrameGlyphs();
  const topBorder = `  ${frameBorder(frame.tl)}${frameBorder(frame.h.repeat(innerWidth))}${frameBorder(frame.tr)}`;
  const botBorder = `  ${frameBorder(frame.bl)}${frameBorder(frame.h.repeat(innerWidth))}${frameBorder(frame.br)}`;
  const empty = frameLine(' '.repeat(innerWidth), innerWidth);

  // Title
  const titleText = chalk.hex(C.magenta).bold('INTERACTIVE CHAT');
  const titleVis = 16; // "INTERACTIVE CHAT"
  const titlePadL = Math.max(0, Math.floor((innerWidth - titleVis) / 2));

  // Divider
  const divDeco = ` ${chalk.hex(C.magenta)('<>')} `;
  const divDecoVis = 4;
  const divHalfL = Math.max(0, Math.floor((innerWidth - divDecoVis) / 2));
  const divHalfR = Math.max(0, innerWidth - divDecoVis - divHalfL);
  const g = glyphs();
  const divContent =
    accentBorder(g.hr.repeat(divHalfL)) + divDeco + accentBorder(g.hr.repeat(divHalfR));

  // Key-value pairs
  const kvLine = (label: string, value: string): string => {
    const kvContent = `   ${chalk.hex(C.brightCyan)(g.bullet)} ${chalk.hex(C.muted)(label.padEnd(18))} ${value}`;
    return frameLine(kvContent, innerWidth);
  };

  const lines: string[] = [];
  lines.push(topBorder);
  lines.push(empty);
  lines.push(frameLine(`${' '.repeat(titlePadL)}${titleText}`, innerWidth));
  lines.push(empty);
  lines.push(frameLine(divContent, innerWidth));
  lines.push(empty);
  lines.push(kvLine('Agent', accent(info.agentName)));
  lines.push(kvLine('Provider', chalk.hex(C.cyan)(info.provider)));
  lines.push(kvLine('Model', chalk.hex(C.cyan)(info.model)));
  lines.push(kvLine('Tools', `${info.tools} loaded`));
  lines.push(kvLine('Skills', info.skills ? sColor('on') : chalk.hex(C.muted)('off')));
  if (info.fallback) lines.push(kvLine('Fallback', sColor('OpenRouter (auto)')));
  lines.push(kvLine('Lazy Tools', info.lazyTools ? sColor('on') : chalk.hex(C.muted)('off')));
  lines.push(
    kvLine(
      'Authorization',
      info.autoApprove ? wColor('fully autonomous') : sColor('tiered (Tier 1/2/3)')
    )
  );
  lines.push(kvLine('Security Tier', accent(info.securityTier)));
  lines.push(kvLine('Tool Profile', accent(info.toolProfile)));
  lines.push(kvLine('CLI Execution', info.cliExecution ? wColor('enabled') : dim('disabled')));
  if (info.turnApproval !== 'off')
    lines.push(kvLine('Turn Checkpoints', sColor(info.turnApproval)));
  lines.push(empty);

  // Help hint
  const helpHint = `   Type ${chalk.hex(C.cyan)('/help')} for commands, ${chalk.hex(C.cyan)('/exit')} to quit`;
  lines.push(frameLine(helpHint, innerWidth));
  const restrictHint = `   ${dim('Restrict: --security-tier=balanced  |  --profile=assistant')}`;
  lines.push(frameLine(restrictHint, innerWidth));
  lines.push(empty);
  lines.push(botBorder);
  lines.push('');

  console.log(lines.join('\n'));
}

/** Print a framed assistant response. */
export function printAssistantReply(text: string): void {
  const g = glyphs();
  const contentWidth = getChatWidth();
  const innerWidth = contentWidth - 2;
  const maxTextWidth = innerWidth - 6; // 3 indent + 3 margin

  // Word-wrap the reply text
  const wrappedLines: string[] = [];
  for (const paragraph of text.split('\n')) {
    if (paragraph.trim() === '') {
      wrappedLines.push('');
      continue;
    }
    const words = paragraph.split(/\s+/);
    let current = '';
    for (const word of words) {
      if (current.length + word.length + 1 > maxTextWidth && current.length > 0) {
        wrappedLines.push(current);
        current = word;
      } else {
        current = current ? `${current} ${word}` : word;
      }
    }
    if (current) wrappedLines.push(current);
  }

  const topLine = `  ${accentBorder(g.box.tl)}${accentBorder(g.box.h.repeat(innerWidth - 2))}${accentBorder(g.box.tr)}`;
  const botLine = `  ${accentBorder(g.box.bl)}${accentBorder(g.box.h.repeat(innerWidth - 2))}${accentBorder(g.box.br)}`;
  const replyFrame = (content: string): string => {
    const vLen = visibleLength(content);
    const pad = Math.max(0, innerWidth - 2 - vLen);
    return `  ${accentBorder(g.box.v)}${content}${' '.repeat(pad)}${accentBorder(g.box.v)}`;
  };
  const emptyReply = replyFrame(' '.repeat(innerWidth - 2));

  const lines: string[] = [];
  lines.push('');
  lines.push(topLine);
  lines.push(emptyReply);
  for (const wl of wrappedLines) {
    lines.push(replyFrame(`   ${chalk.hex(C.text)(wl)}`));
  }
  lines.push(emptyReply);
  lines.push(botLine);
  lines.push('');

  console.log(lines.join('\n'));
}

/** Styled chat prompt string. */
export function chatPrompt(): string {
  const frame = chatFrameGlyphs();
  const g = glyphs();
  return `  ${frameBorder(frame.v)} ${chalk.hex(C.brightCyan)(g.cursor)} `;
}

export function toToolInstance(tool: {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  hasSideEffects?: boolean;
  category?: string;
  requiredCapabilities?: string[];
  execute: (...args: any[]) => any;
}): ToolInstance {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema as any,
    hasSideEffects: tool.hasSideEffects === true,
    category:
      typeof tool.category === 'string' && tool.category.trim() ? tool.category : 'productivity',
    requiredCapabilities: tool.requiredCapabilities,
    execute: tool.execute as any,
  };
}

