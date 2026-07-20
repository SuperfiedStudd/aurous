import type { AgentName } from '../../domain/schemas.js';
import { AurousError } from '../../core/errors.js';
import { ClaudeAgentAdapter } from './claude.js';
import { CodexAgentAdapter } from './codex.js';
import { MockAgentAdapter } from './mock.js';
import type { AgentAdapter } from './types.js';

export function createAgentAdapter(name: AgentName): AgentAdapter {
  switch (name) {
    case 'codex':
      return new CodexAgentAdapter();
    case 'claude':
      return new ClaudeAgentAdapter();
    case 'mock':
      return new MockAgentAdapter();
    default:
      throw new AurousError({
        code: 'AUR-AGENT-006',
        summary: `Unsupported agent: ${String(name)}`,
        probableCause: 'The saved configuration names an adapter this version does not support.',
        nextAction: 'Choose codex, claude, or mock.',
      });
  }
}

export type { AgentAdapter, AgentDiagnostic, AgentDiagnoseOptions } from './types.js';
export {
  inspectCodexModelsCache,
  repairCodexModelsCache,
  runCodexPreflight,
  isCodexModelsCacheSchemaError,
  CODEX_MODEL_CACHE_REQUIRED_FIELDS,
} from './codex-cache.js';
export {
  detectAgentModelCatalogs,
  formatAgentModelsHelp,
  detectCodexModelCatalog,
  detectClaudeModelCatalog,
} from './model-catalog.js';
