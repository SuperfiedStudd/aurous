import { randomBytes } from 'node:crypto';

export function createRunId(now = new Date()): string {
  const timestamp = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
  return `run-${timestamp}-${randomBytes(3).toString('hex')}`;
}
