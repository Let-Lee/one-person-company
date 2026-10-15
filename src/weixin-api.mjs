import { randomBytes } from 'node:crypto';

// Wire contract: Tencent/openclaw-weixin, docs/protocol_zh_CN.md (MIT).
export const WEIXIN_BASE = 'https://ilinkai.weixin.qq.com/';
export class WeixinError extends Error {
  constructor(message, { status = 502, auth = false, uncertain = false, code = null } = {}) {
    super(message); Object.assign(this, { status, auth, uncertain, code });
  }
}

export function weixinBase(value = WEIXIN_BASE) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !/^[a-z0-9.-]+\.weixin\.qq\.com$/i.test(url.hostname) || url.username || url.password || (url.port && url.port !== '443')) throw new WeixinError('微信服务返回了无效的连接地址');
  return url.origin + '/';
}

// Adapted from Tencent's MIT-licensed lossless message-ID scanner. Matching
// only object keys preserves quoted user text and distinct uint64 message IDs.
export function parseWeixinJson(raw) {
  let output = '', index = 0;
  while (index < raw.length) {
    if (raw[index] !== '"') { output += raw[index++]; continue; }
    const start = index++;
    let escaped = false;
    while (index < raw.length) {
      const c = raw[index++];
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') break;
    }
    const token = raw.slice(start, index); output += token;
    let cursor = index;
    while (/\s/.test(raw[cursor] ?? '')) cursor++;
    if (raw[cursor] !== ':' || !['message_id', 'msg_id', 'svr_id'].includes(JSON.parse(token))) continue;
    output += raw.slice(index, ++cursor);
    while (/\s/.test(raw[cursor] ?? '')) output += raw[cursor++];
    const number = cursor;
    if (raw[cursor] === '-') cursor++;
    while (/\d/.test(raw[cursor] ?? '')) cursor++;
    if (cursor > number && !(cursor === number + 1 && raw[number] === '-')) {
      output += '"' + raw.slice(number, cursor) + '"'; index = cursor;
    } else index = number;
  }
  return JSON.parse(output);
}

export class WeixinApi {
  constructor({ fetchImpl = fetch } = {}) { this.fetch = fetchImpl; }
  async request(endpoint, { credentials, query, body, signal, timeout = 15000 } = {}) {
    const url = new URL(endpoint, weixinBase(credentials?.baseUrl));
    for (const [key, value] of Object.entries(query || {})) if (value) url.searchParams.set(key, value);
    const headers = { 'iLink-App-Id': 'bot', 'iLink-App-ClientVersion': String(0x020100) };
    if (body) Object.assign(headers, { 'Content-Type': 'application/json', AuthorizationType: 'ilink_bot_token', 'X-WECHAT-UIN': Buffer.from(String(randomBytes(4).readUInt32BE())).toString('base64') });
    if (credentials?.token) headers.Authorization = 'Bearer ' + credentials.token;
    const controller = new AbortController();
    const abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) controller.abort();
    const timer = setTimeout(abort, timeout);
    try {
      const response = await this.fetch(url, { method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined, signal: controller.signal, redirect: 'error' });
      if (!response.ok) throw new WeixinError(`微信服务请求失败（HTTP ${response.status}）`, { auth: [401, 403].includes(response.status), uncertain: response.status >= 500 });
      const raw = await response.text();
      if (raw.length > 2_000_000) throw new WeixinError('微信服务响应过大', { uncertain: true });
      let data; try { data = parseWeixinJson(raw); } catch { throw new WeixinError('微信服务响应格式不正确', { uncertain: true }); }
      const code = Number(data.ret || data.errcode || 0);
      if (code) throw new WeixinError(`微信服务未接受请求（代码 ${code}）`, { code, auth: code === -14 });
      return data;
    } catch (error) {
      if (error instanceof WeixinError) throw error;
      if (controller.signal.aborted) throw new WeixinError('微信服务请求已取消或超时', { uncertain: true, code: 'timeout' });
      throw new WeixinError('无法连接微信服务，请检查本机网络后重新连接', { uncertain: true });
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }
  qr(signal) { return this.request('ilink/bot/get_bot_qrcode', { query: { bot_type: '3' }, body: { local_token_list: [] }, signal }); }
  login(qrcode, { baseUrl, verifyCode, signal } = {}) { return this.request('ilink/bot/get_qrcode_status', { credentials: { baseUrl }, query: { qrcode, verify_code: verifyCode }, signal, timeout: 35000 }); }
  updates(credentials, cursor, signal) { return this.request('ilink/bot/getupdates', { credentials, body: { get_updates_buf: cursor || '', base_info: this.info() }, signal, timeout: 40000 }); }
  send(credentials, { clientId, contextToken, text }, signal) {
    return this.request('ilink/bot/sendmessage', { credentials, body: { msg: { from_user_id: '', to_user_id: credentials.ownerId, client_id: clientId, message_type: 2, message_state: 2, context_token: contextToken, item_list: [{ type: 1, text_item: { text } }] }, base_info: this.info() }, signal });
  }
  info() { return { channel_version: '2.1.1', bot_agent: 'OnePersonCompany/2.1.1' }; }
}
