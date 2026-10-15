const tail = (text, max) => {
  if (typeof text !== 'string') return text ?? null;
  return text.length > max ? `…${text.slice(-max)}` : text;
};
const head = (text, max) => {
  if (typeof text !== 'string') return text ?? null;
  return text.length > max ? `${text.slice(0, max)}…` : text;
};

/** Turn a Codex ThreadItem into the compact record the console stores and renders. */
export function normalizeItem(item) {
  const base = { id: item.id, type: item.type };
  switch (item.type) {
    case 'userMessage': {
      const content = item.content || [];
      return {
        ...base,
        text: content.filter((c) => c.type === 'text').map((c) => c.text).join('\n'),
        skills: content.filter((c) => c.type === 'skill').map((c) => ({ name: c.name, path: c.path })),
      };
    }
    case 'agentMessage':
      return { ...base, text: item.text || '', phase: item.phase || null };
    case 'reasoning':
      return { ...base, summary: head((item.summary || []).join('\n'), 2000) };
    case 'plan':
      return { ...base, text: head(item.text, 2000) };
    case 'commandExecution':
      return {
        ...base,
        command: item.command,
        cwd: item.cwd,
        status: item.status,
        exitCode: item.exitCode ?? null,
        durationMs: item.durationMs ?? null,
        actions: (item.commandActions || []).map((a) => a.type),
        output: tail(item.aggregatedOutput, 4000),
      };
    case 'fileChange':
      return {
        ...base,
        status: item.status,
        changes: (item.changes || []).map((c) => ({ path: c.path, kind: c.kind?.type || c.kind, diff: head(c.diff, 3000) })),
      };
    case 'mcpToolCall':
      return { ...base, server: item.server, tool: item.tool, status: item.status, error: item.error?.message ?? null, durationMs: item.durationMs ?? null };
    case 'dynamicToolCall':
      return { ...base, tool: item.tool, namespace: item.namespace, status: item.status, success: item.success ?? null };
    case 'webSearch':
      return { ...base, query: item.query };
    case 'collabAgentToolCall':
      return { ...base, tool: item.tool, status: item.status, receivers: item.receiverThreadIds || [] };
    case 'imageGeneration':
      return { ...base, status: item.status, savedPath: item.savedPath ?? null };
    default:
      return base;
  }
}

export const ACTION_TYPES = new Set(['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'webSearch', 'imageGeneration', 'collabAgentToolCall']);

export function finalAnswer(items) {
  const messages = items.filter((i) => i.type === 'agentMessage' && i.text);
  return (messages.findLast((i) => i.phase === 'final_answer') || messages.at(-1))?.text ?? '';
}

const USAGE_KEYS = ['inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningOutputTokens', 'totalTokens'];

export function addUsage(acc, last) {
  const out = { ...(acc || Object.fromEntries(USAGE_KEYS.map((k) => [k, 0]))) };
  for (const key of USAGE_KEYS) out[key] += Number(last?.[key] || 0);
  return out;
}
