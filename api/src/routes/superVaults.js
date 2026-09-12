import * as service from '../services/superVaults.js'

const send = (reply, result, created = 200) =>
  result.ok ? reply.code(created).send(result.data)
            : reply.code(result.status).send({ errors: result.errors })

export default async function superVaultRoutes(app) {
  app.get('/api/super-vaults', async (req, reply) =>
    reply.send(service.listSuperVaults({ curator: req.query.curator })))

  app.get('/api/super-vaults/:vaultId', async (req, reply) => {
    const found = service.getSuperVault(req.params.vaultId)
    return found ? reply.send(found) : reply.code(404).send({ errors: ['Super vault not found.'] })
  })

  app.post('/api/super-vaults', async (req, reply) =>
    send(reply, service.createSuperVault(req.body ?? {}), 201))

  app.post('/api/super-vaults/:vaultId/deploy', async (req, reply) =>
    send(reply, service.markDeployed(req.params.vaultId, req.body?.loan_id)))

  app.post('/api/super-vaults/:vaultId/allocations/:subVaultId/funded', async (req, reply) =>
    send(reply, service.markAllocationFunded(req.params.vaultId, req.params.subVaultId, req.body?.tx_hash)))
}
