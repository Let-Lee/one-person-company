import { esc, clock, status } from './lib.js';

const CONNECTION = { disconnected: ['未连接', 'neutral'], connecting: ['正在生成二维码', 'running'], waiting_scan: ['等待本人扫码', 'waiting'], connected: ['微信已连接', 'done'], expired: ['二维码已过期', 'waiting'], auth_expired: ['需要重新扫码', 'error'], connection_error: ['连接待处理', 'error'], unavailable: ['暂不可用', 'neutral'] };
const EXECUTION = { queued: '等待经理', submitting: '正在提交', running: '经理处理中', completed: '本轮已结束', interrupted: '已暂停', cancelled: '已取消', failed: '执行遇阻', blocked: '需要处理', unknown: '提交待核实' };

export function weixinSettingsHtml(data) {
  const choices = data.choices || [], requests = data.requests || [], replies = data.replies || [];
  const selected = data.manager?.key || (choices.length === 1 ? choices[0].key : '');
  const login = data.login;
  const needsCode = login?.status === 'need_verifycode';
  const badge = login?.status === 'need_verifycode' ? ['等待本人验证', 'waiting'] : login?.status === 'scaned' ? ['已扫码 · 等待确认', 'waiting'] : CONNECTION[data.status] || CONNECTION.disconnected;
  const connected = data.status === 'connected';
  const delivery = request => {
    const list = replies.filter(r => r.requestId === request.id);
    if (list.some(r => r.status === 'unknown')) return ['送达待核实', 'waiting'];
    if (list.some(r => ['failed', 'held'].includes(r.status))) return ['微信回传失败', 'error'];
    if (list.length && list.every(r => r.status === 'sent')) return ['微信已发送', 'done'];
    return ['等待回传', 'neutral'];
  };
  return `<section class="card weixin-settings" aria-labelledby="weixin-heading"><header class="weixin-heading"><span class="weixin-mark" aria-hidden="true">微</span><div><h2 id="weixin-heading">微信</h2><p class="muted small">给同一位总经理发消息，任务和结果在网页里同步保留。</p></div><span class="spacer"></span>${status(badge)}</header>
    <div class="weixin-body"><div class="weixin-main"><form data-form="weixin-connect" class="stack"><label class="field"><span>接收消息的总经理</span><select name="managerKey" required ${!choices.length ? 'disabled' : ''}><option value="">选择已有经理</option>${choices.map(c => `<option value="${esc(c.key)}" ${c.key === selected ? 'selected' : ''}>${esc(c.title)} · ${esc(c.name)}${c.mode === 'desktop' ? '（桌面聊天）' : ''}</option>`).join('')}</select></label>
    ${!choices.length ? '<p class="notice">先建立总经理，或连接已有桌面聊天，再连接微信。</p>' : ''}
    <div class="page-actions"><button class="btn btn-primary" ${!choices.length || data.status === 'connecting' ? 'disabled' : ''}>${connected || login ? '重新生成二维码' : '生成连接二维码'}</button>${data.peerVerified && !connected && data.status !== 'auth_expired' ? '<button type="button" class="btn" data-action="weixin-reconnect">重新连接</button>' : ''}${data.status !== 'disconnected' ? '<button type="button" class="btn btn-danger-ghost" data-action="weixin-disconnect">断开微信</button>' : ''}</div></form>
    ${data.lastError ? `<p class="notice" role="alert">${esc(data.lastError)}</p>` : ''}
    <div class="weixin-checks"><div><span>连接</span><strong>${data.peerVerified ? '已绑定扫码本人' : '等待本人授权'}</strong></div><div><span>执行</span><strong>${data.receivedAt ? '已收到微信来信' : '待来信验证'}${data.counts?.queued ? ` · ${data.counts.queued} 条排队` : ''}</strong></div><div><span>回传</span><strong>${data.counts?.failedDelivery ? '有回复待处理' : data.sentAt ? '已有微信发送凭据' : '待实际发送验证'}</strong></div></div>
    <p class="muted small weixin-condition">这台电脑与公司服务需保持运行。首期支持本人文字私聊。长任务回传受微信服务限制，未送达的结果可在原任务查看，也可发 <code>/结果</code> 查询。</p>
    ${data.paused ? '<p class="notice">微信待办已暂停，发送 /继续 恢复队列；原任务续办请在网页确认。</p>' : ''}
    <details class="detail-note"><summary>微信里可以怎么用？</summary><p>直接发送你的目标。经理忙时，消息会排队。<code>/状态</code> 看待办，<code>/结果</code> 查最新结果，<code>/暂停</code> 暂停本入口，<code>/停止</code> 取消待办，<code>/继续</code> 恢复队列。审批在网页处理。</p><p>独立团队复用同一经理会话与停止规则；桌面模式沿用已连接的 Codex 持有端，当前桌面回合的暂停或停止请在 Codex 操作。</p></details></div>
    ${login ? `<aside class="weixin-qr"><div class="weixin-qr-frame" role="img" aria-label="微信连接二维码">${login.qrSvg}</div><strong>${({ wait: '用本人微信扫码', scaned: '已扫码，请在微信确认', need_verifycode: '请完成微信要求的验证', expired: '二维码已过期', verify_code_blocked: '请重新生成二维码' })[login.status] || '请在微信继续确认'}</strong><span class="muted small">二维码仅用于本次连接 · ${esc(clock(login.expiresAt))} 前有效，以微信实际状态为准</span></aside>` : `<aside class="weixin-intro"><span aria-hidden="true">微信 · 你的公司</span><strong>一句话，交给经理</strong><p>扫码连接后，在微信交代目标。<br>回到网页，继续看同一项任务。</p><span class="chip">${connected ? '已连接 · 可发文字验证' : '无需公网地址'}</span></aside>`}</div>
    ${needsCode ? '<form data-form="weixin-verify" class="weixin-verify"><label class="field"><span>微信提示的验证码（请本人操作）</span><input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{4,10}" minlength="4" maxlength="10" required placeholder="本人填写微信上显示的数字"></label><button class="btn btn-primary">提交本人输入的验证码</button></form>' : ''}
    ${requests.length ? `<details class="weixin-history" ${data.counts?.failedDelivery ? 'open' : ''}><summary>微信往来记录${data.counts?.failedDelivery ? ' · 有回传待处理' : ''}</summary><ul>${[...requests].reverse().map(r => { const sent = delivery(r); const href = r.runId ? '#/task/' + encodeURIComponent(r.runId) : '#/manager'; const problems = replies.filter(x => x.requestId === r.id && x.error).map(x => x.error); return `<li><a href="${href}">${esc(r.title)}</a><span>${esc(EXECUTION[r.status] || r.status)}</span>${status(sent)}${r.error || problems.length ? `<p class="small tone-text-error">${esc(r.error || problems[0])}</p>` : ''}</li>`; }).join('')}</ul></details>` : ''}</section>`;
}
