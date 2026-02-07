/**
 * @fileoverview `wunderland chat` — interactive terminal assistant with tool calling.
 * Ported from bin/wunderland.js cmdChat() with colored output.
 * @module wunderland/cli/commands/chat
 */

import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import * as path from 'node:path';
import os from 'node:os';
import type { GlobalFlags } from '../types.js';
import { accent, success as sColor, warn as wColor, tool as tColor, muted, dim } from '../ui/theme.js';
import * as fmt from '../ui/format.js';
import { loadDotEnvIntoProcess } from '../config/env-manager.js';
import { SkillRegistry } from '../../skills/index.js';

// ── OpenAI helpers ──────────────────────────────────────────────────────────

interface ToolCallMessage {
  role: string;
  content: string | null;
  tool_calls?: Array<{
    id: string;
    function: { name: string; arguments: string };
  }>;
}

function truncateString(value: unknown, maxLen: number): string {
  const s = typeof value === 'string' ? value : String(value ?? '');
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen) + `\n...[truncated ${s.length - maxLen} chars]`;
}

function safeJsonStringify(value: unknown, maxLen: number): string {
  try {
    const json = JSON.stringify(value, null, 2);
    return truncateString(json, maxLen);
  } catch {
    return truncateString(value, maxLen);
  }
}

function redactToolOutputForLLM(output: Record<string, unknown>): Record<string, unknown> {
  if (!output || typeof output !== 'object') return output;
  const out = Array.isArray(output) ? output.slice(0, 50) : { ...output };
  for (const key of ['stdout', 'stderr', 'content', 'html', 'text'] as const) {
    if (typeof (out as Record<string, unknown>)[key] === 'string') {
      (out as Record<string, unknown>)[key] = truncateString((out as Record<string, unknown>)[key], 12000);
    }
  }
  return out as Record<string, unknown>;
}

async function openaiChatWithTools(opts: {
  apiKey: string;
  model: string;
  messages: Array<Record<string, unknown>>;
  tools: Array<Record<string, unknown>>;
  temperature: number;
  maxTokens: number;
}): Promise<{ message: ToolCallMessage; model: string; usage: unknown }> {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: opts.model,
      messages: opts.messages,
      tools: opts.tools.length > 0 ? opts.tools : undefined,
      tool_choice: opts.tools.length > 0 ? 'auto' : undefined,
      temperature: opts.temperature,
      max_tokens: opts.maxTokens,
    }),
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`OpenAI error (${res.status}): ${text.slice(0, 300)}`);
  const data = JSON.parse(text);
  const msg = data?.choices?.[0]?.message;
  if (!msg) throw new Error('OpenAI returned an empty response.');
  return { message: msg, model: data?.model || opts.model, usage: data?.usage };
}

interface ToolInstance {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  hasSideEffects?: boolean;
  execute: (args: Record<string, unknown>, ctx: Record<string, unknown>) => Promise<{ success: boolean; output?: unknown; error?: string }>;
}

