import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const TASK_RE = /^T\d{8}-\d{3}$/;
export const bodyHash = (text) => crypto.createHash('sha256').update(String(text).trim()).digest('hex');
export const taskIdsIn = (text) => [...new Set(String(text).match(/\bT\d{8}-\d{3}\b/g) || [])];
const decode = (text) => text.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, (_, key) => {
  const named = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
  if (named[key]) return named[key];
  const code = key[1]?.toLowerCase() === 'x' ? parseInt(key.slice(2), 16) : Number(key.slice(1));
  return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '\ufffd';
});

/** Accept the direct native output only. Quoted, nested, user and model text are never an identity. */
export function nativeInbound(item) {
  if (item?.type !== 'functionCallOutput' || item.namespace !== 'codex_app' || item.name !== 'send_message_to_thread') return null;
  const output = item.output;
  if (output?.truncated) return null;
  const raw = typeof output === 'string' ? output : output?.text;
  if (typeof raw !== 'string') return null;
  const match = raw.match(/^\s*<codex_delegation>\s*<source_thread_id>([^<]+)<\/source_thread_id>\s*<input>([\s\S]*)<\/input>\s*<\/codex_delegation>\s*$/);
  if (!match || !item.id) return null;
  return { itemId: item.id, sourceThreadId: decode(match[1]).trim(), text: decode(match[2]).trim() };
}

export function submittedTarget(result) {
  if (!result || result.isError === true) return null;
  const targets = (result.content || []).filter((c) => c.type === 'text').flatMap((c) => {
    try { const value = JSON.parse(c.text); return typeof value.threadId === 'string' ? [value.threadId] : []; } catch { return []; }
  });
  return targets.length === 1 ? targets[0] : null;
}

/** Read only a regular, bounded file inside the authorized company tree. No arbitrary public path input. */
export function safeFile(root, file, { json = true } = {}) {
  const full = path.resolve(root, file);
  const parent = fs.realpathSync(root);
  const stat = fs.lstatSync(full);
  const real = fs.realpathSync(full);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 8_000_000 || !real.startsWith(parent + path.sep)) throw Error('协作凭据路径无效');
  return json ? JSON.parse(fs.readFileSync(real, 'utf8')) : real;
}

function nativeDocument(value) {
  if (value?.isError) return null;
  if (value?.channel === 'codex_app.read_thread' && Array.isArray(value.messages)) return value;
  if (value?.thread?.id && Array.isArray(value.turns)) return value;
  for (const block of value?.content || []) {
    if (block.type !== 'text') continue;
    try { const parsed = JSON.parse(block.text); if (parsed.thread?.id && Array.isArray(parsed.turns)) return parsed; } catch { /* unrelated text */ }
  }
  return null;
}

export function snapshotInbounds(value, threadId) {
  const doc = nativeDocument(value);
  if (!doc || (doc.thread?.id || doc.threadId) !== threadId) return [];
  if (doc.messages) return doc.messages.flatMap((m) => {
    const inbound = nativeInbound({ type: 'functionCallOutput', id: m.inboundMessageId, namespace: m.nativeItemNamespace,
      name: m.nativeItemName, output: { text: m.nativeOutput, truncated: m.nativeOutputTruncated } });
    return inbound ? [{ ...inbound, turnId: m.sourceTurnId }] : [];
  });
  return doc.turns.flatMap((turn) => (turn.items || []).flatMap((item) => {
    const inbound = nativeInbound(item);
    return inbound ? [{ ...inbound, turnId: turn.id }] : [];
  }));
}

export function registeredMembers(company) {
  const directory = company.contacts();
  const members = directory.members || [];
  const managerThreadId = members.find((m) => m.role === 'general_manager')?.threadId;
  if (directory.status !== 'ready' || directory.authorizationSourceThreadId !== managerThreadId ||
      members.filter((m) => m.role === 'general_manager').length !== 1 ||
      members.find((m) => m.role === 'general_manager')?.threadId !== managerThreadId ||
      new Set(members.map((m) => m.threadId)).size !== members.length || new Set(members.map((m) => m.role)).size !== members.length ||
      members.some((m) => m.hostId !== 'local' || !/^[a-z_0-9]+$/.test(m.role) || !/^[a-zA-Z0-9-]+$/.test(m.threadId))) throw Error('通讯录未就绪或真实路由不一致');
  return members;
}

