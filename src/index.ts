import type { Hono } from 'hono'

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
  const { rootDir, fileName, fileNames, entries, virtualRoot, logger, duplicateStrategy = 'first' } = options
  const log = logger?.log ?? ((msg: string) => console.log(msg))
  const warn = logger?.warn ?? ((msg: string) => console.warn(msg))

  // Compute allowed filenames
  const defaultNames = ['route.ts', 'route.js', 'route.mjs', 'route.cjs']
  const allowed: string[] | RegExp = fileNames
    ? fileNames
    : fileName
    ? [fileName]
    : defaultNames

  // Edge/serverless friendly mode: user provides entries (e.g. import.meta.glob)
  if (entries && Object.keys(entries).length > 0) {
    await mountFromEntries(baseApp, entries, { allowed, virtualRoot, log, warn, duplicateStrategy })
    return
  }

  // Node/runtime scan mode: lazy-import fs/path/url
  await mountFromFilesystem(baseApp, {
    rootDir,
    allowed,
    log,
    warn,
    duplicateStrategy,
  })
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

async function mountFromFilesystem(
  baseApp: Hono,
  opts: {
    rootDir?: string
    allowed: string[] | RegExp
    log: (msg: string) => void
    warn: (msg: string) => void
    duplicateStrategy: 'first' | 'last'
  }
): Promise<void> {
  const { rootDir, allowed, log, warn, duplicateStrategy } = opts
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
          if (matchesAllowed(ent.name, allowed)) {
            const relDir = path.relative(routesRoot!, path.dirname(full))
            const rel = path.relative(routesRoot!, full)
            const mountPath = '/' + (relDir ? relDir.split(path.sep).join('/') : '')
            found.push({
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

  found.sort((a, b) => a.mountPath.localeCompare(b.mountPath))

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
        continue
      }
      ;(baseApp as any).route(f.mountPath === '' ? '/' : f.mountPath, subApp)
      log(`[hono-autoroutes] Mounted ${f.rel} at ${f.mountPath || '/'}`)
    } catch (err: any) {
      warn(`[hono-autoroutes] Failed to import ${f.rel}: ${err?.message ?? String(err)}`)
      continue
    }
  }
}

async function mountFromEntries(
  baseApp: Hono,
  entries: Record<string, any | (() => Promise<any>)>,
  opts: {
    allowed: string[] | RegExp
    virtualRoot?: string | RegExp
    log: (msg: string) => void
    warn: (msg: string) => void
    duplicateStrategy: 'first' | 'last'
  }
): Promise<void> {
  const { allowed, virtualRoot, log, warn, duplicateStrategy } = opts

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

  for (const keyRaw of Object.keys(entries)) {
    const key = normalizeKey(keyRaw)
    const fileName = key.split('/').pop() || ''
    if (!matchesAllowed(fileName, allowed)) continue
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
    found.push({ key, mountPath: mountPath === '/' ? '/' : mountPath.replace(/\/+$/, '') })
  }

  found.sort((a, b) => a.mountPath.localeCompare(b.mountPath))

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
        }
      } else {
        for (let i = 0; i < arr.length - 1; i++) {
          warn(`[hono-autoroutes] Duplicate mountPath '${mp}' — overshadowed: ${arr[i]!.key}`)
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
        continue
      }
      ;(baseApp as any).route(f.mountPath === '' ? '/' : f.mountPath, subApp)
      log(`[hono-autoroutes] Mounted ${f.key} at ${f.mountPath || '/'}`)
    } catch (err: any) {
      warn(`[hono-autoroutes] Failed to import ${f.key}: ${err?.message ?? String(err)}`)
      continue
    }
  }
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
