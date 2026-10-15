import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

// The installed desktop's local follower protocol. This client never becomes an owner,
// launches an app-server, changes settings, or handles another thread's requests.
const VERSIONS = {
  initialize: 0,
  'thread-owner-discovery': 1,
  'thread-follower-read-model-settings': 1,
  'thread-follower-start-turn': 2,
  'thread-follower-load-complete-history': 1,
  'thread-stream-following-changed': 1,
  'thread-stream-state-changed': 11,
};
const MAX_FRAME = 128 * 1024 * 1024;

export class DesktopIpcError extends Error {
  constructor(message, { status = 503, result, unknown = false } = {}) {
    super(message); this.status = status; this.result = result; this.unknown = unknown;
  }
}

export class DesktopIpc extends EventEmitter {
  constructor({ socketPath = process.env.CODEX_DESKTOP_SOCKET || path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'ipc/ipc.sock'), timeoutMs = 15_000 } = {}) {
    super(); this.socketPath = socketPath; this.timeoutMs = timeoutMs;
    this.socket = null; this.clientId = null; this.pending = new Map();
    this.#resetFrames(); this.connecting = null;
  }

  async connect() {
    if (this.clientId && this.socket?.writable) return this;
    if (this.connecting) return this.connecting;
    this.connecting = this.#connect().catch((error) => { this.close(); throw error; }).finally(() => { this.connecting = null; });
    return this.connecting;
  }

  async #connect() {
    const uid = process.getuid?.();
    const dir = fs.lstatSync(path.dirname(this.socketPath));
    const endpoint = fs.lstatSync(this.socketPath);
    if (uid == null || !dir.isDirectory() || dir.uid !== uid || (dir.mode & 0o022) || !endpoint.isSocket() || endpoint.uid !== uid || (endpoint.mode & 0o077)) {
      throw new DesktopIpcError('桌面本机入口的所有者或访问权限不符');
    }
    const socket = net.createConnection(this.socketPath);
    this.socket = socket; this.#resetFrames();
    socket.on('data', (chunk) => this.#read(chunk));
    socket.on('error', (error) => this.emit('connectionError', error));
    socket.on('close', () => {
      if (this.socket !== socket) return;
      this.socket = null; this.clientId = null; this.#resetFrames();
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new DesktopIpcError('桌面连接已断开', { unknown: pending.method === 'thread-follower-start-turn' }));
      }
      this.pending.clear(); this.emit('disconnected');
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { socket.destroy(); reject(new DesktopIpcError('桌面入口连接超时')); }, this.timeoutMs);
      socket.once('connect', () => { clearTimeout(timer); resolve(); });
      socket.once('error', (error) => { clearTimeout(timer); reject(error); });
    });
    const result = await this.request('initialize', { clientType: 'yewang_workbench' });
    if (!result.result?.clientId || result.handledByClientId !== result.result.clientId) {
      this.close(); throw new DesktopIpcError('桌面入口未分配真实客户端 ID');
    }
    this.clientId = result.result.clientId;
    return this;
  }

  request(method, params, { targetClientId, timeoutMs = this.timeoutMs, requestId = randomUUID() } = {}) {
    if (!(method in VERSIONS) || method.startsWith('thread-stream-')) throw new DesktopIpcError('不支持的桌面请求', { status: 400 });
    if (!this.socket?.writable || (!this.clientId && method !== 'initialize')) throw new DesktopIpcError('桌面尚未连接');
    if (this.pending.has(requestId)) throw new DesktopIpcError('重复请求 ID', { status: 409 });
    const message = { type: 'request', requestId, sourceClientId: this.clientId || 'initializing-client', version: VERSIONS[method], method, params, targetClientId, timeoutMs };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new DesktopIpcError('桌面请求结果未知或超时', { unknown: method === 'thread-follower-start-turn' }));
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer, method, targetClientId });
      try { this.#write(message); }
      catch (error) { clearTimeout(timer); this.pending.delete(requestId); reject(error); }
    });
  }

  follow(conversationId, ownerClientId, following = true) {
    if (!this.clientId) throw new DesktopIpcError('桌面尚未连接');
    this.#write({ type: 'broadcast', method: 'thread-stream-following-changed', version: 1, sourceClientId: this.clientId,
      targetClientIds: [ownerClientId], params: { hostId: 'local', conversationId, following } });
  }

  close() { this.socket?.destroy(); }

  #write(message) {
    const body = Buffer.from(JSON.stringify(message));
    if (body.length > MAX_FRAME) throw new DesktopIpcError('桌面消息过大', { status: 413 });
    const header = Buffer.alloc(4); header.writeUInt32LE(body.length);
    this.socket.write(Buffer.concat([header, body]));
  }

  #resetFrames() { this.chunks = []; this.chunkOffset = 0; this.buffered = 0; this.frameSize = null; }

  #consume(size) {
    const first = this.chunks[0], available = first.length - this.chunkOffset;
    if (available >= size) {
      const result = first.subarray(this.chunkOffset, this.chunkOffset + size);
      this.chunkOffset += size; this.buffered -= size;
      if (this.chunkOffset === first.length) { this.chunks.shift(); this.chunkOffset = 0; }
      return result;
    }
    const result = Buffer.allocUnsafe(size); let offset = 0;
    while (offset < size) {
      const part = this.chunks[0], take = Math.min(size - offset, part.length - this.chunkOffset);
      part.copy(result, offset, this.chunkOffset, this.chunkOffset + take);
      offset += take; this.chunkOffset += take;
      if (this.chunkOffset === part.length) { this.chunks.shift(); this.chunkOffset = 0; }
    }
    this.buffered -= size; return result;
  }

  #read(chunk) {
    this.chunks.push(chunk); this.buffered += chunk.length;
    while (true) {
      if (this.frameSize === null) {
        if (this.buffered < 4) return;
        const size = this.#consume(4).readUInt32LE(0);
        if (!size || size > MAX_FRAME) { this.emit('connectionError', new DesktopIpcError(`桌面消息大小 ${Math.ceil(size / 1048576)} MB 超出支持范围（最多 128 MB）`, { result: { size, max: MAX_FRAME } })); this.close(); return; }
        this.frameSize = size;
      }
      if (this.buffered < this.frameSize) return;
      const body = this.#consume(this.frameSize); this.frameSize = null;
      let message;
      try { message = JSON.parse(body.toString('utf8')); }
      catch { this.close(); return; }
      if (message.type === 'response') {
        const pending = this.pending.get(message.requestId);
        if (!pending) continue;
        clearTimeout(pending.timer); this.pending.delete(message.requestId);
        if (message.resultType !== 'success') pending.reject(new DesktopIpcError(String(message.error || '桌面请求被拒绝'), { result: message }));
        else if (message.method !== pending.method || (pending.targetClientId && message.handledByClientId !== pending.targetClientId)) pending.reject(new DesktopIpcError('桌面回复来源或请求不匹配', { result: message, unknown: pending.method === 'thread-follower-start-turn' }));
        else pending.resolve(message);
      } else if (message.type === 'broadcast') this.emit('broadcast', message);
      else if (message.type === 'client-discovery-request') {
        this.#write({ type: 'client-discovery-response', requestId: message.requestId, response: { canHandle: false } });
      }
    }
  }
}
