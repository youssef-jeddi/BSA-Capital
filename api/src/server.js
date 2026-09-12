/** Wiring only. Everything of substance lives in services and repositories. */
import Fastify from 'fastify'
import { getDb } from './db/index.js'
import profileRoutes from './routes/profiles.js'
import vaultRoutes from './routes/vaults.js'

const PORT = Number(process.env.PORT ?? 8787)

const app = Fastify({ logger: { transport: { target: 'pino-pretty' } } })

app.get('/api/health', async () => ({ ok: true }))
await app.register(profileRoutes)
await app.register(vaultRoutes)

getDb() // run migrations before accepting traffic
await app.listen({ port: PORT, host: '127.0.0.1' })
