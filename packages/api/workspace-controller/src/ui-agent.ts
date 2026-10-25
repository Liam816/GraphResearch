/** Generic UI management tools mounted in every Agent scope, including research and delegated conversations. */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from './index.ts'

/** Required module registry owner and scoped tool registry. */
export const inject = ['workspaceController', 'tools']

/**
 * Make registered UI modules discoverable and controllable through logged tool calls.
 * @param ctx - the Agent's scoped Context.
 */
export function apply(ctx: Context): void {
  const modules = ctx.workspaceController.uiModules
  const output = { schema: { type: 'string' as const }, render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }] }
  ctx.tools.register(defineTool({
    name: 'ui_capabilities', description: 'Discover available interface management modules and their target/change schemas. Use these registered operations when asked to organize the research interface. Read current state before changing it; modules enforce their own ownership and conflict checks.',
    parameters: {}, output,
    execute: () => Promise.resolve(JSON.stringify(modules.list())),
  }))
  ctx.tools.register(defineTool({
    name: 'ui_read', description: 'Read a registered interface module before changing it. Discover module names and argument schemas with ui_capabilities.',
    parameters: {
      module: { type: 'string', required: true, description: 'Registered module name from ui_capabilities.' },
      target: { type: 'json', required: true, description: 'Target object matching the module targetSchema.' },
    }, output,
    async execute(args, exec) {
      return JSON.stringify(await modules.read(args.module, args.target, { sessionId: exec.agent?.session.id, signal: exec.signal }))
    },
  }))
  ctx.tools.register(defineTool({
    name: 'ui_update', description: 'Apply a registered interface operation and return confirmed state. First use ui_capabilities and ui_read. Supply the observed state required by the module; after a conflict reread and merge instead of overwriting other changes. This cannot execute arbitrary browser code.',
    parameters: {
      module: { type: 'string', required: true, description: 'Registered module name from ui_capabilities.' },
      target: { type: 'json', required: true, description: 'Target object matching the module targetSchema.' },
      change: { type: 'json', required: true,
        description: 'Update object matching changeSchema, including required stale-state checks.' },
    }, output,
    async execute(args, exec) {
      return JSON.stringify(await modules.update(args.module, args.target, args.change, {
        sessionId: exec.agent?.session.id, signal: exec.signal,
      }))
    },
  }))
}
