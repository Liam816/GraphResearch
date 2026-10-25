/** Explicit, validated UI management modules available to both people and Agents. */
import type { z } from 'zod'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** JSON values returned by a module and recorded in tool results. */
export type UiModuleValue = z.core.util.JSONType

/** A provider's JSON Schema and matching input validator. */
export interface UiModuleInput<T> {
  readonly jsonSchema: Record<string, unknown>
  /** Reject invalid tool JSON before it reaches the operation. */
  parse: (value: unknown) => T
}

/** Calling conversation and cancellation; a module owns authorization and commit semantics. */
export interface UiModuleContext {
  readonly sessionId: SessionId | undefined
  readonly signal: AbortSignal
}

/** A module exposes JSON state and a validated update, never arbitrary browser execution. */
export interface UiModule<Target, Change> {
  readonly name: string
  readonly description: string
  readonly target: UiModuleInput<Target>
  readonly change: UiModuleInput<Change>
  /** Read current, authoritative state before constructing a change. */
  read: (target: Target, context: UiModuleContext) => Promise<UiModuleValue>
  /** Validate ownership and stale state, commit, then return the acknowledged state. */
  update: (target: Target, change: Change, context: UiModuleContext) => Promise<UiModuleValue>
}

/** Discoverable module instructions and machine-readable argument schemas. */
export interface UiModuleDescriptor {
  readonly name: string
  readonly description: string
  readonly targetSchema: Record<string, unknown>
  readonly changeSchema: Record<string, unknown>
}

/** Registry shared by all Agent scopes; providers retain ownership of persistence and notifications. */
export class UiModuleRegistry {
  private readonly modules = new Map<string, {
    descriptor: UiModuleDescriptor
    read: (target: unknown, context: UiModuleContext) => Promise<UiModuleValue>
    update: (target: unknown, change: unknown, context: UiModuleContext) => Promise<UiModuleValue>
  }>()

  /**
   * Register a module through the contributing plugin's ctx.effect.
   * @param module - validated operations and discovery metadata; duplicate names fail at load.
   * @returns disposer removing only this registration.
   */
  register<Target, Change>(module: UiModule<Target, Change>): () => void {
    if (this.modules.has(module.name)) throw new Error(`UI module already registered: ${module.name}`)
    const entry = {
      descriptor: { name: module.name, description: module.description,
        targetSchema: module.target.jsonSchema, changeSchema: module.change.jsonSchema },
      read: (target: unknown, context: UiModuleContext) => module.read(parse(module.target, target), context),
      update: (target: unknown, change: unknown, context: UiModuleContext) =>
        module.update(parse(module.target, target), parse(module.change, change), context),
    }
    this.modules.set(module.name, entry)
    return () => { if (this.modules.get(module.name) === entry) this.modules.delete(module.name) }
  }

  /** @returns current descriptors; newly mounted and disposed modules are immediately reflected. */
  list(): readonly UiModuleDescriptor[] { return [...this.modules.values()].map(entry => entry.descriptor) }

  /**
   * Read a registered module with validated target arguments.
   * @param name - discovered module name.
   * @param target - model/tool JSON validated by the provider's schema.
   * @param context - calling conversation and cancellation.
   * @returns authoritative module state.
   */
  async read(name: string, target: unknown, context: UiModuleContext): Promise<UiModuleValue> {
    context.signal.throwIfAborted()
    return this.require(name).read(target, context)
  }

  /**
   * Apply one explicit operation; the provider owns stale-state checks and publication.
   * @param name - discovered module name.
   * @param target - model/tool JSON validated before invoking the provider.
   * @param change - model/tool JSON validated before invoking the provider.
   * @param context - calling conversation and cancellation.
   * @returns confirmed module state; failures never claim completion.
   */
  async update(name: string, target: unknown, change: unknown, context: UiModuleContext): Promise<UiModuleValue> {
    context.signal.throwIfAborted()
    return this.require(name).update(target, change, context)
  }

  private require(name: string) {
    const module = this.modules.get(name)
    if (module === undefined) throw new RemoteError('ui/module-not-found', 'Read ui_capabilities to choose an available module', { name })
    return module
  }
}

function parse<T>(schema: UiModuleInput<T>, value: unknown): T {
  try { return schema.parse(value) }
  catch (error: unknown) {
    throw new RemoteError('ui/invalid-arguments', 'Read ui_capabilities and supply arguments matching the module schema', {}, { cause: error })
  }
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** A module is absent or was unloaded; discover the current set before retrying. */
    'ui/module-not-found': { readonly name: string }
    /** Model JSON does not match a registered module's target or update schema. */
    'ui/invalid-arguments': {}
  }
}
