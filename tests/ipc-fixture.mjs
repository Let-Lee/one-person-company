import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
export const fixtureEndpoint = (dir) => process.platform === 'win32' ? String.raw`\\.\pipe\company-test-${randomUUID()}` : path.join(dir, 'ipc.sock');
export function restrictSocket(endpoint) { if (process.platform !== 'win32') fs.chmodSync(endpoint, 0o600); }
