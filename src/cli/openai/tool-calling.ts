/**
 * @fileoverview OpenAI tool-calling loop helpers used by Wunderland CLI commands.
 * @module wunderland/cli/openai/tool-calling
 */

export interface ToolCallMessage {
  role: string;
  content: string | null;
  tool_calls?: Array<{
    id: string;
    function: { name: string; arguments: string };
  }>;
}

export interface ToolInstance {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  hasSideEffects?: boolean;
  execute: (args: Record<string, unknown>, ctx: Record<string, unknown>) => Promise<{ success: boolean; output?: unknown; error?: string }>;
}

export function truncateString(value: unknown, maxLen: number): string {
  const s = typeof value === 'string' ? value : String(value ?? '');
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen) + `\n...[truncated ${s.length - maxLen} chars]`;
}

export function safeJsonStringify(value: unknown, maxLen: number): string {
  try {
    const json = JSON.stringify(value, null, 2);
    return truncateString(json, maxLen);
  } catch {
    return truncateString(value, maxLen);
  }
}

export function redactToolOutputForLLM(output: unknown): unknown {
  if (!output || typeof output !== 'object') return output;

  // Shallow clone; avoid pulling huge nested structures into the prompt.
  const out: any = Array.isArray(output) ? output.slice(0, 50) : { ...(output as any) };

  for (const key of ['stdout', 'stderr', 'content', 'html', 'text'] as const) {
    if (typeof out?.[key] === 'string') {
      out[key] = truncateString(out[key], 12000);
    }
  }

  return out;
}

export async function openaiChatWithTools(opts: {
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

export async function runToolCallingTurn(opts: {
  apiKey: string;
  model: string;
  messages: Array<Record<string, unknown>>;
  toolMap: Map<string, ToolInstance>;
  toolDefs: Array<Record<string, unknown>>;
  toolContext: Record<string, unknown>;
  maxRounds: number;
  dangerouslySkipPermissions: boolean;
  askPermission: (tool: ToolInstance, args: Record<string, unknown>) => Promise<boolean>;
  onToolCall?: (tool: ToolInstance, args: Record<string, unknown>) => void;
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

      if (opts.onToolCall) {
        try {
          opts.onToolCall(tool, args);
        } catch {
          // ignore logging hook errors
        }
      }

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

      const payload = result?.success ? redactToolOutputForLLM(result.output) : { error: result?.error || 'Tool failed' };
      opts.messages.push({ role: 'tool', tool_call_id: call.id, content: safeJsonStringify(payload, 20000) });
    }
  }

  return '';
}
