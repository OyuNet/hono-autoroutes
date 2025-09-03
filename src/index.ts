import type { Hono, MiddlewareHandler } from 'hono'

export type AutoroutesOptions = {
  /** Absolute or relative directory containing your routes tree (Node runtime scan).
   * Defaults to first existing of: `src/routes`, `routes` (from process.cwd).
   */
  rootDir?: string
  /** Allowed route file names. Default includes: route.ts/js/mjs/cjs.
   * You can pass an array of exact filenames or a RegExp.
   * Deprecated: `fileName` (single name) still works.
   */
  fileNames?: string[] | RegExp
  /** Deprecated single filename; prefer `fileNames`. */
  fileName?: string
  /** Allowed middleware file names. Default includes: middleware.ts/js/mjs/cjs. */
  middlewareFileNames?: string[] | RegExp
  /** Deprecated single middleware filename; prefer `middlewareFileNames`. */
  middlewareFileName?: string
  // Provide a bundler-produced entries map (e.g. import.meta.glob for your routes tree).
  // Use this for edge/serverless. Keys should be POSIX-like paths.
  entries?: Record<string, any | (() => Promise<any>)>
  /** For entries mode, the virtual root segment used to derive mount paths.
   * If omitted, we try to detect the first `.../routes/` occurrence.
   */
  virtualRoot?: string | RegExp
  /** Optional logger. Defaults to console.log/console.warn. */
  logger?: { log?: (msg: string) => void; warn?: (msg: string) => void }
  /** When multiple files resolve to the same mount path, choose which one to keep. Default: 'first'. */
  duplicateStrategy?: 'first' | 'last'
}

/**
 * Walk the routes tree and mount discovered sub-apps onto the base Hono app.
 *
 * Discovery rules:
 * - Looks for files named `route.ts` by default (also .js/.mjs/.cjs siblings)
 * - The mount path is computed from the folder structure under the root
 *   (e.g. `users/route.ts` -> `/users`)
 *
 * Route module contract (any of):
 * - default export: Hono instance
 * - named export: async function `createRoutes(app)` or `register(app)` to populate routes
 */
export async function mountAutoRoutes(baseApp: Hono, options: AutoroutesOptions = {}): Promise<void> {
  const { rootDir, fileName, fileNames, middlewareFileName, middlewareFileNames, entries, virtualRoot, logger, duplicateStrategy = 'first' } = options
  const log = logger?.log ?? ((msg: string) => console.log(msg))
  const warn = logger?.warn ?? ((msg: string) => console.warn(msg))

  // Compute allowed filenames
  const defaultNames = ['route.ts', 'route.js', 'route.mjs', 'route.cjs']
  const allowed: string[] | RegExp = fileNames
    ? fileNames
    : fileName
    ? [fileName]
    : defaultNames

  const defaultMwNames = ['middleware.ts', 'middleware.js', 'middleware.mjs', 'middleware.cjs']
  const allowedMw: string[] | RegExp = middlewareFileNames
    ? middlewareFileNames
    : middlewareFileName
    ? [middlewareFileName]
    : defaultMwNames

  // Initialize stats
  const stats: LoadStats = {
    routes: { mounted: 0, skipped: 0, failed: 0 },
    middlewares: { mounted: 0, skipped: 0, failed: 0 },
  }

  // Edge/serverless friendly mode: user provides entries (e.g. import.meta.glob)
  if (entries && Object.keys(entries).length > 0) {
    await mountFromEntries(baseApp, entries, { allowed, allowedMw: allowedMw, virtualRoot, log, warn, duplicateStrategy, stats })
    logSummary(log, stats)
    return
  }

  // Node/runtime scan mode: lazy-import fs/path/url
  await mountFromFilesystem(baseApp, {
    rootDir,
    allowed,
    allowedMw,
    log,
    warn,
    duplicateStrategy,
    stats,
  })
  logSummary(log, stats)
}

export type { Hono } from 'hono'

