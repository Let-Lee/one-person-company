// Host adapters supply native tool results. HTTP callers cannot inject a source identity.
export class NativeRouteError extends Error {
  constructor(status, message, details) { super(message); this.status = status; this.details = details; }
}

export function nativeBridgeReady(bridge) {
  return ['verifyBinding', 'readInbound', 'authorizeTask', 'sendMessage'].every((method) => typeof bridge?.[method] === 'function');
}

export function verifyNativeBinding(binding, sourceThreadId, managerThreadId) {
  if (binding?.channel !== 'codex_app' || binding.sourceThreadId !== sourceThreadId || binding.managerThreadId !== managerThreadId || !binding.evidenceId) {
    throw new NativeRouteError(403, '原生通道未证明当前执行源属于登记岗位，不能接管', { sourceThreadId, managerThreadId });
  }
  return { channel: binding.channel, sourceThreadId, managerThreadId, evidenceId: binding.evidenceId };
}

/** Accept only a direct native tool output; quoted or nested declarations carry no authority. */
export function verifyNativeInbound(snapshot, { threadId, managerThreadId, messageId }) {
  if (snapshot?.channel !== 'codex_app.read_thread' || snapshot.threadId !== threadId || snapshot.request?.threadId !== threadId || snapshot.request?.includeOutputs !== true) {
    throw new NativeRouteError(403, '缺少对应岗位的完整原生入站');
  }
  const item = snapshot.messages?.find((m) => m.inboundMessageId === messageId);
  if (!item || item.nativeOutputTruncated || item.nativeItemNamespace !== 'codex_app' || item.nativeItemName !== 'send_message_to_thread') {
    throw new NativeRouteError(403, '入站缺失、截断或不是原生派单输出');
  }
  const match = String(item.nativeOutput || '').match(/^\s*<codex_delegation>\s*<source_thread_id>([^<>]+)<\/source_thread_id>\s*<input>([\s\S]*)<\/input>\s*<\/codex_delegation>\s*$/);
  if (!match || match[1] !== managerThreadId) throw new NativeRouteError(403, '派单真实来源不是唯一总经理');
  return { channel: snapshot.channel, inboundMessageId: messageId, sourceTurnId: item.sourceTurnId, sourceThreadId: match[1], recipientThreadId: threadId, prompt: match[2] };
}

export function verifyNativeSubmission(result, { sourceThreadId, recipientThreadId, prompt, operationKey }) {
  if (result?.channel !== 'codex_app.send_message_to_thread' || result.sourceThreadId !== sourceThreadId || result.request?.threadId !== recipientThreadId || result.request?.prompt !== prompt || result.operationKey !== operationKey) {
    throw new NativeRouteError(502, '原生发送返回的源、目标或原文不匹配，不能登记为已提交');
  }
  const output = result.toolResult;
  if (!output || output.isError) throw new NativeRouteError(502, '原生回传失败', output);
  let delivered;
  try { delivered = JSON.parse(output.content?.find((x) => x.type === 'text')?.text || '{}'); } catch { /* unverified result */ }
  if (delivered?.threadId !== recipientThreadId) throw new NativeRouteError(502, '原生工具没有返回对应接收聊天');
  return { ...result, submissionVerified: true, recipientExecutionVerified: false };
}
