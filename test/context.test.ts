import { mkdtemp, mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ingestContext, ingestInlineContext, PASTED_CONTEXT_LABEL } from '../src/core/context.js';
import {
  ContextPackStore,
  findProjectRoot,
  renderContextPackMarkdown,
  resolveWorkspaceRoot,
} from '../src/core/context-pack.js';

describe('ingestContext', () => {
  it('reads only selected safe project context and reports exclusions', async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), 'aurous-context-'));
    const project = path.join(parent, 'project');
    await mkdir(path.join(project, 'src'), { recursive: true });
    await mkdir(path.join(project, '.claude'), { recursive: true });
    await mkdir(path.join(project, 'node_modules', 'dependency'), { recursive: true });
    await mkdir(path.join(project, '.Trash'), { recursive: true });
    await mkdir(path.join(project, 'Library', 'Caches'), { recursive: true });
    await mkdir(path.join(project, '.hidden-work'), { recursive: true });
    await writeFile(path.join(project, 'README.md'), '# Safe project\n');
    await writeFile(path.join(project, 'package.json'), '{"name":"safe"}\n');
    await writeFile(path.join(project, 'package-lock.json'), '{"private":"do-not-read"}\n');
    await writeFile(path.join(project, '.mcp.json'), '{"token":"do-not-read"}\n');
    await writeFile(path.join(project, '.claude', 'settings.local.json'), 'do-not-read\n');
    await writeFile(path.join(project, 'src', 'index.ts'), 'export const safe = true;\n');
    await writeFile(path.join(project, '.env'), 'API_KEY=do-not-read\n');
    await writeFile(path.join(project, 'private.pem'), 'do-not-read\n');
    await writeFile(path.join(project, 'node_modules', 'dependency', 'index.js'), 'do-not-read\n');
    await writeFile(path.join(project, '.Trash', 'deleted.md'), 'do-not-read\n');
    await writeFile(path.join(project, 'Library', 'Caches', 'cached.md'), 'do-not-read\n');
    await writeFile(path.join(project, '.hidden-work', 'hidden.md'), 'do-not-read\n');
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
    expect(bundle.summary.skipped.join('\n')).toContain('.claude/ (excluded directory)');
    expect(bundle.summary.skipped.join('\n')).toContain('.Trash/ (excluded directory)');
    expect(bundle.summary.skipped.join('\n')).toContain('Library/ (excluded directory)');
    expect(bundle.summary.skipped.join('\n')).toContain('.hidden-work/ (excluded directory)');
    expect(bundle.summary.skipped.join('\n')).toContain('package-lock.json (not selected)');
    expect(bundle.summary.skipped.join('\n')).toContain('outside-link.md (symbolic link)');
  });

  it('finds bounded project markers and refuses the home-directory boundary', async () => {
    const fakeHome = await mkdtemp(path.join(os.tmpdir(), 'aurous-home-'));
    const project = path.join(fakeHome, 'Projects', 'safe-project');
    const nested = path.join(project, 'src', 'feature');
    await mkdir(nested, { recursive: true });
    await writeFile(path.join(project, 'package.json'), '{"name":"safe-project"}\n');
    await mkdir(path.join(fakeHome, '.aurous'), { recursive: true });
    const homeContext = '{"sentinel":"must-not-be-refreshed"}\n';
    await writeFile(path.join(fakeHome, '.aurous', 'context.json'), homeContext);

    expect(await findProjectRoot(nested, fakeHome)).toBe(await realpath(project));
    expect(await findProjectRoot(fakeHome, fakeHome)).toBeUndefined();
    expect(await readFile(path.join(fakeHome, '.aurous', 'context.json'), 'utf8')).toBe(
      homeContext,
    );
  });

  it('rejects missing context paths with a stable code', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'aurous-context-missing-'));
    await expect(ingestContext({ cwd, paths: ['missing'] })).rejects.toMatchObject({
      code: 'AUR-CTX-002',
    });
  });

  it('builds a documentation bundle from pasted plain text without repository files', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'aurous-inline-'));
    const bundle = ingestInlineContext({
      cwd,
      content: 'Personal finance tracker goals and weekly review notes.',
    });

    expect(bundle.summary.fileCount).toBe(1);
    expect(bundle.summary.files[0]?.category).toBe('documentation');
    expect(bundle.summary.files[0]?.relativePath).toBe('pasted-context.md');
    expect(bundle.documents[0]?.content).toContain('Personal finance tracker');
    expect(PASTED_CONTEXT_LABEL).toBe('pasted');
  });

  it('rejects empty pasted context', () => {
    expect(() =>
      ingestInlineContext({ cwd: '/tmp', content: '   \n\t  ' }),
    ).toThrowError(/Pasted context cannot be empty/);
  });

  it('uses the current directory as the workspace root when no project markers exist', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'aurous-workspace-root-'));
    expect(await findProjectRoot(cwd)).toBeUndefined();
    expect(await resolveWorkspaceRoot(cwd)).toBe(await realpath(cwd));
  });

  it('refreshes bounded, deterministic project context and exports prompt-ready safe files', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'aurous-context-pack-v1-'));
    await writeFile(
      path.join(root, 'README.md'),
      '# Demo\n\nA compact project summary with API_KEY=should-not-export.\n',
    );
    await writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({
        name: 'demo',
        description: 'A TypeScript demo.',
        scripts: { check: 'vitest run', build: 'tsc' },
        devDependencies: { typescript: '1', vitest: '1' },
      }),
    );
    await mkdir(path.join(root, 'node_modules'), { recursive: true });
    await writeFile(path.join(root, 'node_modules', 'ignored.md'), 'unbounded secret content');
    const store = new ContextPackStore(root);
    const first = await store.loadOrCreate();
    const refreshed = await store.refresh();
    expect(refreshed.project.technology).toEqual(['TypeScript', 'Vitest']);
    expect(refreshed.project.commands).toEqual(['npm run build', 'npm run check']);
    expect(refreshed.project.summary).not.toContain('should-not-export');
    expect(refreshed.destinations).toEqual(first.destinations);
    const exported = await store.export();
    const markdown = await readFile(exported.markdownPath, 'utf8');
    const json = await readFile(exported.jsonPath, 'utf8');
    expect(markdown).toContain('does not authorize writes');
    expect(markdown).not.toContain('should-not-export');
    expect(json).not.toContain('unbounded secret content');
    expect(renderContextPackMarkdown(exported.pack)).toBe(markdown);
  });
});
