import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { execa } from 'execa';
import type { ContextBundle, ContextFile } from '../domain/schemas.js';
import { AurousError } from './errors.js';

const excludedDirectories = new Set([
  '.git',
  '.aurous',
  '.claude',
  '.codex',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.next',
  '.nuxt',
  'out',
  'target',
  'vendor',
  '.trash',
  '.cache',
  'cache',
  'caches',
  'library',
  '.config',
  '.ssh',
  '.aws',
  '.gnupg',
]);
const excludedFileNames = new Set([
  '.mcp.json',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
]);
const excludedExtensions = new Set([
  '.env',
  '.key',
  '.pem',
  '.p12',
  '.pfx',
  '.jks',
  '.keystore',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.pdf',
  '.zip',
  '.gz',
  '.tar',
  '.7z',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.mp3',
  '.mp4',
  '.mov',
  '.wasm',
]);
const sourceExtensions = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.go',
  '.rs',
  '.java',
  '.kt',
  '.swift',
  '.rb',
  '.php',
  '.cs',
  '.cpp',
  '.c',
  '.h',
  '.css',
  '.scss',
  '.html',
  '.vue',
  '.svelte',
]);
const documentationExtensions = new Set(['.md', '.mdx', '.rst', '.txt', '.adoc']);
const configurationExtensions = new Set([
  '.json',
  '.jsonc',
  '.yaml',
  '.yml',
  '.toml',
  '.ini',
  '.conf',
]);
const manifestNames = new Set([
  'package.json',
  'pyproject.toml',
  'cargo.toml',
  'go.mod',
  'pom.xml',
  'build.gradle',
  'gemfile',
  'composer.json',
]);

export interface ContextIngestionOptions {
  cwd: string;
  paths: string[];
  maxFileBytes?: number;
  maxTotalBytes?: number;
  maxFiles?: number;
}

export interface InlineContextOptions {
  cwd: string;
  content: string;
  label?: string;
  maxTotalBytes?: number;
}

/** Sentinel path label used when planning context was pasted into the shell. */
export const PASTED_CONTEXT_LABEL = 'pasted';

export function ingestInlineContext(options: InlineContextOptions): ContextBundle {
  const content = options.content.replace(/\r\n/g, '\n').trimEnd();
  if (!content.trim()) {
    throw new AurousError({
      code: 'AUR-CTX-001',
      summary: 'Pasted context cannot be empty.',
      probableCause: 'Paste mode finished without any plain-text content.',
      nextAction: 'Run /context again, paste notes, then finish with /done.',
    });
  }
  const maxTotalBytes = options.maxTotalBytes ?? 512 * 1024;
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > maxTotalBytes) {
    throw new AurousError({
      code: 'AUR-CTX-001',
      summary: 'Pasted context exceeds the total context budget.',
      probableCause: `The paste was ${bytes} bytes; the limit is ${maxTotalBytes} bytes.`,
      nextAction: 'Paste a shorter note, or save the content to a file and use /context <file-path>.',
    });
  }
  const relativePath = options.label ?? 'pasted-context.md';
  const absolutePath = path.join(options.cwd, '.aurous', relativePath);
  return {
    summary: {
      approvedPaths: [absolutePath],
      files: [
        {
          path: absolutePath,
          relativePath,
          bytes,
          category: 'documentation',
        },
      ],
      fileCount: 1,
      totalBytes: bytes,
      skipped: [],
    },
    documents: [{ path: absolutePath, relativePath, content }],
  };
}

