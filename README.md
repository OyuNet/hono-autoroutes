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
* **duplicateStrategy** → If multiple files map to the same path, keep the `first` (default) or the `last`.

---

## 📖 Examples

* `routes/route.ts` → `/`
* `routes/users/route.ts` → `/users`
* `routes/admin/route.ts` → `/admin`

---

## 📝 Notes

* Node/Bun: uses `fs` to walk the routes folder.
* Edge/Workers: must use `entries` (e.g. `import.meta.glob`).
* Duplicate mount paths are warned; strategy can be controlled.
* **No extra conventions:** you still define routes with Hono APIs (`app.get`, `app.post`, etc.).

---

## 📜 License

MIT © 2025
