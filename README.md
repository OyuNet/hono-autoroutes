# hono-autoroutes

> 🔗 A zero-magic, file-based router for [Hono](https://hono.dev).
> Just export a Hono app from `routes/**/route.ts` and it mounts automatically.

---

## ✨ Why?

Most existing file-based routers for Hono introduce *new conventions* (like `GET.ts`/`POST.ts`) or extra abstractions.
**hono-autoroutes** takes a different path:

* 🪄 **No new APIs** – use plain Hono as-is.
* 📂 **File-based discovery** – place `route.ts` files under `routes/`.
* 🔌 **Flexible contract** – export a `Hono` instance or a `register(app)`/`createRoutes(app)` function.
* 🌐 **Works everywhere** – Node/Bun (filesystem scan) **and** Edge/Workers (via `import.meta.glob`).
* 🧩 **Scoped middleware** – optional `middleware.ts` at any folder applies to that path and all children.
* 📦 **Route Groups** – organize files with `(folder)` syntax without affecting the URL.

---

## 🚀 Installation

```bash
npm install hono-autoroutes
# or
bun add hono-autoroutes
pnpm add hono-autoroutes
```

---

## 📂 Usage (Node / Bun)

Project structure:

```
src/
  app.ts
  routes/
    route.ts
    users/
      route.ts
    posts/
      route.ts
```

### `src/app.ts`

```ts
import { Hono } from 'hono'
import { mountAutoRoutes } from 'hono-autoroutes'

const app = new Hono()

await mountAutoRoutes(app, {
  rootDir: 'src/routes', // optional, defaults to src/routes or routes
})

export default app
```

### `src/routes/route.ts`

```ts
import { Hono } from 'hono'

const app = new Hono()
app.get('/', (c) => c.text('Hello root!'))

export default app
```

### `src/routes/users/route.ts`

```ts
import { Hono } from 'hono'

const app = new Hono()
app.get('/:id', (c) => c.json({ user: c.req.param('id') }))

export default app
```

### Middleware (Node / Bun)

Create `middleware.ts` files alongside your routes to apply middleware to that folder and all of its children. Middleware is applied to both the exact folder path and its subtree.

```
src/
  routes/
    middleware.ts        # applies to /* (entire tree)
    users/
      middleware.ts      # applies to /users and /users/*
      route.ts
    admin/
      logs/
        middleware.ts    # applies to /admin/logs and /admin/logs/*
```

Supported exports:

```ts
// default: single or array of middlewares
export default async (c, next) => { /* ... */ await next() }
// or
export default [mw1, mw2]

// named
export const middleware = (c, next) => next()
export const middlewares = [mw1, mw2]

// register-style: calls are automatically scoped to the folder
export function register(app: { use: (...args: any[]) => void }) {
  // behaves like: app.use('/folder', mw) and app.use('/folder/*', mw)
  app.use((c, next) => next())
}
```

---

## 🌐 Usage (Edge / Workers)

Since Edge environments can’t read the filesystem, you can provide an `entries` map (e.g. via `import.meta.glob`).

```ts
import { Hono } from 'hono'
import { mountAutoRoutesFromEntries } from 'hono-autoroutes'

const app = new Hono()

const entries = import.meta.glob('/src/routes/**/route.ts')

await mountAutoRoutesFromEntries(app, entries, {
  virtualRoot: '/src/routes', // strip this prefix to derive mount paths
})

export default app
```

### Middleware (Edge / Workers)

Provide middleware files in your `entries` map as well; they’ll be applied to both exact and wildcard paths.

```ts
const entries = {
  ...import.meta.glob('/src/routes/**/route.ts'),
  ...import.meta.glob('/src/routes/**/middleware.ts'),
}

await mountAutoRoutesFromEntries(app, entries, { virtualRoot: '/src/routes' })
```

---

## 🔑 Route Module Contract

Each `route.ts` file can export in one of these forms:

1. **Default export: Hono instance (preferred)**

```ts
export default new Hono().get('/', (c) => c.text('hi'))
```

2. **Named export: `register(app)`**

```ts
export function register(app: Hono) {
  app.get('/', (c) => c.text('hi'))
}
```

3. **Named export: `createRoutes(app)`**

```ts
export async function createRoutes(app: Hono) {
  app.get('/', (c) => c.text('hi'))
}
```

---

## ⚙️ Options

```ts
type AutoroutesOptions = {
  rootDir?: string
  fileNames?: string[] | RegExp
  fileName?: string // deprecated
  middlewareFileNames?: string[] | RegExp
  middlewareFileName?: string // deprecated
  entries?: Record<string, any | (() => Promise<any>)>
  virtualRoot?: string | RegExp
  logger?: { log?: (msg: string) => void; warn?: (msg: string) => void }
  duplicateStrategy?: 'first' | 'last'
}
```

* **rootDir** → Path to routes folder (default: `src/routes` or `routes`).
* **fileNames** → Allowed route filenames (default: `route.ts/js/mjs/cjs`).
* **entries** → Bundler-provided modules (Edge mode).
* **virtualRoot** → Root prefix to strip when deriving mount paths.
* **logger** → Custom logging implementation.
* **duplicateStrategy** → If multiple files map to the same path, keep the `first` (default) or the `last` (applies to routes and middleware).
* **middlewareFileNames** → Allowed middleware filenames (default: `middleware.ts/js/mjs/cjs`).

---

## 📖 Examples

* `routes/route.ts` → `/`
* `routes/users/route.ts` → `/users`
* `routes/admin/route.ts` → `/admin`
* `routes/middleware.ts` → applies to all routes (i.e. `/*`)
* `routes/admin/middleware.ts` → applies to `/admin/*`

### Route Groups

You can map routes to a path without affecting the URL by wrapping the folder name in parenthesis:

* `routes/(app)/dashboard/route.ts` → `/dashboard`
* `routes/(api)/v1/users/route.ts` → `/v1/users`

---

## 📝 Notes

* Node/Bun: uses `fs` to walk the routes folder.
* Edge/Workers: must use `entries` (e.g. `import.meta.glob`).
* Duplicate mount paths are warned; strategy can be controlled.
* **No extra conventions:** you still define routes with Hono APIs (`app.get`, `app.post`, etc.).
* Middleware modules can export:
  - default function (single middleware) or array of middlewares
  - named: `middleware` or `middlewares`
  - or `register(app)`/`createMiddleware(app)`, where `app.use()` calls are scoped to that folder
* Middleware covers the exact folder path (e.g. `/users`) and the subtree (e.g. `/users/*`).

## 🧪 Testing

Run built-in tests with:

```bash
bun test
```

---

## 📜 License

MIT © 2025
