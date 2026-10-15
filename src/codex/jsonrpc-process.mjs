import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import readline from 'node:readline';

export class JsonRpcError extends Error {
  constructor(method, error) {
    super(error?.message || `${method} failed`);
    this.name = 'JsonRpcError';
    this.method = method;
    this.code = error?.code ?? null;
    this.data = error?.data ?? null;
  }
}

/**
 * Newline-delimited JSON-RPC over a child process' stdio.
 * The Codex App Server sends notifications, server-initiated requests and responses on stdout.
 */
export class JsonRpcProcess extends EventEmitter {
  constructor({ command, args = [], cwd, env, name = 'jsonrpc', stderrLimit = 200 }) {
    super();
    this.command = command;
    this.args = args;
    this.cwd = cwd;
    this.env = env;
    this.name = name;
    this.stderrLimit = stderrLimit;
    this.nextId = 1;
    this.pending = new Map();
    this.stderr = [];
    this.child = null;
    this.exited = null;
  }

  start() {
    if (this.child) return;
    this.exited = null;
    const child = spawn(this.command, this.args, {
      cwd: this.cwd,
      env: this.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;
    child.on('error', (error) => {
      this.emit('processError', error);
      this.#failAll(error);
    });
    child.on('exit', (code, signal) => {
      this.exited = { code, signal, at: new Date().toISOString() };
      this.child = null;
      this.#failAll(new Error(`${this.name} exited (code=${code}, signal=${signal})`));
      this.emit('exit', this.exited);
    });
    readline.createInterface({ input: child.stdout }).on('line', (line) => this.#onLine(line));
    readline.createInterface({ input: child.stderr }).on('line', (line) => {
      this.stderr.push(line);
      if (this.stderr.length > this.stderrLimit) this.stderr.shift();
      this.emit('stderr', line);
    });
  }

  get running() {
    return Boolean(this.child);
  }

  request(method, params = undefined, { timeoutMs = 120_000 } = {}) {
    if (!this.child) return Promise.reject(new Error(`${this.name} is not running`));
    const id = this.nextId++;
    const message = params === undefined ? { id, method } : { id, method, params };
    return new Promise((resolve, reject) => {
      const timer = timeoutMs
        ? setTimeout(() => {
            this.pending.delete(id);
            reject(new Error(`${method} timed out after ${timeoutMs}ms`));
          }, timeoutMs)
        : null;
      this.pending.set(id, { method, resolve, reject, timer });
      this.#write(message);
    });
  }

  notify(method, params = undefined) {
    this.#write(params === undefined ? { method } : { method, params });
  }

  respond(id, result) {
    this.#write({ id, result });
  }

  respondError(id, code, message, data = undefined) {
    this.#write({ id, error: data === undefined ? { code, message } : { code, message, data } });
  }

  async stop({ graceMs = 3000 } = {}) {
    const child = this.child;
    if (!child) return;
    const done = new Promise((resolve) => child.once('exit', resolve));
    child.stdin.end();
    // Windows SIGTERM terminates immediately. Give the server time to close tools on EOF.
    if (process.platform !== 'win32') child.kill('SIGTERM');
    const timer = setTimeout(() => {
      if (this.child === child) child.kill('SIGKILL');
    }, graceMs);
    await done;
    clearTimeout(timer);
  }

  #write(message) {
    if (!this.child) throw new Error(`${this.name} is not running`);
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #onLine(line) {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.emit('protocolNoise', line);
      return;
    }
    const hasId = message.id !== undefined && message.id !== null;
    if (hasId && (Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error')) && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (pending.timer) clearTimeout(pending.timer);
      if (message.error) pending.reject(new JsonRpcError(pending.method, message.error));
      else pending.resolve(message.result);
      return;
    }
    if (hasId && message.method) {
      this.emit('serverRequest', message);
      return;
    }
    if (message.method) this.emit('notification', message);
  }

  #failAll(error) {
    for (const [id, pending] of this.pending) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}
