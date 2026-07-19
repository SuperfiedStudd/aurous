import type { ToolName } from '../../domain/schemas.js';
import { AurousError } from '../../core/errors.js';
import { LinearAdapter } from './linear.js';
import { MockProductivityAdapter } from './mock.js';
import { NotionAdapter } from './notion.js';
import type { ProductivityAdapter } from './types.js';

export function createProductivityAdapter(name: ToolName): ProductivityAdapter {
  switch (name) {
    case 'notion':
      return new NotionAdapter();
    case 'linear':
      return new LinearAdapter();
    case 'mock':
      return new MockProductivityAdapter();
    default:
      throw new AurousError({
        code: 'AUR-TOOL-001',
        summary: `Unsupported productivity tool: ${String(name)}`,
        probableCause: 'The saved configuration names an adapter this version does not support.',
        nextAction: 'Choose notion, linear, or mock.',
      });
  }
}
