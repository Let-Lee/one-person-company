import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CodexRuntime } from './codex/codex-runtime.mjs';
import { contextArgs } from './codex/context-profile.mjs';
import { CompanyDirectory, DEPARTMENTS, EMBLEMS, PALETTES } from './company.mjs';
import { Store } from './store.mjs';
import { Workbench, WorkbenchError } from './workbench.mjs';
import { NativeRouteError } from './native-route.mjs';
import { CollaborationError } from './collaboration.mjs';
import { DesktopManager } from './desktop-manager.mjs';
import { DesktopIpcError } from './codex/desktop-ipc.mjs';
import { NativeCollaboration } from './native-collaboration.mjs';
import { Onboarding } from './onboarding.mjs';

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = path.join(PROJECT_ROOT, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8', '.png': 'image/png' };

export function ensureWorkspace(dir, note) {
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(path.join(dir, '.git'))) {
    try {
      execFileSync('git', ['init', '-q'], { cwd: dir });
    } catch {
      // git is optional; the AGENTS.md still scopes the work
    }
  }
  const agents = path.join(dir, 'AGENTS.md');
  if (!fs.existsSync(agents)) fs.writeFileSync(agents, note);
  return fs.realpathSync(dir);
}

export function buildPaths(env = process.env) {
  const companyRoot = path.resolve(env.YEWANG_COMPANY_ROOT || PROJECT_ROOT);
  const dataDir = path.resolve(env.YEWANG_DATA_DIR || path.join(PROJECT_ROOT, '.data'));
  const workspacesRoot = path.resolve(env.YEWANG_WORKSPACES_ROOT || path.join(dataDir, 'workspaces'));
  const defaultWorkspace = ensureWorkspace(
    path.join(workspacesRoot, '测试工作区'),
    '# 工作台测试工作区\n\n这是野望科技工作台运行会话的默认隔离目录。只在本目录内创建或修改文件，不读取公司业务资料，不调度任何岗位或子agent。\n',
  );
  const extraSkillRoots = [path.join(PROJECT_ROOT, 'skills'), ...(env.YEWANG_EXTRA_SKILL_ROOTS || '').split(path.delimiter).filter(Boolean)].map((p) => path.resolve(p));
  return {
    projectRoot: PROJECT_ROOT,
    companyRoot,
    dataDir,
    reportFile: path.resolve(env.YEWANG_REPORT_FILE || path.join(dataDir, 'capability-report.json')),
    workspacesRoot: fs.realpathSync(workspacesRoot),
    defaultWorkspace,
    allowedRoots: [fs.realpathSync(workspacesRoot), companyRoot],
    extraSkillRoots,
  };
}

export function createWorkbench({ env = process.env, runtime, nativeBridge } = {}) {
  const store = new Store(path.resolve(env.YEWANG_DATA_DIR || path.join(PROJECT_ROOT, '.data')));
  const importCompany = store.state.workspace.mode === 'legacy-company' || env.YEWANG_IMPORT_COMPANY === '1';
  const effectiveEnv = { ...env };
  const paths = buildPaths(effectiveEnv);
  if (!importCompany) paths.allowedRoots = [paths.workspacesRoot];
  const userWorkspace = store.state.workspace.setup.workspacePath;
  if (userWorkspace && fs.existsSync(userWorkspace) && fs.statSync(userWorkspace).isDirectory()) paths.allowedRoots.push(fs.realpathSync(userWorkspace));
  if (importCompany && store.state.workspace.mode !== 'legacy-company') store.state.workspace = { ...store.state.workspace, mode: 'legacy-company', setup: { ...store.state.workspace.setup, step: 'done', completed: true } };
  const company = new CompanyDirectory(paths.companyRoot, { enabled: importCompany });
  const codex = runtime || new CodexRuntime({ cwd: paths.defaultWorkspace, extraSkillRoots: paths.extraSkillRoots, args: contextArgs(env.YEWANG_CONTEXT_MODE || 'lean'), contextMode: env.YEWANG_CONTEXT_MODE || 'lean' });
  const workbench = new Workbench({ store, runtime: codex, company, paths, maxConcurrent: Number(env.YEWANG_MAX_CONCURRENT || 3), nativeBridge });
  workbench.onboarding = new Onboarding({ workbench });
  return { workbench, paths, store, runtime: codex };
}

