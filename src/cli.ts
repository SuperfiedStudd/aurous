import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { Command } from 'commander';
import { AgentNameSchema, ToolNameSchema } from './domain/schemas.js';
import { AurousServices } from './core/services.js';
import { LocalRunStore } from './core/run-store.js';
import { consoleOutput, type Output } from './core/output.js';
import { formatApprovalPrompt } from './core/presentation.js';
import { AurousShell, type ShellIO } from './core/shell.js';

export interface CliDependencies {
  cwd?: string;
  output?: Output;
  confirm?: (question: string, expected?: string) => Promise<boolean>;
  shellIO?: ShellIO;
}

export function createCli(dependencies: CliDependencies = {}): Command {
  const cwd = dependencies.cwd ?? process.cwd();
  const cliOutput = dependencies.output ?? consoleOutput;
  const store = new LocalRunStore(cwd);
  const services = new AurousServices({
    workspace: cwd,
    store,
    output: cliOutput,
  });
  const confirm = dependencies.confirm ?? confirmInTerminal;
  const program = new Command();
  program
    .name('aurous')
    .description(
      'Plan and build productivity workspaces through your local AI agent and configured MCPs.',
    )
    .version('0.1.0')
    .action(async () => {
      await launchShell();
    });

  const launchShell = async () => {
    await new AurousShell({
      workspace: cwd,
      store,
      services,
      output: cliOutput,
      ...(dependencies.shellIO ? { io: dependencies.shellIO } : {}),
    }).run();
  };

  program
    .command('shell')
    .description('Open the persistent interactive Aurous shell.')
    .action(async () => {
      await launchShell();
    });

  program
    .command('init')
    .description('Initialize local Aurous state (never stores credentials).')
    .option('--agent <agent>', 'default agent: codex, claude, or mock')
    .option('--tool <tool>', 'default tool: notion, linear, or mock')
    .option('--timeout <seconds>', 'agent timeout in seconds', parsePositiveNumber)
    .action(async (options: { agent?: string; tool?: string; timeout?: number }) => {
      const config = {
        ...(options.agent ? { defaultAgent: AgentNameSchema.parse(options.agent) } : {}),
        ...(options.tool ? { defaultTool: ToolNameSchema.parse(options.tool) } : {}),
        ...(options.timeout ? { timeoutMs: options.timeout * 1_000 } : {}),
      };
      await services.init(config);
    });

  program
    .command('doctor')
    .description('Check Node, local agent authentication, and MCP readiness.')
    .option('--verbose', 'show readiness details')
    .action(async (options: { verbose?: boolean }) => {
      await services.doctor(Boolean(options.verbose));
    });

  program
    .command('plan')
    .description('Create and save a validated read-only workspace plan.')
    .option('--agent <agent>', 'agent: codex, claude, or mock')
    .option('--tool <tool>', 'productivity tool: notion, linear, or mock')
    .requiredOption('--context <paths...>', 'one or more explicit context paths')
    .requiredOption('--prompt <objective>', 'desired productivity workspace outcome')
    .option('--timeout <seconds>', 'override agent timeout in seconds', parsePositiveNumber)
    .action(
      async (options: {
        agent?: string;
        tool?: string;
        context: string[];
        prompt: string;
        timeout?: number;
      }) => {
        const controller = cancellationController();
        await services.plan({
          ...(options.agent ? { agent: options.agent } : {}),
          ...(options.tool ? { tool: options.tool } : {}),
          contextPaths: options.context,
          objective: options.prompt,
          ...(options.timeout ? { timeoutMs: options.timeout * 1_000 } : {}),
          signal: controller.signal,
        });
      },
    );

  program
    .command('apply <run-id>')
    .description('Preview and explicitly approve execution of a saved plan.')
    .option('--yes', 'explicitly confirm the preview for noninteractive use')
    .action(async (runId: string, options: { yes?: boolean }) => {
      const controller = cancellationController();
      await services.apply(runId, {
        confirmed: Boolean(options.yes),
        ...(!options.yes
          ? {
              confirm: () =>
                confirm('Execute exactly this saved plan through the configured MCP?', 'apply'),
            }
          : {}),
        signal: controller.signal,
      });
    });

  program
    .command('linear-demo')
    .description('Plan, preview, approve, and execute the polished Linear demo in one command.')
    .option('--agent <agent>', 'agent: codex, claude, or mock')
    .requiredOption('--team <team>', 'existing Linear team name, key, or UUID')
    .requiredOption('--context <paths...>', 'structured Linear demo preset context')
    .option('--yes', 'explicitly confirm the printed preview for noninteractive use')
    .action(async (options: { agent?: string; team: string; context: string[]; yes?: boolean }) => {
      const controller = cancellationController();
      const plan = await services.planLinearDemo({
        ...(options.agent ? { agent: options.agent } : {}),
        team: options.team,
        contextPaths: options.context,
      });
      await services.apply(plan.runId, {
        confirmed: Boolean(options.yes),
        alreadyPreviewed: true,
        ...(!options.yes
          ? {
              confirm: () =>
                confirm('Execute exactly this Linear plan through the official MCP?', 'apply'),
            }
          : {}),
        signal: controller.signal,
      });
    });

  program
    .command('recover <run-id>')
    .description(
      'Inspect a partial run read-only, or explicitly apply a separately saved recovery plan.',
    )
    .option('--apply', 'apply this saved recovery plan after preview and typed confirmation')
    .action(async (runId: string, options: { apply?: boolean }) => {
      const controller = cancellationController();
      if (!options.apply) {
        await services.recover(runId, { signal: controller.signal });
        return;
      }
      const expected = `recover ${runId}`;
      await services.applyRecovery(runId, {
        confirm: () =>
          confirm('Execute exactly this recovery plan through the configured MCP?', expected),
        signal: controller.signal,
      });
    });

  program
    .command('runs')
    .description('List saved local runs.')
    .action(async () => {
      await services.runs();
    });

  program
    .command('diagnose <run-id>')
    .description('Print a redacted, shareable diagnostic report for a run.')
    .option('--verbose', 'include redacted command metadata')
    .action(async (runId: string, options: { verbose?: boolean }) =>
      services.diagnoseRun(runId, Boolean(options.verbose)),
    );

  return program;
}

async function confirmInTerminal(question: string, expected = 'apply'): Promise<boolean> {
  if (!input.isTTY || !output.isTTY) return false;
  const reader = createInterface({ input, output });
  try {
    return (
      (await reader.question(formatApprovalPrompt(question, expected))).trim().toLowerCase() ===
      expected.toLowerCase()
    );
  } finally {
    reader.close();
  }
}

function parsePositiveNumber(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error('Expected a positive number.');
  return parsed;
}

function cancellationController(): AbortController {
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort());
  return controller;
}
