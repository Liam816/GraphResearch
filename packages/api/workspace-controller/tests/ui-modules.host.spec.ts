/** Module registration lifetimes, schema admission and committed state belong to the provider. */
import { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { expect, it, vi } from 'vitest'
import { UiModuleRegistry } from '../src/ui-modules.ts'

function input<T>(schema: z.ZodType<T>) { return { jsonSchema: z.toJSONSchema(schema), parse: (value: unknown) => schema.parse(value) } }

it('discovers a module dynamically and removes it when its contributing plugin unloads', async () => {
  const ctx = new Context(), modules = new UiModuleRegistry()
  let count = 0
  const module = {
    name: 'fixture.canvas', description: 'Fixture canvas state',
    target: input(z.strictObject({ id: z.string() })), change: input(z.strictObject({ expected: z.number(), count: z.number() })),
    read: async () => ({ count }),
    update: async (_target: { id: string }, change: { expected: number; count: number }) => {
      if (count !== change.expected) throw new Error('stale state')
      count = change.count
      return { count }
    },
  }
  const fiber = await ctx.plugin({ apply: (owner: Context) => { owner.effect(() => modules.register(module)) } })
  const call = { sessionId: undefined, signal: new AbortController().signal }
  expect(modules.list()).toMatchObject([{ name: 'fixture.canvas', targetSchema: { additionalProperties: false } }])
  expect(() => modules.register(module)).toThrow('already registered')
  await expect(modules.read('fixture.canvas', { id: 'canvas' }, call)).resolves.toEqual({ count: 0 })
  await expect(modules.update('fixture.canvas', { id: 'canvas' }, { expected: 0, count: 2 }, call)).resolves.toEqual({ count: 2 })
  await expect(modules.update('fixture.canvas', { id: 'canvas' }, { expected: 0, count: 4 }, call)).rejects.toThrow('stale state')
  await fiber.dispose()
  expect(modules.list()).toEqual([])
  await expect(modules.read('fixture.canvas', { id: 'canvas' }, call)).rejects.toMatchObject({ code: 'ui/module-not-found' })
  await ctx.fiber.dispose()
})

it('rejects unknown modules, invalid targets, invalid changes and cancellation before invoking a handler', async () => {
  const modules = new UiModuleRegistry()
  const update = vi.fn(async () => ({ saved: true }))
  const dispose = modules.register({ name: 'fixture', description: 'Schema admission',
    target: input(z.strictObject({ id: z.string() })), change: input(z.strictObject({ count: z.number() })),
    read: async () => ({}), update,
  })
  const call = { sessionId: undefined, signal: new AbortController().signal }
  await expect(modules.update('missing', { id: 'x' }, { count: 1 }, call)).rejects.toMatchObject({ code: 'ui/module-not-found' })
  await expect(modules.update('fixture', { id: 1 }, { count: 1 }, call)).rejects.toMatchObject({ code: 'ui/invalid-arguments' })
  await expect(modules.update('fixture', { id: 'x' }, { count: '1' }, call)).rejects.toMatchObject({ code: 'ui/invalid-arguments' })
  await expect(modules.update('fixture', { id: 'x' }, { count: 1, extra: true }, call)).rejects.toMatchObject({ code: 'ui/invalid-arguments' })
  await expect(modules.update('fixture', { id: 'x' }, { count: 1 }, { ...call, signal: AbortSignal.abort() })).rejects.toThrow()
  expect(update).not.toHaveBeenCalled()
  dispose()
})
