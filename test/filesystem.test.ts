import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { Hono } from 'hono'
import { mountAutoRoutes } from '../src/index'

describe('Filesystem Mode', () => {
  let tmpDir: string
  let routesDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hono-autoroutes-test-'))
    routesDir = path.join(tmpDir, 'routes')
    await fs.mkdir(routesDir, { recursive: true })
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  test('walks directory and mounts routes', async () => {
    await fs.mkdir(path.join(routesDir, 'users'), { recursive: true })

    // Create route.ts
    // Use proper export format for the file content
    const routeContent = `
      export function register(app) {
        app.get('/', (c) => c.text('users-index'));
      }
    `
    await fs.writeFile(path.join(routesDir, 'users', 'route.ts'), routeContent)

    const app = new Hono()
    await mountAutoRoutes(app, { rootDir: routesDir })

    const res = await app.request('http://localhost/users')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('users-index')
  })

  test('does not fall back to filesystem discovery when entries is empty', async () => {
    await fs.mkdir(path.join(routesDir, 'filesystem-only'), { recursive: true })
    await fs.writeFile(
      path.join(routesDir, 'filesystem-only', 'route.mjs'),
      `export function register(app) { app.get('/', (c) => c.text('unexpected')) }`,
    )

    const app = new Hono()
    const stats = await mountAutoRoutes(app, { rootDir: routesDir, entries: {}, silent: true })

    expect((await app.request('http://localhost/filesystem-only')).status).toBe(404)
    expect(stats.routes.mounted).toBe(0)
  })

  test('supports route groups in filesystem', async () => {
    await fs.mkdir(path.join(routesDir, '(admin)', 'settings'), { recursive: true })

    const routeContent = `
      export function register(app) {
        app.get('/', (c) => c.text('admin-settings'));
      }
    `
    await fs.writeFile(path.join(routesDir, '(admin)', 'settings', 'route.ts'), routeContent)

    const app = new Hono()
    await mountAutoRoutes(app, { rootDir: routesDir })

    // Should be at /settings, NOT /(admin)/settings
    const res = await app.request('http://localhost/settings')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('admin-settings')
  })

  test.each([
    ['first', 'app'],
    ['last', 'marketing'],
  ] as const)(
    'resolves grouped route collisions deterministically with %s strategy',
    async (strategy, expected) => {
      await fs.mkdir(path.join(routesDir, '(app)', 'about'), { recursive: true })
      await fs.mkdir(path.join(routesDir, '(marketing)', 'about'), { recursive: true })

      await fs.writeFile(
        path.join(routesDir, '(app)', 'about', 'route.mjs'),
        `export function register(app) { app.get('/', (c) => c.text('app')) }`,
      )
      await fs.writeFile(
        path.join(routesDir, '(marketing)', 'about', 'route.mjs'),
        `export function register(app) { app.get('/', (c) => c.text('marketing')) }`,
      )

      const app = new Hono()
      await mountAutoRoutes(app, {
        rootDir: routesDir,
        duplicateStrategy: strategy,
        logger: {},
      })

      const res = await app.request('http://localhost/about')
      expect(await res.text()).toBe(expected)
    },
  )
})
