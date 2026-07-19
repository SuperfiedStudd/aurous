import { mkdtemp, mkdir, realpath, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ingestContext } from '../src/core/context.js';

describe('ingestContext', () => {
  it('reads only selected safe project context and reports exclusions', async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), 'aurous-context-'));
    const project = path.join(parent, 'project');
    await mkdir(path.join(project, 'src'), { recursive: true });
    await mkdir(path.join(project, 'node_modules', 'dependency'), { recursive: true });
    await writeFile(path.join(project, 'README.md'), '# Safe project\n');
    await writeFile(path.join(project, 'package.json'), '{"name":"safe"}\n');
    await writeFile(path.join(project, 'src', 'index.ts'), 'export const safe = true;\n');
    await writeFile(path.join(project, '.env'), 'API_KEY=do-not-read\n');
    await writeFile(path.join(project, 'private.pem'), 'do-not-read\n');
    await writeFile(path.join(project, 'node_modules', 'dependency', 'index.js'), 'do-not-read\n');
    await writeFile(path.join(parent, 'outside.md'), 'outside approved path\n');
    await symlink(path.join(parent, 'outside.md'), path.join(project, 'outside-link.md'));

    const bundle = await ingestContext({ cwd: parent, paths: ['project'] });

    expect(bundle.summary.approvedPaths).toEqual([await realpath(project)]);
    expect(bundle.summary.files.map((file) => file.relativePath)).toEqual([
      'README.md',
      'package.json',
      'src/index.ts',
    ]);
    expect(bundle.documents.map((document) => document.content).join('\n')).not.toContain(
      'do-not-read',
    );
    expect(bundle.documents.map((document) => document.content).join('\n')).not.toContain(
      'outside approved path',
    );
    expect(bundle.summary.skipped.join('\n')).toContain('.env (not selected)');
    expect(bundle.summary.skipped.join('\n')).toContain('node_modules/ (excluded directory)');
    expect(bundle.summary.skipped.join('\n')).toContain('outside-link.md (symbolic link)');
  });

  it('rejects missing context paths with a stable code', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'aurous-context-missing-'));
    await expect(ingestContext({ cwd, paths: ['missing'] })).rejects.toMatchObject({
      code: 'AUR-CTX-002',
    });
  });
});
