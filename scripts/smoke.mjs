import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

async function main() {
  const tmp = await fs.mkdtemp(path.join(tmpdir(), 'hono-autoroutes-'))
  const routesDir = path.join(tmp, 'src', 'routes', 'index')
  await fs.mkdir(routesDir, { recursive: true })
  const mwRootDir = path.join(tmp, 'src', 'routes')
  const mwSubDir = path.join(tmp, 'src', 'routes', 'index')

  // Create a simple route file
  const routeFile = path.join(routesDir, 'route.mjs')
  await fs.writeFile(
    routeFile,
    `export function register(app){ app.get('/', (c) => c.text('root-ok')) }
`
  )

  // middleware at root (applies to all)
  const mwRootFile = path.join(mwRootDir, 'middleware.mjs')
  await fs.writeFile(
    mwRootFile,
    `export default [
      async (c, next) => { c.header('x-root', 'ok'); await next() }
    ]
    `
  )

  // middleware at subpath (applies to /index)
  const mwSubFile = path.join(mwSubDir, 'middleware.mjs')
  await fs.writeFile(
    mwSubFile,
    `export const middleware = async (c, next) => { c.header('x-index', 'ok'); await next() }
    `
  )

  const lib = await import(path.join(__dirname, '..', 'dist', 'index.js'))
  // filesystem mode
  const app = await lib.createAppWithAutoRoutes({ rootDir: path.join(tmp, 'src', 'routes') })
  const res = await app.fetch(new Request('http://localhost/index'))
  const txt = await res.text()
  console.log('SMOKE_RESPONSE_FS=', txt, res.headers.get('x-root'), res.headers.get('x-index'))

  // entries mode
  const entriesApp = new (await import('hono')).Hono()
  const entries = {
    '/virtual/routes/index/route.mjs': () => import(routeFile),
    '/virtual/routes/middleware.mjs': () => import(mwRootFile),
    '/virtual/routes/index/middleware.mjs': () => import(mwSubFile),
    // duplicate same mount path, later should be skipped by default ('first')
    '/virtual/routes/index/route.ts': async () => ({
      register(app){ app.get('/', (c) => c.text('should-not-see')) }
    }),
  }
  await lib.mountAutoRoutes(entriesApp, { entries, virtualRoot: '/virtual/routes/' })
  const res2 = await entriesApp.fetch(new Request('http://localhost/index'))
  const txt2 = await res2.text()
  console.log('SMOKE_RESPONSE_ENTRIES=', txt2, res2.headers.get('x-root'), res2.headers.get('x-index'))

  // entries mode with duplicateStrategy: 'last'
  const entriesAppLast = new (await import('hono')).Hono()
  const entriesLast = {
    '/virtual/routes/index/route.mjs': () => import(routeFile),
    '/virtual/routes/index/route.ts': async () => ({
      register(app){ app.get('/', (c) => c.text('last-wins')) }
    }),
  }
  await lib.mountAutoRoutes(entriesAppLast, { entries: entriesLast, virtualRoot: '/virtual/routes/', duplicateStrategy: 'last' })
  const res3 = await entriesAppLast.fetch(new Request('http://localhost/index'))
  const txt3 = await res3.text()
  console.log('SMOKE_RESPONSE_ENTRIES_LAST=', txt3)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