function send(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(text);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) throw new WorkbenchError(413, '请求过大');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new WorkbenchError(400, '请求不是有效 JSON');
  }
}

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
  const file = path.resolve(PUBLIC_DIR, rel);
  if (!file.startsWith(`${PUBLIC_DIR}${path.sep}`)) return send(res, 403, { error: 'forbidden' });
  fs.readFile(file, (error, data) => {
    if (error) {
      fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (err2, html) => {
        if (err2) return send(res, 404, { error: 'not found' });
        res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store' });
        res.end(html);
      });
      return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(data);
  });
}

export function createServer({ workbench, paths, port, desktopManager, nativeCollaboration }) {
  if (desktopManager === undefined) desktopManager = new DesktopManager({ dataDir: paths.dataDir, threadId: workbench.company.enabled ? workbench.company.managerThreadId() : undefined });
  workbench.desktopManager = desktopManager;
  if (nativeCollaboration === undefined) nativeCollaboration = workbench.company.enabled ? new NativeCollaboration({ company: workbench.company, dataDir: paths.dataDir }) : null;
  workbench.nativeCollaboration = nativeCollaboration;
  const clients = new Set();
  workbench.on('event', (event) => {
    const line = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of clients) res.write(line);
  });
  desktopManager?.on('changed', () => {
    for (const res of clients) res.write(`data: ${JSON.stringify({ type: 'desktop-manager.changed' })}\n\n`);
  });
  nativeCollaboration?.on('changed', () => {
    for (const res of clients) res.write(`data: ${JSON.stringify({ type: 'native-collaboration.changed' })}\n\n`);
  });
  const heartbeat = setInterval(() => {
    for (const res of clients) res.write(': keep-alive\n\n');
  }, 20_000);
  heartbeat.unref();

  const routes = [];
  const route = (method, pattern, handler) => routes.push({ method, pattern, handler });

  route('GET', /^\/api\/health$/, () => ({ ok: true, app: 'one-person-company', version: '2.0.0', instanceId: process.env.ONE_PERSON_COMPANY_INSTANCE || null }));
  route('GET', /^\/api\/overview$/, () => workbench.overview());
  route('GET', /^\/api\/setup$/, () => workbench.onboarding.snapshot());
  route('PATCH', /^\/api\/setup$/, (_m, body) => workbench.onboarding.draft(body));
  route('POST', /^\/api\/setup\/check$/, () => workbench.onboarding.checkEnvironment());
  route('POST', /^\/api\/setup\/manager$/, (_m, body) => workbench.onboarding.createManager(body));
  route('POST', /^\/api\/setup\/manager\/bind$/, (_m, body) => workbench.onboarding.bindManager(body));
  route('POST', /^\/api\/setup\/employees$/, (_m, body) => workbench.onboarding.createEmployee(body));
  route('POST', /^\/api\/team\/employees$/, (_m, body) => workbench.onboarding.addEmployee(body));
  route('POST', /^\/api\/setup\/skills$/, (_m, body) => workbench.onboarding.saveSkills(body));
  route('POST', /^\/api\/setup\/first-task$/, (_m, body) => workbench.onboarding.firstTask(body));
  route('POST', /^\/api\/setup\/finish$/, () => workbench.onboarding.finish());
  route('POST', /^\/api\/setup\/desktop$/, () => workbench.onboarding.useDesktop());
  route('POST', /^\/api\/setup\/independent$/, () => workbench.onboarding.useIndependent());
  route('PUT', /^\/api\/desktop-connection$/, (_m, body) => desktopManager.configure(body));
  route('DELETE', /^\/api\/desktop-connection$/, () => desktopManager.disconnect());
  route('GET', /^\/api\/desktop-connection\/candidates$/, async () => {
    const result = await workbench.runtime.listThreads({ limit: 50, archived: false });
    return { threads: (result.data || []).filter((t) => t.source === 'vscode' || t.source === 'app' || t.source?.subAgent === undefined).map((t) => ({ id: t.id, title: t.name || t.preview?.slice(0, 100) || '未命名聊天', cwd: t.cwd, updatedAt: t.updatedAt })) };
  });
  route('GET', /^\/api\/desktop-manager$/, () => desktopManager?.readStatus() || { ready: false, busy: false, configured: false, target: null, messages: [], lastError: '请先通过引导建立自己的总经理。' });
  route('POST', /^\/api\/desktop-manager\/messages$/, (_m, body) => { if (!desktopManager) throw new WorkbenchError(409, '尚未绑定桌面经理，请通过引导建立总经理。'); return desktopManager.send(body); });
  route('GET', /^\/api\/native-collaboration$/, (_m, _body, url) => nativeCollaboration?.readStatus({ taskId: url.searchParams.get('taskId') || undefined, roleKey: url.searchParams.get('roleKey') || undefined }) || { ready: false, roles: [], flows: [], events: [], counts: {} });
  route('GET', /^\/api\/roles$/, () => ({ roles: workbench.listRoles(), appearanceChoices: { palettes: Object.keys(PALETTES), emblems: EMBLEMS }, departments: DEPARTMENTS }));
  route('POST', /^\/api\/roles$/, (_m, body) => workbench.saveLocalRole(body));
  route('PATCH', /^\/api\/roles\/([^/]+)\/config$/, (m, body) => workbench.configureRole(decodeURIComponent(m[1]), body));
  route('GET', /^\/api\/skills$/, (_m, _b, url) => workbench.listSkills(url.searchParams.get('cwd') || paths.defaultWorkspace, url.searchParams.get('reload') === '1'));
  route('GET', /^\/api\/models$/, async () => {
    const result = await workbench.runtime.listModels();
    return { models: (result.data || []).filter((m) => !m.hidden).map((m) => ({ id: m.id, displayName: m.displayName || m.id, isDefault: Boolean(m.isDefault), efforts: (m.supportedReasoningEfforts || []).map((e) => e.reasoningEffort || e) })) };
  });
  route('GET', /^\/api\/workspaces$/, () => {
    const list = [{ label: '默认测试工作区', path: paths.defaultWorkspace, kind: 'test' }];
    for (const name of fs.readdirSync(paths.workspacesRoot)) {
      const full = path.join(paths.workspacesRoot, name);
      if (full !== paths.defaultWorkspace && fs.statSync(full).isDirectory()) list.push({ label: `测试工作区 · ${name}`, path: full, kind: 'test' });
    }
    if (workbench.company.enabled) list.push({ label: '公司工作区（加载公司 AGENTS 规则）', path: paths.companyRoot, kind: 'company' });
    return { workspaces: list };
  });
  route('GET', /^\/api\/sessions$/, () => ({ sessions: workbench.listSessions() }));
  route('GET', /^\/api\/sessions\/([^/]+)\/chat$/, (m) => {
    const session = workbench.getSession(m[1]);
    return { session, runs: workbench.listRuns({ sessionId: session.id, limit: 80 }).reverse().map((r) => workbench.getRun(r.id)) };
  });
  route('POST', /^\/api\/sessions$/, (_m, body) => workbench.createSession(body));
  route('PATCH', /^\/api\/sessions\/([^/]+)$/, (m, body) => workbench.renameSession(m[1], body.title));
  route('POST', /^\/api\/sessions\/([^/]+)\/archive$/, (m) => workbench.archiveSession(m[1]));
  route('POST', /^\/api\/sessions\/([^/]+)\/continue$/, (m, body) => workbench.continueSession(m[1], body));
  route('POST', /^\/api\/sessions\/([^/]+)\/inbox\/resume$/, (m) => workbench.collaboration.resumeInbox(m[1]));
  route('GET', /^\/api\/collaboration$/, (_m, _b, url) => workbench.collaboration.page({ namespace: url.searchParams.get('namespace') || undefined, taskId: url.searchParams.get('taskId') || undefined, cursor: url.searchParams.get('cursor') || undefined, limit: url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : 30 }));
  route('GET', /^\/api\/collaboration\/messages\/([^/]+)\/artifacts\/(\d+)$/, (m) => workbench.collaboration.readArtifact(m[1], Number(m[2])));
  route('POST', /^\/api\/collaboration\/tasks\/([^/]+)\/control$/, (m, body) => workbench.collaboration.controlFromConsole(m[1], body.action));
  route('GET', /^\/api\/client-requests\/([^/]+)$/, (m) => {
    const request = workbench.state.consoleRequests[decodeURIComponent(m[1])];
    return { found: Boolean(request), run: request ? workbench.getRun(request.runId) : null };
  });
  route('GET', /^\/api\/runs$/, (_m, _b, url) => ({ runs: workbench.listRuns({ roleKey: url.searchParams.get('roleKey'), sessionId: url.searchParams.get('sessionId') }) }));
  route('POST', /^\/api\/runs$/, (_m, body) => workbench.dispatch(body));
  route('GET', /^\/api\/runs\/([^/]+)$/, (m) => workbench.getRun(m[1]));
  route('POST', /^\/api\/runs\/([^/]+)\/interrupt$/, (m, body) => workbench.interrupt(m[1], body.mode));
  route('POST', /^\/api\/runs\/([^/]+)\/steer$/, (m, body) => workbench.steer(m[1], body.text));
  route('GET', /^\/api\/approvals$/, (_m, _b, url) => ({ approvals: workbench.listApprovals(url.searchParams.get('status')) }));
  route('POST', /^\/api\/approvals\/([^/]+)$/, (m, body) => workbench.decideApproval(m[1], body));
  route('GET', /^\/api\/desktop-sessions$/, async () => ({ sessions: workbench.company.enabled ? await workbench.desktopSessions() : [], probes: workbench.company.enabled ? workbench.state.desktopProbes || {} : {} }));
  route('GET', /^\/api\/migrations$/, () => workbench.migrations.snapshot());
  route('POST', /^\/api\/migrations$/, (_m, body) => workbench.migrations.prepare(body.roleKey));
  route('GET', /^\/api\/migrations\/([^/]+)$/, (m) => workbench.migrations.get(m[1]));
  for (const method of ['probe', 'activate', 'rollback']) route('POST', new RegExp(`^/api/migrations/([^/]+)/${method}$`), (m, body) => {
    if (body.confirm !== true) throw new WorkbenchError(400, '需要明确选择后才办理本岗位接管');
    return workbench.migrations[method](m[1]);
  });
  route('POST', /^\/api\/migrations\/([^/]+)\/dispatch$/, (m, body) => workbench.dispatchNative(m[1], body));
  route('POST', /^\/api\/native-reports\/([^/]+)\/send$/, (m) => workbench.migrations.sendReport(m[1]));
  route('GET', /^\/api\/desktop-sessions\/([^/]+)\/preview$/, async (m) => { if (!workbench.company.enabled) throw new WorkbenchError(409, '请查看本工作台已建立的会话'); return { turns: await workbench.desktopPreview(m[1]) }; });
  route('POST', /^\/api\/desktop-sessions\/([^/]+)\/takeover-probe$/, (m, body) => {
    if (!workbench.company.enabled) throw new WorkbenchError(409, '当前工作台未导入桌面公司资料');
    if (body.confirm !== true) throw new WorkbenchError(400, '需要明确确认后才检查原地接管');
    return workbench.desktopTakeoverProbe(m[1]);
  });
  route('GET', /^\/api\/handoffs$/, () => ({ handoffs: workbench.handoffs() }));
  route('GET', /^\/api\/usage$/, () => workbench.usage());
  route('GET', /^\/api\/runtime$/, () => workbench.runtime.snapshot());
  route('POST', /^\/api\/runtime\/start$/, () => workbench.startRuntime());
  route('POST', /^\/api\/runtime\/restart$/, () => workbench.restartRuntime());
  route('POST', /^\/api\/runtime\/stop$/, () => workbench.stopRuntime());

  const server = http.createServer(async (req, res) => {
    const host = req.headers.host || '';
    const allowedHosts = new Set([`127.0.0.1:${server.address()?.port}`, `localhost:${server.address()?.port}`]);
    if (!allowedHosts.has(host)) return send(res, 421, { error: '仅允许本机地址访问' });
    const url = new URL(req.url, `http://${host}`);
    if (url.pathname === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify({ type: 'hello', runtime: workbench.runtime.snapshot() })}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (!url.pathname.startsWith('/api/')) return serveStatic(req, res, url.pathname);
    if (req.method !== 'GET') {
      const origin = req.headers.origin;
      if (req.headers['x-yewang-workbench'] !== '1' || (origin && !allowedHosts.has(origin.replace(/^https?:\/\//, '')))) {
        return send(res, 403, { error: '拒绝跨站请求' });
      }
    }
    const match = routes.find((r) => r.method === req.method && r.pattern.test(url.pathname));
    if (!match) return send(res, 404, { error: '接口不存在' });
    try {
      const body = req.method === 'GET' ? {} : await readBody(req);
      const result = await match.handler(url.pathname.match(match.pattern), body, url);
      send(res, 200, result ?? { ok: true });
    } catch (error) {
      const status = error instanceof WorkbenchError || error instanceof NativeRouteError || error instanceof CollaborationError || error instanceof DesktopIpcError ? error.status : error.code === -32600 ? 409 : 500;
      send(res, status, { error: error.message, code: error.code ?? null, details: error.details ?? null });
    }
  });
  server.on('close', () => { clearInterval(heartbeat); desktopManager?.close(); nativeCollaboration?.close(); });
  server.desktopManager = desktopManager;
  server.nativeCollaboration = nativeCollaboration;
  return server;
}