async function runToolCallingTurn(opts: {
  apiKey: string;
  model: string;
  messages: Array<Record<string, unknown>>;
  toolMap: Map<string, ToolInstance>;
  toolDefs: Array<Record<string, unknown>>;
  toolContext: Record<string, unknown>;
  maxRounds: number;
  dangerouslySkipPermissions: boolean;
  askPermission: (tool: ToolInstance, args: Record<string, unknown>) => Promise<boolean>;
}): Promise<string> {
  const rounds = opts.maxRounds > 0 ? opts.maxRounds : 8;

  for (let round = 0; round < rounds; round += 1) {
    const { message } = await openaiChatWithTools({
      apiKey: opts.apiKey,
      model: opts.model,
      messages: opts.messages,
      tools: opts.toolDefs,
      temperature: 0.2,
      maxTokens: 1400,
    });

    const toolCalls = message.tool_calls || [];

    if (toolCalls.length === 0) {
      const content = typeof message.content === 'string' ? message.content.trim() : '';
      opts.messages.push({ role: 'assistant', content: content || '(no content)' });
      return content || '';
    }

    opts.messages.push({
      role: 'assistant',
      content: typeof message.content === 'string' ? message.content : null,
      tool_calls: toolCalls,
    });

    for (const call of toolCalls) {
      const toolName = call?.function?.name;
      const rawArgs = call?.function?.arguments;

      if (!toolName || typeof rawArgs !== 'string') {
        opts.messages.push({ role: 'tool', tool_call_id: call?.id, content: JSON.stringify({ error: 'Malformed tool call.' }) });
        continue;
      }

      const tool = opts.toolMap.get(toolName);
      if (!tool) {
        opts.messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ error: `Tool not found: ${toolName}` }) });
        continue;
      }

      let args: Record<string, unknown>;
      try {
        args = JSON.parse(rawArgs);
      } catch {
        opts.messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ error: `Invalid JSON arguments for ${toolName}` }) });
        continue;
      }

      console.log(`  ${tColor('\u25B6')} ${tColor(toolName)} ${dim(truncateString(JSON.stringify(args), 120))}`);

      if (tool.hasSideEffects && !opts.dangerouslySkipPermissions) {
        const ok = await opts.askPermission(tool, args);
        if (!ok) {
          opts.messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ error: `Permission denied for tool: ${toolName}` }) });
          continue;
        }
      }

      let result: { success: boolean; output?: unknown; error?: string };
      try {
        result = await tool.execute(args, opts.toolContext);
      } catch (err) {
        opts.messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify({ error: `Tool threw: ${err instanceof Error ? err.message : String(err)}` }),
        });
        continue;
      }

      const payload = result?.success ? redactToolOutputForLLM(result.output as Record<string, unknown>) : { error: result?.error || 'Tool failed' };
      opts.messages.push({ role: 'tool', tool_call_id: call.id, content: safeJsonStringify(payload, 20000) });
    }
  }

  return '';
}

// ── Skills resolver ─────────────────────────────────────────────────────────

function resolveSkillsDirs(flags: Record<string, string | boolean>): string[] {
  const dirs: string[] = [];
  const skillsDirFlag = flags['skills-dir'];
  if (typeof skillsDirFlag === 'string' && skillsDirFlag.trim()) {
    for (const part of skillsDirFlag.split(',')) {
      const p = part.trim();
      if (p) dirs.push(path.resolve(process.cwd(), p));
    }
  }
  const codexHome = typeof process.env['CODEX_HOME'] === 'string' ? process.env['CODEX_HOME'].trim() : '';
  if (codexHome) dirs.push(path.join(codexHome, 'skills'));
  dirs.push(path.join(os.homedir(), '.codex', 'skills'));
  dirs.push(path.join(process.cwd(), 'skills'));

  const seen = new Set<string>();
  return dirs.filter((d) => {
    if (!d) return false;
    const key = path.resolve(d);
    if (seen.has(key)) return false;
    seen.add(key);
    return existsSync(key);
  });
}

// ── Command ─────────────────────────────────────────────────────────────────