/** Convenience helper to create an app and mount routes. */
export async function createAppWithAutoRoutes(options?: AutoroutesOptions & { createApp?: () => Hono }): Promise<Hono> {
  const { createApp } = options || {}
  const HonoCtor = (await import('hono')).Hono
  const app = createApp ? createApp() : new HonoCtor()
  await mountAutoRoutes(app, options)
  return app
}

// ---------- internals ----------

function matchesAllowed(fileName: string, allowed: string[] | RegExp): boolean {
  if (allowed instanceof RegExp) return allowed.test(fileName)
  return allowed.includes(fileName)
}

function basename(posixPath: string): string {
  const norm = posixPath.replace(/\\/g, '/')
  const idx = norm.lastIndexOf('/')
  return idx >= 0 ? norm.slice(idx + 1) : norm
}

function pathDepth(mountPath: string): number {
  if (!mountPath || mountPath === '/') return 0
  return mountPath.split('/').filter(Boolean).length
}

function depthLexComparator(a: string, b: string): number {
  const da = pathDepth(a)
  const db = pathDepth(b)
  if (da !== db) return da - db
  return a.localeCompare(b)
}

async function mountFromFilesystem(
  baseApp: Hono,
  opts: {
    rootDir?: string
    allowed: string[] | RegExp
    allowedMw: string[] | RegExp
    log: (msg: string) => void
    warn: (msg: string) => void
    duplicateStrategy: 'first' | 'last'
    stats: LoadStats
  }
): Promise<void> {
  const { rootDir, allowed, allowedMw, log, warn, duplicateStrategy, stats } = opts
  const { promises: fs } = await import('node:fs')
  const path = await import('node:path')
  const { pathToFileURL } = await import('node:url')

  const cwd = process.cwd()
  const candidates = [
    rootDir && path.resolve(cwd, rootDir),
    path.resolve(cwd, 'src/routes'),
    path.resolve(cwd, 'routes'),
  ].filter(Boolean) as string[]

  let routesRoot: string | null = null
  for (const candidate of candidates) {
    try {
      const stat = await fs.stat(candidate)
      if (stat.isDirectory()) {
        routesRoot = candidate
        break
      }
    } catch {
      // ignore
    }
  }

  if (!routesRoot) return

  const found: Array<{ file: string; mountPath: string; rel: string }> = []
  const foundMw: Array<{ file: string; mountPath: string; rel: string }> = []

  async function walk(dir: string) {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    await Promise.all(
      entries.map(async (ent) => {
        const full = path.join(dir, ent.name)
        if (ent.isDirectory()) {
          await walk(full)
          return
        }
        if (ent.isFile()) {
          const base = ent.name
          if (matchesAllowed(base, allowed)) {
            const relDir = path.relative(routesRoot!, path.dirname(full))
            const rel = path.relative(routesRoot!, full)
            const mountPath = '/' + (relDir ? relDir.split(path.sep).join('/') : '')
            found.push({
              file: full,
              rel,
              mountPath: mountPath === '/' ? '/' : mountPath.replace(/\/+$/, ''),
            })
          } else if (matchesAllowed(base, allowedMw)) {
            const relDir = path.relative(routesRoot!, path.dirname(full))
            const rel = path.relative(routesRoot!, full)
            const mountPath = '/' + (relDir ? relDir.split(path.sep).join('/') : '')
            foundMw.push({
              file: full,
              rel,
              mountPath: mountPath === '/' ? '/' : mountPath.replace(/\/+$/, ''),
            })
          }
        }
      })
    )
  }

  await walk(routesRoot)

  // Apply middleware first (inheritance): parents before children
  foundMw.sort((a, b) => depthLexComparator(a.mountPath, b.mountPath))
  // dedupe middleware by mountPath
  {
    const groups = new Map<string, typeof foundMw>()
    for (const m of foundMw) {
      const arr = groups.get(m.mountPath)
      if (arr) arr.push(m)
      else groups.set(m.mountPath, [m])
    }
    const selectedMw: typeof foundMw = []
    for (const [mp, arr] of groups.entries()) {
      if (arr.length === 1) selectedMw.push(arr[0]!)
      else if (duplicateStrategy === 'first') {
        selectedMw.push(arr[0]!)
        for (let i = 1; i < arr.length; i++) {
          warn(`[hono-autoroutes] Duplicate middleware mountPath '${mp}' — skipping ${arr[i]!.rel}`)
          stats.middlewares.skipped++
        }
      } else {
        for (let i = 0; i < arr.length - 1; i++) {
          warn(`[hono-autoroutes] Duplicate middleware mountPath '${mp}' — overshadowed: ${arr[i]!.rel}`)
          stats.middlewares.skipped++
        }
        selectedMw.push(arr[arr.length - 1]!)
      }
    }
    await applyMiddlewaresFilesystem(baseApp, selectedMw, { log, warn, stats })
  }

  // Then mount routes
  found.sort((a, b) => depthLexComparator(a.mountPath, b.mountPath))

  // De-duplicate by mountPath according to strategy
  const selected: typeof found = []
  const groups = new Map<string, typeof found>()
  for (const f of found) {
    const arr = groups.get(f.mountPath)
    if (arr) arr.push(f)
    else groups.set(f.mountPath, [f])
  }
  for (const [mp, arr] of groups.entries()) {
    if (arr.length === 1) {
      selected.push(arr[0]!)
    } else {
      if (duplicateStrategy === 'first') {
        selected.push(arr[0]!)
        for (let i = 1; i < arr.length; i++) {
          warn(`[hono-autoroutes] Duplicate mountPath '${mp}' — skipping ${arr[i]!.rel}`)
        }
      } else {
        // last
        for (let i = 0; i < arr.length - 1; i++) {
          warn(`[hono-autoroutes] Duplicate mountPath '${mp}' — overshadowed: ${arr[i]!.rel}`)
        }
        selected.push(arr[arr.length - 1]!)
      }
    }
  }

  for (const f of selected) {
    try {
      const mod = await import(pathToFileURL(f.file).href)
      const subApp = await resolveSubApp(mod)
      if (!subApp) {
        warn(`[hono-autoroutes] Skipping ${f.rel} — export a default Hono app or a register/createRoutes(app) function.`)
        stats.routes.skipped++
        continue
      }
      ;(baseApp as any).route(f.mountPath === '' ? '/' : f.mountPath, subApp)
      log(`[hono-autoroutes] Mounted ${f.rel} at ${f.mountPath || '/'}`)
      stats.routes.mounted++
    } catch (err: any) {
      warn(`[hono-autoroutes] Failed to import ${f.rel}: ${err?.message ?? String(err)}`)
      stats.routes.failed++
      continue
    }
  }
}

