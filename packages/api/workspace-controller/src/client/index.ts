/** Workspace-specific adapter for the Gateway-owned snapshot stream lifecycle. */

import type { Context } from '@deepseek-ai/cordis'
import {
  RemoteSnapshotStream,
  RemoteStreamCarrierError,
  type ClientRemote,
} from '@deepseek-ai/dsh-api-gateway/client'
import type { WorkspaceFollowFrame, WorkspaceFollowIncrement } from '../types.ts'
import type { WorkspaceFollowSink } from './model.ts'
import { ClientWorkspaceModel } from './model.ts'
import { WorkspaceController } from './service.ts'
import { ClientResearchModel } from './research.ts'
import type { ResearchFollowFrame } from '../research-types.ts'

export { ClientWorkspaceModel } from './model.ts'
export { ClientResearchModel } from './research.ts'
export type { ResearchSnapshot } from './research.ts'
export type * from '../research-types.ts'
export type * from '../research-translation-types.ts'
export type {
  WorkspaceFollowSink, WorkspaceListPhase, WorkspaceRemote, WorkspaceSnapshot,
} from './model.ts'
export { WorkspaceArchiveError, WorkspaceController, WorkspaceCreateError } from './service.ts'
export type { IWorkspaces, WorkspaceSource } from './service.ts'
export type {
  SessionActivity, SessionActivityItem, SessionActivityKind, SessionActivityKindMap, WorkspaceId,
  WorkspaceView,
} from '../types.ts'

type WorkspaceBaselineFrame = Extract<WorkspaceFollowFrame, { type: 'baseline' }>

/** Gateway-owned snapshot stream configured for Workspace state. */
export type WorkspaceStateStream = RemoteSnapshotStream<
  WorkspaceBaselineFrame,
  WorkspaceFollowIncrement
>

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** React-free Client Workspace state and commands. */
    workspaces: import('./service.ts').IWorkspaces
    /** Durable research entities and notebook commands. */
    research: ClientResearchModel
  }
}

/** Required Client Remote services. */
export const inject = ['remote', 'remote.workspace']

/**
 * Install Client Workspace state, commands, and reconnecting follow control.
 * @param ctx - Client root Context.
 */
export function apply(ctx: Context): void {
  const model = new ClientWorkspaceModel(ctx.remote.workspace)
  new WorkspaceController(ctx, model)
  const research = new ClientResearchModel(ctx.remote.workspace)
  ctx.effect(() => ctx.reflect.provide('research', research))
  const researchStream = ctx.remote.$stream<ResearchFollowFrame>({
    name: 'Research library stream', open: signal => ctx.remote.workspace.researchFollow(signal),
    ended: accepted => accepted ? new RemoteStreamCarrierError('Research library stream ended') : new Error('Research stream ended before its baseline'),
    carrierFailed: () => { research.failed() },
  })
  const researchControl = new RemoteSnapshotStream<Extract<ResearchFollowFrame, { type: 'baseline' }>, Exclude<ResearchFollowFrame, { type: 'baseline' }>>(researchStream, {
    name: 'Research library stream',
    isSnapshot: (frame): frame is Extract<ResearchFollowFrame, { type: 'baseline' }> => frame.type === 'baseline',
    replace: (frame) => { research.replace(frame.catalog) },
    update: (frame) => { if (frame.type === 'changed') research.accept(frame.catalog); else research.failed() },
    failed: () => { research.failed() },
  })
  researchControl.start()
  ctx.effect(() => async () => { await researchControl.dispose() }, 'workspace-controller.client.research')
  const control = createWorkspaceStateStream(ctx.remote, {
    accept: model,
    carrierFailed: () => { model.handleCarrierFailure() },
    failed: (error) => { model.handleStreamFailure(error) },
  })
  control.start()
  ctx.effect(
    () => async () => { await control.dispose() },
    'workspace-controller.client.control',
  )
}

/** Domain sinks used by the Workspace state stream. */
export interface WorkspaceStateStreamOptions {
  /** Destinations for decoded Workspace state operations. */
  readonly accept: WorkspaceFollowSink
  /** Observe a retryable carrier loss before reconnection. */
  readonly carrierFailed?: (error: RemoteStreamCarrierError) => void
  /** Publish a terminal business or protocol failure. */
  readonly failed: (error: unknown) => void
}

/**
 * Create the reconnecting Workspace state stream.
 * @param remote - Client Remote face carrying the Workspace namespace and the stream factory.
 * @param options - Workspace state destinations.
 * @returns an unstarted stream owned by the Client Workspace runtime.
 */
export function createWorkspaceStateStream(
  remote: ClientRemote,
  options: WorkspaceStateStreamOptions,
): WorkspaceStateStream {
  const stream = remote.$stream<WorkspaceFollowFrame>({
    name: 'Workspace state stream',
    open: signal => remote.workspace.follow(signal),
    ended: accepted => accepted
      ? new RemoteStreamCarrierError('Workspace state stream ended without a terminal result')
      : new Error('Workspace state stream ended before its opening snapshot'),
    ...(options.carrierFailed === undefined ? {} : { carrierFailed: options.carrierFailed }),
  })
  return new RemoteSnapshotStream<WorkspaceBaselineFrame, WorkspaceFollowIncrement>(stream, {
    name: 'Workspace state stream',
    isSnapshot: (frame): frame is WorkspaceBaselineFrame => frame.type === 'baseline',
    replace: (frame) => { options.accept.replaceBaseline(frame.value) },
    update: (frame) => { acceptIncrement(options.accept, frame) },
    failed: options.failed,
  })
}

function acceptIncrement(accept: WorkspaceFollowSink, frame: WorkspaceFollowIncrement): void {
  switch (frame.type) {
    case 'upsert':
      accept.upsertView(frame.workspace)
      return
    case 'remove':
      accept.removeView(frame.workspaceId)
      return
    case 'order':
      accept.replaceOrder(frame.workspaceIds)
      return
    case 'archived':
      accept.replaceArchived(frame.archivedSessionIds)
      return
    case 'pinned':
      accept.replacePinned(frame.pinnedSessionIds)
      return
    /* v8 ignore next -- the generated Remote codec validates this closed union */
    default:
      return assertNever(frame)
  }
}

/* v8 ignore next 3 -- closed-union backstop after generated Remote validation */
function assertNever(value: never): never {
  throw new Error(`unreachable Workspace increment: ${JSON.stringify(value)}`)
}
