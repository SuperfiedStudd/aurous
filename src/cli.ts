import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { Command } from 'commander';
import { AgentNameSchema, ToolNameSchema } from './domain/schemas.js';
import { AurousServices } from './core/services.js';
import { LocalRunStore } from './core/run-store.js';
import { consoleOutput, type Output } from './core/output.js';
import { formatApprovalPrompt } from './core/presentation.js';
import { AurousShell, createReadlineShellTerminal } from './core/shell.js';
import { DynamicShellRenderer, type ShellTerminal } from './core/shell-renderer.js';
import type { DestinationChoiceRequest } from './core/destination-resolver.js';
import { findProjectRoot } from './core/context-pack.js';
import { ContextPackStore, detectProjectRoot } from './core/context-pack.js';
import { formatAgentModelsHelp } from './adapters/agents/model-catalog.js';

export interface CliDependencies {
  cwd?: string;
  output?: Output;
  confirm?: (question: string, expected?: string) => Promise<boolean>;
  shellTerminal?: ShellTerminal;
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
      'Plan and build productivity workspaces through your local AI agent and connected integrations.',
    )
    .version('0.1.0')
    .action(async () => {
      await launchShell();
    });

  const launchShell = async () => {
    const projectRoot = await findProjectRoot(cwd);
    const shellWorkspace = projectRoot ?? cwd;
    const shellStore = new LocalRunStore(shellWorkspace);
    const terminal = dependencies.shellTerminal ?? createReadlineShellTerminal();
    const renderer = new DynamicShellRenderer(terminal);
    const shellServices = new AurousServices({
      workspace: shellWorkspace,
      store: shellStore,
      output: renderer,
    });
    await new AurousShell({
      workspace: shellWorkspace,
      ...(projectRoot ? { projectRoot } : {}),
      store: shellStore,
      services: shellServices,
      renderer,
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
    .option('--tool <tool>', 'default tool: notion, linear, airtable, trello, or mock')
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
    .option('--agent <agent>', 'limit checks to one agent: codex, claude, or mock')
    .option('--repair', 'attempt safe local repairs (Codex models-cache backup)')
    .option('--verbose', 'show readiness details')
    .action(async (options: { agent?: string; repair?: boolean; verbose?: boolean }) => {
      await services.doctor({
        verbose: Boolean(options.verbose),
        repair: Boolean(options.repair),
        ...(options.agent ? { agent: AgentNameSchema.parse(options.agent) } : {}),
      });
    });

  const contextCommand = program
    .command('context')
    .description('Inspect, refresh, or export the safe project Context Pack v1.');
  contextCommand.command('show').action(async () => {
    const pack = await new ContextPackStore(await detectProjectRoot(cwd)).loadOrCreate();
    cliOutput.log(JSON.stringify(pack, null, 2));
  });
  contextCommand.command('destinations').action(async () => {
    const pack = await new ContextPackStore(await detectProjectRoot(cwd)).loadOrCreate();
    cliOutput.log(JSON.stringify(pack.destinations, null, 2));
  });
  contextCommand.command('refresh').action(async () => {
    const pack = await new ContextPackStore(await detectProjectRoot(cwd)).refresh();
    cliOutput.log(`Refreshed Context Pack v1 at ${pack.updatedAt}`);
  });
  contextCommand.command('export').action(async () => {
    const exported = await new ContextPackStore(await detectProjectRoot(cwd)).export();
    cliOutput.log(`Exported ${exported.markdownPath}`);
    cliOutput.log(`Exported ${exported.jsonPath}`);
  });
  contextCommand.command('forget <integration>').action(async (integration: string) => {
    const pack = await new ContextPackStore(await detectProjectRoot(cwd)).forgetDestination(
      ToolNameSchema.parse(integration),
    );
    cliOutput.log(
      `Forgot ${integration}; active integrations: ${pack.activeIntegrations.join(', ') || 'none'}`,
    );
  });

  program
    .command('plan')
    .description('Create and save a validated read-only workspace plan.')
    .option('--agent <agent>', 'agent: codex, claude, or mock')
    .option('--tool <tool>', 'productivity tool: notion, linear, airtable, trello, or mock')
    .option('--model <model-or-alias>', 'exact model or alias forwarded to the selected agent')
    .requiredOption('--context <paths...>', 'one or more explicit context paths')
    .requiredOption('--prompt <objective>', 'desired productivity workspace outcome')
    .option('--timeout <seconds>', 'override agent timeout in seconds', parsePositiveNumber)
    .option('--destination-id <id>', 'advanced exact destination override')
    .option('--destination-url <url>', 'advanced destination URL override')
    .option('--destination-name <name>', 'friendly name for an advanced destination override')
    .option('--verbose', 'show exact resolved destination IDs in the preview')
    .action(
      async (options: {
        agent?: string;
        tool?: string;
        model?: string;
        context: string[];
        prompt: string;
        timeout?: number;
        destinationId?: string;
        destinationUrl?: string;
        destinationName?: string;
        verbose?: boolean;
      }) => {
        const controller = cancellationController();
        await services.plan({
          ...(options.agent ? { agent: options.agent } : {}),
          ...(options.tool ? { tool: options.tool } : {}),
          ...(options.model ? { model: options.model } : {}),
          contextPaths: options.context,
          objective: options.prompt,
          ...(options.timeout ? { timeoutMs: options.timeout * 1_000 } : {}),
          chooseDestination: chooseDestinationInTerminal,
          ...(destinationOverride(options)
            ? { destinationOverride: destinationOverride(options)! }
            : {}),
          verbose: Boolean(options.verbose),
          signal: controller.signal,
        });
      },
    );

  program
    .command('apply <run-id>')
    .description('Preview and explicitly approve execution of a saved plan.')
    .option('--yes', 'explicitly confirm the preview for noninteractive use')
    .option('--model <model-or-alias>', 'exact model or alias forwarded to the selected agent')
    .option('--verbose', 'show exact resolved destination IDs in the preview')
    .action(
      async (runId: string, options: { yes?: boolean; model?: string; verbose?: boolean }) => {
        const controller = cancellationController();
        await services.apply(runId, {
          confirmed: Boolean(options.yes),
          ...(options.model ? { model: options.model } : {}),
          ...(!options.yes
            ? {
                confirm: () =>
                  confirm('Apply exactly this saved plan to the connected integration?', 'apply'),
              }
            : {}),
          signal: controller.signal,
          verbose: Boolean(options.verbose),
        });
      },
    );

  program
    .command('linear-demo')
    .description('Plan, preview, approve, and execute the polished Linear demo in one command.')
    .option('--agent <agent>', 'agent: codex, claude, or mock')
    .option('--model <model-or-alias>', 'exact model or alias forwarded to the selected agent')
    .option('--team <name>', 'optional friendly team-name hint')
    .option('--destination-id <id>', 'advanced exact team override')
    .option('--destination-url <url>', 'advanced team URL override')
    .option('--destination-name <name>', 'friendly name for an advanced team override')
    .option('--verbose', 'show exact resolved destination IDs in the preview')
    .requiredOption('--context <paths...>', 'structured Linear demo preset context')
    .option('--yes', 'explicitly confirm the printed preview for noninteractive use')
    .action(
      async (options: {
        agent?: string;
        model?: string;
        team?: string;
        context: string[];
        yes?: boolean;
        destinationId?: string;
        destinationUrl?: string;
        destinationName?: string;
        verbose?: boolean;
      }) => {
        const controller = cancellationController();
        const plan = await services.planLinearDemo({
          ...(options.agent ? { agent: options.agent } : {}),
          ...(options.model ? { model: options.model } : {}),
          ...(options.team ? { team: options.team } : {}),
          contextPaths: options.context,
          chooseDestination: chooseDestinationInTerminal,
          ...(destinationOverride(options)
            ? { destinationOverride: destinationOverride(options)! }
            : {}),
          verbose: Boolean(options.verbose),
        });
        await services.apply(plan.runId, {
          confirmed: Boolean(options.yes),
          alreadyPreviewed: true,
          ...(options.model ? { model: options.model } : {}),
          ...(!options.yes
            ? {
                confirm: () =>
                  confirm('Apply exactly this Linear plan to the connected integration?', 'apply'),
              }
            : {}),
          signal: controller.signal,
        });
      },
    );

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

  program.addHelpText('after', () => {
    const lines = formatAgentModelsHelp();
    return `\n${lines.join('\n')}\n`;
  });

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

async function chooseDestinationInTerminal(
  request: DestinationChoiceRequest,
): Promise<number | undefined> {
  if (!input.isTTY || !output.isTTY) return undefined;
  const reader = createInterface({ input, output });
  try {
    output.write(
      `\n${request.question}\nAurous found ${request.candidates.length} available choices.\n\n`,
    );
    request.candidates.forEach((candidate, index) =>
      output.write(`${index + 1}. ${candidate.name}\n`),
    );
    while (true) {
      const answer = (
        await reader.question(`\nChoose 1–${request.candidates.length}, or type cancel: `)
      ).trim();
      if (answer.toLowerCase() === 'cancel') return undefined;
      const choice = Number(answer);
      if (Number.isInteger(choice) && choice >= 1 && choice <= request.candidates.length)
        return choice - 1;
    }
  } finally {
    reader.close();
  }
}

function destinationOverride(options: {
  destinationId?: string;
  destinationUrl?: string;
  destinationName?: string;
}): { id: string; name: string } | undefined {
  if (options.destinationId && options.destinationUrl)
    throw new Error('Choose either --destination-id or --destination-url, not both.');
  const identity = options.destinationId ?? options.destinationUrl;
  if (!identity && !options.destinationName) return undefined;
  if (!identity || !options.destinationName)
    throw new Error('--destination-name must accompany --destination-id or --destination-url.');
  return { id: identity, name: options.destinationName };
}
