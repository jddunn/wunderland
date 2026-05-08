/**
 * @file empty-output-fallback.ts
 * @description Synthesise a fallback string from captured tool activity when
 * a GMI node's ReAct loop returns no text. Mirrors the agentos
 * NodeExecutor.executeGmi fallback so wunderland missions don't propagate
 * empty outputs to downstream nodes when the LLM exhausts its iteration
 * budget on tool calls or when every tool errors out.
 *
 * Pure function — caller (WunderlandNodeExecutor) collects tool activity
 * via runToolCallingTurn's onToolCall/onToolResult callbacks and passes
 * the captured arrays in.
 */

const PER_RESULT_CAP = 4000;
const PER_ERROR_CAP = 1000;
const TOTAL_FALLBACK_CAP = 16000;

export interface EmptyOutputFallbackInput {
  /** Successful tool results: `{ name, content }`. Content is a serialised string. */
  results: Array<{ name: string; content: string }>;
  /** Failed tool calls: `{ name, error }`. Error is a human-readable message. */
  errors: Array<{ name: string; error: string }>;
  /** True when the ReAct loop exhausted maxIterations without natural termination. */
  iterationsExhausted: boolean;
}

/**
 * Strip markdown-breaking characters from a tool name and cap its length.
 * Tool names come from a registry but third-party extensions can register
 * names with newlines or backticks — sanitising defensively keeps a
 * malformed name from breaking either the conversation context or the
 * mission report rendering.
 */
function safeToolName(raw: string): string {
  return String(raw).replace(/[`\r\n]+/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, 80) || 'unnamed-tool';
}

/**
 * Build a bounded synthesis string from captured tool activity. Returns the
 * empty string when nothing useful happened, signalling to the caller that
 * the loop produced neither text nor tool activity (so the original empty
 * reply propagates as-is).
 */
export function synthesizeEmptyOutputFallback(input: EmptyOutputFallbackInput): string {
  const { results, errors, iterationsExhausted } = input;
  if (results.length === 0 && errors.length === 0) return '';

  const header = iterationsExhausted
    ? '[max_iterations_reached before final summary; surfacing raw tool activity]'
    : '[no text response from model; surfacing raw tool activity]';

  const lines: string[] = [header, ''];
  // Track running length manually so each chunk insertion is O(chunk),
  // and so partial chunks are never appended (a chunk is all-or-nothing
  // to avoid orphaned `Tool: X` headers without their content).
  let currentLength = lines.join('\n').length;
  let truncated = false;

  const pushChunk = (chunk: string[]): boolean => {
    const chunkLength = chunk.reduce((sum, line) => sum + line.length + 1, 0);
    if (currentLength + chunkLength > TOTAL_FALLBACK_CAP) {
      truncated = true;
      return false;
    }
    lines.push(...chunk);
    currentLength += chunkLength;
    return true;
  };

  for (const r of results) {
    const content = r.content.length > PER_RESULT_CAP ? r.content.slice(0, PER_RESULT_CAP) : r.content;
    if (!pushChunk([`Tool: ${safeToolName(r.name)}`, 'Result:', content, ''])) break;
  }
  // Always attempt errors — even if results already filled the buffer.
  // pushChunk returns false on overflow, so any errors that fit get
  // appended (errors are short — PER_ERROR_CAP=1KB vs results 4KB — so a
  // few usually fit even after a large result block). The truncation
  // marker still fires once the cap is hit.
  for (const e of errors) {
    const errMsg = e.error.length > PER_ERROR_CAP ? e.error.slice(0, PER_ERROR_CAP) : e.error;
    if (!pushChunk([`Tool: ${safeToolName(e.name)}`, `Error: ${errMsg}`, ''])) break;
  }
  if (truncated) lines.push('[fallback truncated]');

  return lines.join('\n').trimEnd();
}