export async function ingestContext(options: ContextIngestionOptions): Promise<ContextBundle> {
  if (options.paths.length === 0) {
    throw new AurousError({
      code: 'AUR-CTX-001',
      summary: 'At least one context path is required.',
      probableCause: 'No --context option was provided.',
      nextAction: 'Pass one or more explicit paths, for example "--context .".',
    });
  }

  const maxFileBytes = options.maxFileBytes ?? 128 * 1024;
  const maxTotalBytes = options.maxTotalBytes ?? 512 * 1024;
  const maxFiles = options.maxFiles ?? 100;
  const approvedPaths: string[] = [];
  const files: ContextFile[] = [];
  const documents: ContextBundle['documents'] = [];
  const skipped: string[] = [];
  let totalBytes = 0;

  for (const input of [...new Set(options.paths)]) {
    const requested = path.resolve(options.cwd, input);
    let requestedStat;
    try {
      requestedStat = await lstat(requested);
    } catch (error) {
      throw new AurousError({
        code: 'AUR-CTX-002',
        summary: `Context path does not exist: ${input}`,
        probableCause: 'The path was mistyped or moved.',
        nextAction: 'Provide an existing file or directory with --context.',
        cause: error,
      });
    }
    if (requestedStat.isSymbolicLink()) {
      skipped.push(`${input} (symbolic link)`);
      continue;
    }
    const root = await realpath(requested);
    approvedPaths.push(root);
    const candidates = requestedStat.isDirectory() ? await walk(root, skipped) : [root];
    for (const candidate of candidates.sort()) {
      if (files.length >= maxFiles || totalBytes >= maxTotalBytes) {
        skipped.push(
          `${path.relative(root, candidate) || path.basename(candidate)} (context limit reached)`,
        );
        continue;
      }
      const relativePath = requestedStat.isDirectory()
        ? path.relative(root, candidate) || path.basename(candidate)
        : path.basename(candidate);
      const classification = classifyFile(candidate, relativePath);
      if (!classification) {
        skipped.push(`${relativePath} (not selected)`);
        continue;
      }
      const stat = await lstat(candidate);
      if (!stat.isFile() || stat.size > maxFileBytes) {
        skipped.push(
          `${relativePath} (${stat.size > maxFileBytes ? 'too large' : 'not a regular file'})`,
        );
        continue;
      }
      const buffer = await readFile(candidate);
      if (buffer.includes(0)) {
        skipped.push(`${relativePath} (binary)`);
        continue;
      }
      const remaining = maxTotalBytes - totalBytes;
      if (buffer.byteLength > remaining) {
        skipped.push(`${relativePath} (total byte limit)`);
        continue;
      }
      const content = buffer.toString('utf8');
      totalBytes += buffer.byteLength;
      files.push({
        path: candidate,
        relativePath:
          approvedPaths.length > 1 ? `${path.basename(root)}/${relativePath}` : relativePath,
        bytes: buffer.byteLength,
        category: classification,
      });
      documents.push({ path: candidate, relativePath, content });
    }
  }

  if (approvedPaths.length === 0) {
    throw new AurousError({
      code: 'AUR-CTX-003',
      summary: 'No safe context paths were approved.',
      probableCause: 'Every provided path was a symbolic link.',
      nextAction: 'Pass the real path to a project file or directory.',
    });
  }

  const git = await readGitSummary(approvedPaths[0]!);
  return {
    summary: {
      approvedPaths,
      files,
      fileCount: files.length,
      totalBytes,
      skipped: skipped.slice(0, 50),
      ...(git ? { git } : {}),
    },
    documents,
  };
}

async function walk(root: string, skipped: string[]): Promise<string[]> {
  const result: string[] = [];
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const candidate = path.join(directory, entry.name);
      const relative = path.relative(root, candidate);
      if (entry.isSymbolicLink()) {
        skipped.push(`${relative} (symbolic link)`);
      } else if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || excludedDirectories.has(entry.name.toLowerCase()))
          skipped.push(`${relative}/ (excluded directory)`);
        else await visit(candidate);
      } else if (entry.isFile()) {
        result.push(candidate);
      }
    }
  }
  await visit(root);
  return result;
}

function classifyFile(
  absolutePath: string,
  relativePath: string,
): ContextFile['category'] | undefined {
  const name = path.basename(absolutePath).toLowerCase();
  const extension = path.extname(name).toLowerCase();
  const segments = relativePath.toLowerCase().split(path.sep);
  if (
    excludedFileNames.has(name) ||
    name === '.env' ||
    name.startsWith('.env.') ||
    excludedExtensions.has(extension) ||
    /(credential|credentials|secret|secrets|id_rsa|id_ed25519|auth\.json|token)/i.test(name)
  ) {
    return undefined;
  }
  if (/^readme(?:\.|$)/i.test(name)) return 'readme';
  if (manifestNames.has(name)) return 'manifest';
  if (
    documentationExtensions.has(extension) ||
    segments.includes('docs') ||
    segments.includes('documentation')
  )
    return 'documentation';
  if (sourceExtensions.has(extension)) return 'source';
  if (
    configurationExtensions.has(extension) ||
    name.startsWith('.') ||
    /^(makefile|dockerfile|tsconfig|eslint|prettier|vite|vitest)/.test(name)
  )
    return 'configuration';
  return undefined;
}

async function readGitSummary(
  approvedPath: string,
): Promise<{ branch: string; recentCommits: string[] } | undefined> {
  const cwd = path.extname(approvedPath) ? path.dirname(approvedPath) : approvedPath;
  const root = await execa('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { reject: false });
  if (root.exitCode !== 0) return undefined;
  const [branch, log] = await Promise.all([
    execa('git', ['-C', cwd, 'branch', '--show-current'], { reject: false }),
    execa('git', ['-C', cwd, 'log', '-5', '--pretty=format:%h %s'], { reject: false }),
  ]);
  return {
    branch: branch.stdout.trim(),
    recentCommits: log.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean),
  };
}
