import fs from 'node:fs';
import path from 'node:path';

const EMPTY = () => ({ schemaVersion: 3, roles: {}, roleConfigs: {}, sessions: {}, runs: {}, approvals: {}, migrations: {}, nativeReports: {}, nativeInboundRuns: {}, consoleRequests: {}, collaboration: { groups: {}, tasks: {}, messages: {}, operations: {}, calls: {} }, queue: [], capabilities: null });
const NEW_WORKSPACE = () => ({ version: 1, mode: 'personal', name: '我的公司', ownerName: '', setup: { step: 'welcome', completed: false, managerRoleKey: null, drafts: {}, employeeRequests: {}, createdRoleKeys: [] } });

/** Small JSON store with atomic writes and append-only per-run event logs. */
export class Store {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'state.json');
    this.runDir = path.join(dataDir, 'runs');
    fs.mkdirSync(this.runDir, { recursive: true });
    this.state = this.#load();
    this.timer = null;
  }

  #load() {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const hasExistingData = ['roles', 'sessions', 'runs', 'migrations'].some((key) => Object.keys(data[key] || {}).length);
      const workspace = data.workspace || (hasExistingData ? { ...NEW_WORKSPACE(), mode: 'legacy-company', name: '我的公司', ownerName: '', setup: { ...NEW_WORKSPACE().setup, step: 'done', completed: true, migratedAt: new Date().toISOString() } } : NEW_WORKSPACE());
      return { ...EMPTY(), ...data, schemaVersion: 4, workspace, collaboration: { ...EMPTY().collaboration, ...data.collaboration } };
    } catch (error) {
      if (error.code !== 'ENOENT') {
        const broken = `${this.file}.broken-${Date.now()}`;
        fs.renameSync(this.file, broken);
      }
      return { ...EMPTY(), schemaVersion: 4, workspace: NEW_WORKSPACE() };
    }
  }

  save() {
    clearTimeout(this.timer);
    this.timer = null;
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    fs.renameSync(tmp, this.file);
  }

  saveSoon() {
    if (this.timer) return;
    this.timer = setTimeout(() => this.save(), 150);
  }

  appendRunEvent(runId, event) {
    fs.appendFileSync(path.join(this.runDir, `${runId}.jsonl`), `${JSON.stringify(event)}\n`);
  }

  readRunEvents(runId) {
    try {
      return fs
        .readFileSync(path.join(this.runDir, `${runId}.jsonl`), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  }
}
