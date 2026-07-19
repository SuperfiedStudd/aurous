#!/usr/bin/env node
import { createCli } from './cli.js';
import { asAurousError } from './core/errors.js';
import { consoleOutput, formatError } from './core/output.js';

try {
  await createCli().parseAsync(process.argv);
} catch (error) {
  const classified = asAurousError(error);
  consoleOutput.error(formatError(classified));
  process.exitCode = 1;
}