/** Saved coordination receipts corroborate submissions; they never prove recipient execution. */
export function readNativeReceipts(company, members, limit = 160) {
  const managerThreadId = members.find((m) => m.role === 'general_manager')?.threadId;
  const byThread = new Map(members.map((m) => [m.threadId, m]));
  let files;
  try {
    files = fs.readdirSync(company.receiptsDir).filter((f) => /^send-[a-f0-9]+\.json$/.test(f))
      .map((file) => ({ file, mtime: fs.statSync(path.join(company.receiptsDir, file)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime).slice(0, limit);
  } catch { return []; }
  return files.flatMap(({ file }) => {
    try {
      const receipt = safeFile(company.receiptsDir, file);
      const from = byThread.get(receipt.sourceThreadId), to = byThread.get(receipt.recipientThreadId);
      if (!from || !to || from === to || receipt.channel !== 'codex_app.send_message_to_thread' ||
          receipt.request?.threadId !== to.threadId || receipt.request?.hostId !== 'local' ||
          submittedTarget(receipt.toolResult) !== to.threadId || typeof receipt.request?.prompt !== 'string') return [];
      if (receipt.messageKind === 'dispatch' && from.threadId !== managerThreadId) return [];
      if (!Number.isFinite(Date.parse(receipt.savedAt))) return [];
      const taskId = TASK_RE.test(receipt.primaryTaskId) ? receipt.primaryTaskId :
        receipt.taskIds?.length === 1 && TASK_RE.test(receipt.taskIds[0]) ? receipt.taskIds[0] : null;
      return [{ id: receipt.operationKey || file.slice(0, -5), receiptId: file.slice(0, -5), taskId,
        kind: receipt.messageKind || 'message', sourceThreadId: from.threadId, recipientThreadId: to.threadId,
        fromRole: from.role, toRole: to.role, bodyHash: bodyHash(receipt.request.prompt),
        text: receipt.request.prompt.trim().slice(0, 600), at: new Date(receipt.savedAt).toISOString(),
        outcome: receipt.outcome?.kind || null, linkedInboundMessageIds: receipt.linkedInboundMessageIds || [],
        evidence: path.relative(company.root, path.join(company.receiptsDir, file)) }];
    } catch { return []; }
  });
}

/** A manager decision must link the direct native inbound and an actual local acceptance file. */
export function readManagerDecisions(company, members, receipts) {
  const managerThreadId = members.find((m) => m.role === 'general_manager')?.threadId;
  const employeeIds = new Set(members.filter((m) => m.role !== 'general_manager').map((m) => m.threadId));
  const tasks = new Set(receipts.map((r) => r.taskId).filter(Boolean));
  let records;
  try { records = safeFile(path.join(company.root, '公司/组织'), '员工回报处理记录.json').records || []; } catch { return []; }
  const snapshotCache = new Map();
  return records.filter((r) => r.status === 'handled' && employeeIds.has(r.sourceThreadId) &&
      [...(r.taskIds || []), r.taskId].some((task) => tasks.has(task))).slice(-100).flatMap((r) => {
    try {
      const snapshotFile = safeFile(path.join(company.root, '公司/任务'), r.nativeSnapshotEvidence, { json: false });
      if (!snapshotCache.has(snapshotFile)) snapshotCache.set(snapshotFile, snapshotInbounds(JSON.parse(fs.readFileSync(snapshotFile, 'utf8')), managerThreadId));
      const inbound = snapshotCache.get(snapshotFile).find((i) => i.itemId === r.inboundMessageId && i.sourceThreadId === r.sourceThreadId);
      if (!inbound || (r.sourceTurnId && inbound.turnId !== r.sourceTurnId)) return [];
      const receipt = receipts.find((s) => s.kind === 'report' && s.sourceThreadId === r.sourceThreadId &&
        s.recipientThreadId === managerThreadId && s.bodyHash === bodyHash(inbound.text));
      if (!receipt || (TASK_RE.test(r.taskId) && r.taskId !== receipt.taskId) || typeof r.handling !== 'string' || !r.handling.trim()) return [];
      if (!Number.isFinite(Date.parse(r.handledAt))) return [];
      let acceptance = null;
      if (r.decisionKind === 'accepted') {
        const file = safeFile(path.join(company.root, '公司/任务'), r.acceptanceEvidencePath, { json: false });
        acceptance = path.relative(company.root, file);
      }
      return [{ id: 'decision:' + r.inboundMessageId, taskId: TASK_RE.test(r.taskId) ? r.taskId : receipt.taskId,
        kind: 'handling', stage: acceptance ? 'accepted' : 'handled', fromRole: 'general_manager', toRole: receipt.fromRole,
        sourceThreadId: managerThreadId, recipientThreadId: r.sourceThreadId, inboundMessageId: r.inboundMessageId,
        linkedReceiptId: receipt.id, sourceTurnId: inbound.turnId, at: new Date(r.handledAt).toISOString(), text: String(r.handling).slice(0, 600),
        decisionKind: r.decisionKind || 'decision', evidence: '公司/组织/员工回报处理记录.json', acceptanceEvidence: acceptance,
        nativeEvidence: path.relative(company.root, snapshotFile) }];
    } catch { return []; }
  });
}