export default async function cmdChat(
  _args: string[],
  flags: Record<string, string | boolean>,
  _globals: GlobalFlags,
): Promise<void> {
  await loadDotEnvIntoProcess(
    path.resolve(process.cwd(), '.env'),
    path.resolve(process.cwd(), '.env.local'),
  );

  const apiKey = process.env['OPENAI_API_KEY'] || '';
  if (!apiKey) {
    fmt.errorBlock('Missing API key', 'OPENAI_API_KEY is required for `wunderland chat`.');
    process.exitCode = 1;
    return;
  }

  const model = typeof flags['model'] === 'string' ? flags['model'] : (process.env['OPENAI_MODEL'] || 'gpt-4o-mini');
  const dangerouslySkipPermissions = flags['dangerously-skip-permissions'] === true;
  const enableSkills = flags['no-skills'] !== true;

  // Load tools from curated extensions
  const [cliExecutor, webSearch, webBrowser] = await Promise.all([
    import('@framers/agentos-ext-cli-executor'),
    import('@framers/agentos-ext-web-search'),
    import('@framers/agentos-ext-web-browser'),
  ]);

  const packs = [
    cliExecutor.createExtensionPack({ options: { workingDirectory: process.cwd() }, logger: console }),
    webSearch.createExtensionPack({
      options: {
        serperApiKey: process.env['SERPER_API_KEY'],
        serpApiKey: process.env['SERPAPI_API_KEY'],
        braveApiKey: process.env['BRAVE_API_KEY'],
      },
      logger: console,
    }),
    webBrowser.createExtensionPack({ options: { headless: true }, logger: console }),
  ];

  const tools: ToolInstance[] = packs
    .flatMap((p) => (p?.descriptors || []).filter((d: { kind: string }) => d?.kind === 'tool').map((d: { payload: unknown }) => d.payload))
    .filter(Boolean) as ToolInstance[];

  const toolMap = new Map<string, ToolInstance>();
  for (const tool of tools) {
    if (!tool?.name) continue;
    toolMap.set(tool.name, tool);
  }

  const toolDefs = [...toolMap.values()].map((tool) => ({
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
  }));

  // Skills
  let skillsPrompt = '';
  if (enableSkills) {
    const skillRegistry = new SkillRegistry();
    const dirs = resolveSkillsDirs(flags);
    if (dirs.length > 0) {
      await skillRegistry.loadFromDirs(dirs);
      const snapshot = skillRegistry.buildSnapshot({ platform: process.platform });
      skillsPrompt = snapshot.prompt || '';
    }
  }

  const systemPrompt = [
    'You are Wunderland CLI, an interactive terminal assistant.',
    'You can use tools to read/write files, run shell commands, and browse the web.',
    'When you need up-to-date information, use web_search and/or browser_* tools.',
    'Tool calls that have side effects may require user approval.',
    skillsPrompt || '',
  ].filter(Boolean).join('\n\n');

  const sessionId = `wunderland-cli-${Date.now()}`;
  const toolContext = { gmiId: sessionId, personaId: sessionId, userContext: { userId: process.env['USER'] || 'local-user' } };

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const messages: Array<Record<string, unknown>> = [{ role: 'system', content: systemPrompt }];

  fmt.section('Interactive Chat');
  fmt.kvPair('Model', accent(model));
  fmt.kvPair('Tools', `${toolDefs.length} loaded`);
  fmt.kvPair('Skills', enableSkills ? sColor('on') : muted('off'));
  fmt.blank();
  fmt.note(`Type ${accent('/help')} for commands, ${accent('/exit')} to quit`);
  fmt.blank();

  const askPermission = async (tool: ToolInstance, args: Record<string, unknown>): Promise<boolean> => {
    const preview = safeJsonStringify(args, 800);
    const q = `  ${wColor('\u26A0')} Allow ${tColor(tool.name)} (side effects)?\n${dim(preview)}\n  ${muted('[y/N]')} `;
    const answer = (await rl.question(q)).trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
  };

  for (;;) {
    const line = await rl.question(`  ${accent('\u276F')} `);
    const input = (line || '').trim();
    if (!input) continue;

    if (input === '/exit' || input === 'exit' || input === 'quit') break;

    if (input === '/help') {
      fmt.blank();
      fmt.note(`${accent('/help')}    Show this help`);
      fmt.note(`${accent('/tools')}   List available tools`);
      fmt.note(`${accent('/exit')}    Quit`);
      fmt.blank();
      continue;
    }

    if (input === '/tools') {
      const names = [...toolMap.keys()].sort();
      fmt.blank();
      for (const n of names) fmt.toolName(n);
      fmt.blank();
      continue;
    }

    messages.push({ role: 'user', content: input });

    const reply = await runToolCallingTurn({
      apiKey,
      model,
      messages,
      toolMap,
      toolDefs,
      toolContext,
      maxRounds: 8,
      dangerouslySkipPermissions,
      askPermission,
    });

    if (reply) {
      console.log();
      console.log(`  ${reply}`);
      console.log();
    }
  }

  rl.close();
  fmt.blank();
  fmt.ok('Session ended.');
  fmt.blank();
}
