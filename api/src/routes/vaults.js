import * as service from '../services/vaults.js'

export default async function vaultRoutes(app) {
  app.get('/api/vaults', async (req, reply) =>
    reply.send(service.listVaults({ company: req.query.company })))

  app.get('/api/vaults/:vaultId', async (req, reply) => {
    const vault = service.getVault(req.params.vaultId)
    return vault ? reply.send(vault) : reply.code(404).send({ errors: ['Vault not found.'] })
  })

  app.post('/api/vaults', async (req, reply) => {
    const result = service.recordVault(req.body ?? {})
    return result.ok
      ? reply.code(201).send(result.data)
      : reply.code(result.status).send({ errors: result.errors })
  })
}