async function mountFromEntries(
  baseApp: Hono,
  entries: Record<string, any | (() => Promise<any>)>,
  opts: {
    allowed: string[] | RegExp
    allowedMw: string[] | RegExp
    virtualRoot?: string | RegExp
    log: (msg: string) => void
    warn: (msg: string) => void
    duplicateStrategy: 'first' | 'last'
    stats: LoadStats
  }
): Promise<void> {
  const { allowed, allowedMw, virtualRoot, log, warn, duplicateStrategy, stats } = opts

  function normalizeKey(p: string): string {
    // normalize to posix-like path
    return p.replace(/\\/g, '/').replace(/^\.\//, '/')
  }

  function detectRoot(p: string): { start: number; len: number } {
    if (virtualRoot) {
      if (typeof virtualRoot === 'string') {
        const idx = p.indexOf(virtualRoot)
        return { start: idx, len: idx >= 0 ? virtualRoot.length : 0 }
      }
      const m = p.match(virtualRoot)
      const start = m && typeof m.index === 'number' ? m.index : -1
      const len = start >= 0 && m && typeof m[0] === 'string' ? m[0].length : 0
      return { start, len }
    }
    const idx = p.indexOf('/routes/')
    return { start: idx, len: idx >= 0 ? '/routes/'.length : 0 }
  }

  const found: Array<{ key: string; mountPath: string }> = []
  const foundMw: Array<{ key: string; mountPath: string }> = []

  for (const keyRaw of Object.keys(entries)) {
    const key = normalizeKey(keyRaw)
    const fileName = basename(key)
    if (!matchesAllowed(fileName, allowed) && !matchesAllowed(fileName, allowedMw)) continue
    const { start, len } = detectRoot(key)
    if (start < 0) {
      const vr = virtualRoot ? (typeof virtualRoot === 'string' ? virtualRoot : virtualRoot.toString()) : '/routes/'
      warn(`[hono-autoroutes] Could not detect virtual root (${vr}) in '${key}'. Deriving mount path from full key.`)
    }
    const rootStart = start >= 0 ? start + len : 0
    const afterRoot = key.slice(rootStart)
    const dir = afterRoot.slice(0, afterRoot.lastIndexOf('/'))
    const relDir = dir.replace(/^\/*/, '').replace(/\/*$/, '')
    const mountPath = '/' + relDir
    const rec = { key, mountPath: mountPath === '/' ? '/' : mountPath.replace(/\/+$/, '') }
    if (matchesAllowed(fileName, allowed)) found.push(rec)
    else foundMw.push(rec)
  }

  // Apply middleware first
  foundMw.sort((a, b) => depthLexComparator(a.mountPath, b.mountPath))
  {
    const groups = new Map<string, typeof foundMw>()
    for (const m of foundMw) {
      const arr = groups.get(m.mountPath)
      if (arr) arr.push(m)
      else groups.set(m.mountPath, [m])
    }
    const selectedMw: typeof foundMw = []
    for (const [mp, arr] of groups.entries()) {
      if (arr.length === 1) selectedMw.push(arr[0]!)
      else if (duplicateStrategy === 'first') {
        selectedMw.push(arr[0]!)
        for (let i = 1; i < arr.length; i++) {
          warn(`[hono-autoroutes] Duplicate middleware mountPath '${mp}' — skipping ${arr[i]!.key}`)
          stats.middlewares.skipped++
        }
      } else {
        for (let i = 0; i < arr.length - 1; i++) {
          warn(`[hono-autoroutes] Duplicate middleware mountPath '${mp}' — overshadowed: ${arr[i]!.key}`)
          stats.middlewares.skipped++
        }
        selectedMw.push(arr[arr.length - 1]!)
      }
    }
    await applyMiddlewaresEntries(baseApp, selectedMw, entries, { log, warn, stats })
  }

  // Then routes
  found.sort((a, b) => depthLexComparator(a.mountPath, b.mountPath))

  // De-duplicate by mountPath according to strategy
  const selected: typeof found = []
  const groups = new Map<string, typeof found>()
  for (const f of found) {
    const arr = groups.get(f.mountPath)
    if (arr) arr.push(f)
    else groups.set(f.mountPath, [f])
  }
  for (const [mp, arr] of groups.entries()) {
    if (arr.length === 1) {
      selected.push(arr[0]!)
    } else {
      if (duplicateStrategy === 'first') {
        selected.push(arr[0]!)
        for (let i = 1; i < arr.length; i++) {
          warn(`[hono-autoroutes] Duplicate mountPath '${mp}' — skipping ${arr[i]!.key}`)
          stats.routes.skipped++
        }
      } else {
        for (let i = 0; i < arr.length - 1; i++) {
          warn(`[hono-autoroutes] Duplicate mountPath '${mp}' — overshadowed: ${arr[i]!.key}`)
          stats.routes.skipped++
        }
        selected.push(arr[arr.length - 1]!)
      }
    }
  }

  for (const f of selected) {
    try {
      const loaderOrMod = entries[f.key]
      const mod = typeof loaderOrMod === 'function' ? await loaderOrMod() : loaderOrMod
      const subApp = await resolveSubApp(mod)
      if (!subApp) {
        warn(`[hono-autoroutes] Skipping ${f.key} — export a default Hono app or a register/createRoutes(app) function.`)
        stats.routes.skipped++
        continue
      }
      ;(baseApp as any).route(f.mountPath === '' ? '/' : f.mountPath, subApp)
      log(`[hono-autoroutes] Mounted ${f.key} at ${f.mountPath || '/'}`)
      stats.routes.mounted++
    } catch (err: any) {
      warn(`[hono-autoroutes] Failed to import ${f.key}: ${err?.message ?? String(err)}`)
      stats.routes.failed++
      continue
    }
  }
}

// ---------- middleware helpers ----------

type MW = MiddlewareHandler

function mountPatterns(mountPath: string): [string, string] {
  const exact = mountPath === '' ? '/' : mountPath
  const wildcard = mountPath === '/' ? '/*' : `${mountPath}/*`
  return [exact, wildcard]
}

async function resolveMiddlewareHandlers(mod: any): Promise<MW[] | null> {
  const asArray = (x: any): MW[] => (Array.isArray(x) ? x : [x]).filter((f) => typeof f === 'function')

  if (mod) {
  if (typeof mod.default === 'function' || Array.isArray(mod.default)) return asArray(mod.default)
    if (typeof mod.middleware === 'function') return asArray(mod.middleware)
    if (Array.isArray(mod.middlewares)) return asArray(mod.middlewares)
    // Support register-style: register(app) where app.use is called
    if (typeof mod.register === 'function' || typeof mod.createMiddleware === 'function') {
      return [] // signal to call register with a scoped adapter
    }
  }
  return null
}

function createScopedUse(baseApp: Hono, mountPath: string) {
  const scoped = {
    use: (...args: any[]) => {
      if (typeof args[0] === 'string') {
        // support multiple path strings like app.use('/a','/b', mw)
        const paths: string[] = []
        let i = 0
        while (i < args.length && typeof args[i] === 'string') {
          const p = args[i] as string
          const full = mountPath === '/' ? p : p.startsWith('/') ? `${mountPath}${p}` : `${mountPath}/${p}`
          paths.push(full)
          i++
        }
        const handlers = args.slice(i)
        ;(baseApp as any).use(...paths, ...handlers)
      } else {
        const handlers = args as MW[]
  const [exact, wildcard] = mountPatterns(mountPath)
  ;(baseApp as any).use(exact, ...handlers)
  ;(baseApp as any).use(wildcard, ...handlers)
      }
    },
  }
  return scoped
}

async function applyMiddlewaresFilesystem(
  baseApp: Hono,
  foundMw: Array<{ file: string; mountPath: string; rel: string }>,
  io: { log: (m: string) => void; warn: (m: string) => void; stats: LoadStats }
): Promise<void> {
  const { log, warn, stats } = io
  const { pathToFileURL } = await import('node:url')
  for (const f of foundMw) {
    try {
      const mod = await import(pathToFileURL(f.file).href)
      const handlers = await resolveMiddlewareHandlers(mod)
      if (handlers === null) {
        warn(`[hono-autoroutes] Skipping ${f.rel} — export default middleware, middlewares[], middleware, or register(app).`)
        stats.middlewares.skipped++
        continue
      }
      if (handlers.length > 0) {
        const [exact, wildcard] = mountPatterns(f.mountPath)
        ;(baseApp as any).use(exact, ...handlers)
        ;(baseApp as any).use(wildcard, ...handlers)
        log(`[hono-autoroutes] Mounted middleware ${f.rel} at ${exact}, ${wildcard}`)
        stats.middlewares.mounted++
      } else {
        // register/createMiddleware pattern
        const adapter = createScopedUse(baseApp, f.mountPath)
        const fn = (mod.register ?? mod.createMiddleware) as (a: any) => any
        await Promise.resolve(fn(adapter))
        const [exact, wildcard] = mountPatterns(f.mountPath)
        log(`[hono-autoroutes] Applied scoped middleware from ${f.rel} at ${exact}, ${wildcard}`)
        stats.middlewares.mounted++
      }
    } catch (err: any) {
      warn(`[hono-autoroutes] Failed to import middleware ${f.rel}: ${err?.message ?? String(err)}`)
      stats.middlewares.failed++
      continue
    }
  }
}

async function applyMiddlewaresEntries(
  baseApp: Hono,
  foundMw: Array<{ key: string; mountPath: string }>,
  entries: Record<string, any | (() => Promise<any>)>,
  io: { log: (m: string) => void; warn: (m: string) => void; stats: LoadStats }
): Promise<void> {
  const { log, warn, stats } = io
  for (const f of foundMw) {
    try {
      const loaderOrMod = entries[f.key]
      const mod = typeof loaderOrMod === 'function' ? await loaderOrMod() : loaderOrMod
      const handlers = await resolveMiddlewareHandlers(mod)
      if (handlers === null) {
        warn(`[hono-autoroutes] Skipping ${f.key} — export default middleware, middlewares[], middleware, or register(app).`)
        stats.middlewares.skipped++
        continue
      }
      if (handlers.length > 0) {
  const [exact, wildcard] = mountPatterns(f.mountPath)
  ;(baseApp as any).use(exact, ...handlers)
  ;(baseApp as any).use(wildcard, ...handlers)
  log(`[hono-autoroutes] Mounted middleware ${f.key} at ${exact}, ${wildcard}`)
        stats.middlewares.mounted++
      } else {
        const adapter = createScopedUse(baseApp, f.mountPath)
        const fn = (mod.register ?? mod.createMiddleware) as (a: any) => any
        await Promise.resolve(fn(adapter))
  const [exact, wildcard] = mountPatterns(f.mountPath)
  log(`[hono-autoroutes] Applied scoped middleware from ${f.key} at ${exact}, ${wildcard}`)
        stats.middlewares.mounted++
      }
    } catch (err: any) {
      warn(`[hono-autoroutes] Failed to import middleware ${f.key}: ${err?.message ?? String(err)}`)
      stats.middlewares.failed++
      continue
    }
  }
}

// ---------- stats ----------

type LoadStats = {
  routes: { mounted: number; skipped: number; failed: number }
  middlewares: { mounted: number; skipped: number; failed: number }
}

function logSummary(log: (m: string) => void, stats: LoadStats) {
  const r = stats.routes
  const m = stats.middlewares
  log(
    `[hono-autoroutes] Summary — routes: mounted ${r.mounted}, skipped ${r.skipped}, failed ${r.failed}; middlewares: mounted ${m.mounted}, skipped ${m.skipped}, failed ${m.failed}`
  )
}

async function resolveSubApp(mod: any): Promise<Hono | null> {
  let subApp: Hono | null = null
  if (mod && mod.default && typeof mod.default === 'object') {
    if ('fetch' in mod.default || 'get' in mod.default) {
      subApp = mod.default as Hono
    }
  }
  if (!subApp) {
    const HonoCtor = (await import('hono')).Hono
    if (mod && typeof mod.createRoutes === 'function') {
      const tmp = new HonoCtor()
      await Promise.resolve(mod.createRoutes(tmp))
      subApp = tmp
    } else if (mod && typeof mod.register === 'function') {
      const tmp = new HonoCtor()
      await Promise.resolve(mod.register(tmp))
      subApp = tmp
    }
  }
  return subApp
}

/** Mount using glob-like entries (edge-ready). Alias helper. */
export async function mountAutoRoutesFromEntries(
  baseApp: Hono,
  entries: Record<string, any | (() => Promise<any>)>,
  options: Omit<AutoroutesOptions, 'entries'> = {}
): Promise<void> {
  return mountAutoRoutes(baseApp, { ...options, entries })
}
