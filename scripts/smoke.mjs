import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const tmp = await fs.mkdtemp(path.join(tmpdir(), 'hono-autoroutes-smoke-'))

try {
  const routesRoot = path.join(tmp, 'routes')
  const groupedRouteDir = path.join(routesRoot, '(app)', 'index')
  await fs.mkdir(groupedRouteDir, { recursive: true })

  const routeFile = path.join(groupedRouteDir, 'route.mjs')
  const middlewareFile = path.join(routesRoot, 'middleware.mjs')
  await fs.writeFile(
    routeFile,
    `export function register(app) { app.get('/', (c) => c.text('smoke-ok')) }`,
  )
  await fs.writeFile(
    middlewareFile,
    `export default async (c, next) => { c.header('x-smoke', 'ok'); await next() }`,
  )

  const libraryUrl = pathToFileURL(path.join(scriptDir, '..', 'dist', 'index.js')).href
  const { createAppWithAutoRoutes, mountAutoRoutesFromEntries } = await import(libraryUrl)

  const filesystemApp = await createAppWithAutoRoutes({ rootDir: routesRoot, logger: {} })
  const filesystemResponse = await filesystemApp.request('http://localhost/index')
  assert.equal(filesystemResponse.status, 200)
  assert.equal(await filesystemResponse.text(), 'smoke-ok')
  assert.equal(filesystemResponse.headers.get('x-smoke'), 'ok')

  const { Hono } = await import('hono')
  const entriesApp = new Hono()
  await mountAutoRoutesFromEntries(
    entriesApp,
    {
      '/virtual/routes/(app)/index/route.mjs': () => import(pathToFileURL(routeFile).href),
      '/virtual/routes/middleware.mjs': () => import(pathToFileURL(middlewareFile).href),
    },
    { virtualRoot: '/virtual/routes/', logger: {} },
  )
  const entriesResponse = await entriesApp.request('http://localhost/index')
  assert.equal(entriesResponse.status, 200)
  assert.equal(await entriesResponse.text(), 'smoke-ok')
  assert.equal(entriesResponse.headers.get('x-smoke'), 'ok')

  console.log('Smoke test passed for filesystem and entries modes.')
} finally {
  await fs.rm(tmp, { recursive: true, force: true })
}
