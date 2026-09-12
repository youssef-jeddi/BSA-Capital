import * as service from '../services/superVaults.js'
import {
  counterSignLoan, depositToVault, publicAccount,
  repayLoan, withdrawFromVault, unwindState,
} from '../services/deploymentAccount.js'

const send = (reply, result, created = 200) =>
  result.ok ? reply.code(created).send(result.data)
            : reply.code(result.status).send({ errors: result.errors })

export default async function superVaultRoutes(app) {
  // Address only, never the seed.
  app.get('/api/deployment-account', async (req, reply) => reply.send(publicAccount()))

  /** One-button counter-sign: the server signs as the deployment account and submits. */
  app.post('/api/super-vaults/:vaultId/counter-sign', async (req, reply) => {
    try {
      const out = await counterSignLoan(req.body?.tx_json ?? {})
      if (out.result_code === 'tesSUCCESS' && out.loan_id) {
        service.markDeployed(req.params.vaultId, out.loan_id)
      }
      return reply.send(out)
    } catch (e) {
      return reply.code(400).send({ errors: [e.message] })
    }
  })

  /** What the deployment account owes and still holds, for the unwind panel. */
  app.get('/api/super-vaults/:vaultId/unwind', async (req, reply) => {
    const sv = service.getSuperVault(req.params.vaultId)
    if (!sv) return reply.code(404).send({ errors: ['Super vault not found.'] })
    try {
      return reply.send(await unwindState(sv.loan_id, sv.allocations.map((a) => a.sub_vault_id)))
    } catch (e) { return reply.code(400).send({ errors: [e.message] }) }
  })

  /** Redeem the deployment account's shares in one sub-fund. */
  app.post('/api/super-vaults/:vaultId/allocations/:subVaultId/withdraw', async (req, reply) => {
    try { return reply.send(await withdrawFromVault(req.params.subVaultId, req.body?.shares)) }
    catch (e) { return reply.code(400).send({ errors: [e.message] }) }
  })

  /** Repay the curator loan from the deployment account. */
  app.post('/api/super-vaults/:vaultId/repay', async (req, reply) => {
    const sv = service.getSuperVault(req.params.vaultId)
    if (!sv?.loan_id) return reply.code(400).send({ errors: ['This super vault has no loan.'] })
    try { return reply.send(await repayLoan(sv.loan_id, req.body?.amount)) }
    catch (e) { return reply.code(400).send({ errors: [e.message] }) }
  })

  /** Fund one allocation from the deployment account. */
  app.post('/api/super-vaults/:vaultId/allocations/:subVaultId/deposit', async (req, reply) => {
    try {
      const out = await depositToVault(req.params.subVaultId, req.body?.amount)
      if (out.result_code === 'tesSUCCESS') {
        service.markAllocationFunded(req.params.vaultId, req.params.subVaultId, out.hash)
      }
      return reply.send(out)
    } catch (e) {
      return reply.code(400).send({ errors: [e.message] })
    }
  })

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
