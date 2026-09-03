import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { mountAutoRoutesFromEntries } from '../src/index'

describe('Entries Mode', () => {
  test('basic routing', async () => {
    const app = new Hono()
    const entries = {
      '/src/routes/route.ts': { default: new Hono().get('/', (c) => c.text('index')) },
      '/src/routes/users/route.ts': { default: new Hono().get('/', (c) => c.text('users')) },
    }

    await mountAutoRoutesFromEntries(app, entries, { virtualRoot: '/src/routes' })

    const res1 = await app.request('http://localhost/')
    expect(await res1.text()).toBe('index')

    const res2 = await app.request('http://localhost/users')
    expect(await res2.text()).toBe('users')
  })

  test('nested routes', async () => {
    const app = new Hono()
    const entries = {
      '/src/routes/api/v1/posts/route.ts': { default: new Hono().get('/', (c) => c.text('posts')) },
    }

    await mountAutoRoutesFromEntries(app, entries, { virtualRoot: '/src/routes' })

    const res = await app.request('http://localhost/api/v1/posts')
    expect(await res.text()).toBe('posts')
  })

  test('middleware application', async () => {
    const app = new Hono()
    const entries = {
      '/src/routes/middleware.ts': {
        default: async (c, next) => {
          c.header('x-root', 'ok')
          await next()
        },
      },
      '/src/routes/protected/middleware.ts': {
        default: async (c, next) => {
          c.header('x-protected', 'ok')
          await next()
        },
      },
      '/src/routes/protected/data/route.ts': {
        default: new Hono().get('/', (c) => c.text('data')),
      },
    }

    await mountAutoRoutesFromEntries(app, entries, { virtualRoot: '/src/routes' })

    const res = await app.request('http://localhost/protected/data')
    expect(res.headers.get('x-root')).toBe('ok')
    expect(res.headers.get('x-protected')).toBe('ok')
    expect(await res.text()).toBe('data')
  })

  test('supports a trailing slash in virtualRoot for root-level files', async () => {
    const app = new Hono()
    const entries = {
      '/src/routes/middleware.ts': {
        default: async (c: any, next: any) => {
          c.header('x-root', 'ok')
          await next()
        },
      },
      '/src/routes/route.ts': {
        default: new Hono().get('/', (c) => c.text('index')),
      },
    }

    await mountAutoRoutesFromEntries(app, entries, { virtualRoot: '/src/routes/' })

    const res = await app.request('http://localhost/')
    expect(res.headers.get('x-root')).toBe('ok')
    expect(await res.text()).toBe('index')
  })

  test('route groups (folders in parentheses are ignored)', async () => {
    const app = new Hono()
    const entries = {
      '/src/routes/(app)/dashboard/route.ts': {
        default: new Hono().get('/', (c) => c.text('dashboard')),
      },
      '/src/routes/(api)/v1/users/route.ts': {
        default: new Hono().get('/', (c) => c.text('users')),
      },
    }

    await mountAutoRoutesFromEntries(app, entries, { virtualRoot: '/src/routes' })

    // Should be available at /dashboard, NOT /(app)/dashboard
    const res1 = await app.request('http://localhost/dashboard')
    expect(res1.status).toBe(200)
    expect(await res1.text()).toBe('dashboard')

    // Should be available at /v1/users
    const res2 = await app.request('http://localhost/v1/users')
    expect(res2.status).toBe(200)
    expect(await res2.text()).toBe('users')
  })

  test.each([
    ['first', 'app'],
    ['last', 'marketing'],
  ] as const)('applies %s strategy to grouped route collisions', async (strategy, expected) => {
    const app = new Hono()
    const entries = {
      '/src/routes/(app)/about/route.ts': {
        default: new Hono().get('/', (c) => c.text('app')),
      },
      '/src/routes/(marketing)/about/route.ts': {
        default: new Hono().get('/', (c) => c.text('marketing')),
      },
    }

    await mountAutoRoutesFromEntries(app, entries, {
      virtualRoot: '/src/routes',
      duplicateStrategy: strategy,
      logger: {},
    })

    const res = await app.request('http://localhost/about')
    expect(await res.text()).toBe(expected)
  })

  test.each([
    ['first', 'app'],
    ['last', 'admin'],
  ] as const)(
    'applies %s strategy to grouped middleware collisions',
    async (strategy, expected) => {
      const app = new Hono()
      const entries = {
        '/src/routes/(app)/middleware.ts': {
          default: async (c: any, next: any) => {
            c.header('x-group', 'app')
            await next()
          },
        },
        '/src/routes/(admin)/middleware.ts': {
          default: async (c: any, next: any) => {
            c.header('x-group', 'admin')
            await next()
          },
        },
        '/src/routes/route.ts': {
          default: new Hono().get('/', (c) => c.text('index')),
        },
      }

      await mountAutoRoutesFromEntries(app, entries, {
        virtualRoot: '/src/routes',
        duplicateStrategy: strategy,
        logger: {},
      })

      const res = await app.request('http://localhost/')
      expect(res.headers.get('x-group')).toBe(expected)
    },
  )

  test('middleware ordering (parent before child)', async () => {
    const app = new Hono()
    const entries = {
      '/src/routes/middleware.ts': {
        default: async (c: any, next: any) => {
          const order = c.get('mw-order') || []
          order.push('parent')
          c.set('mw-order', order)
          await next()
        },
      },
      '/src/routes/child/middleware.ts': {
        default: async (c: any, next: any) => {
          const order = c.get('mw-order') || []
          // Avoid double counting if middleware is mounted twice (exact matched + wildcard matched)
          if (!order.includes('child')) {
            order.push('child')
          }
          c.set('mw-order', order)
          await next()
        },
      },
      '/src/routes/child/route.ts': {
        default: new Hono().get('/', (c) => c.json({ order: c.get('mw-order') })),
      },
    }

    await mountAutoRoutesFromEntries(app, entries, { virtualRoot: '/src/routes' })

    const res = await app.request('http://localhost/child')
    const data = (await res.json()) as { order: string[] }
    expect(data.order).toEqual(['parent', 'child'])
  })

  test('duplicate strategy (last wins)', async () => {
    const app = new Hono()
    const entries = {
      '/src/routes/test/route.ts': { default: new Hono().get('/', (c) => c.text('first')) },
      '/src/routes/test/route.mjs': { default: new Hono().get('/', (c) => c.text('last')) },
    }

    await mountAutoRoutesFromEntries(app, entries, {
      virtualRoot: '/src/routes',
      duplicateStrategy: 'last',
    })

    const res = await app.request('http://localhost/test')
    expect(await res.text()).toBe('last')
  })

  test('custom fileNames option', async () => {
    const app = new Hono()
    const entries = {
      '/src/routes/custom.ts': { default: new Hono().get('/', (c) => c.text('custom')) },
      '/src/routes/ignored.ts': { default: new Hono().get('/', (c) => c.text('ignored')) },
    }

    await mountAutoRoutesFromEntries(app, entries, {
      virtualRoot: '/src/routes',
      fileNames: ['custom.ts'],
    })

    const res1 = await app.request('http://localhost/')
    expect(await res1.text()).toBe('custom')

    const res2 = await app.request('http://localhost/ignored')
    expect(res2.status).toBe(404)
  })
})
