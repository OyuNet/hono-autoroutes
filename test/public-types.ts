import { Hono, type MiddlewareHandler } from 'hono'
import {
  type AutorouteModule,
  type AutoroutesEntries,
  type LoadStats,
  type MiddlewareModule,
  mountAutoRoutes,
  mountAutoRoutesFromEntries,
  type RouteModule,
} from '../src/index'

const routeModule: RouteModule = {
  default: new Hono().get('/', (context) => context.text('typed')),
}

const middleware: MiddlewareHandler = async (_context, next) => next()
const middlewareModule: MiddlewareModule = { default: middleware }

const entries: AutoroutesEntries<AutorouteModule> = {
  '/src/routes/route.ts': routeModule,
  '/src/routes/middleware.ts': async () => middlewareModule,
}

async function verifyPublicTypes() {
  const app = new Hono()
  const entriesStats: LoadStats = await mountAutoRoutesFromEntries(app, entries, {
    virtualRoot: '/src/routes',
    silent: true,
    strict: true,
  })
  const filesystemStats: LoadStats = await mountAutoRoutes(app, { silent: true })

  return { entriesStats, filesystemStats }
}

void verifyPublicTypes
