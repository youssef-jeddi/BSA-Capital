import * as market from '../services/marketplace.js'
import { publicCustody, setupCustody, withLedger } from '../services/custody.js'
import { requireProof } from '../services/auth.js'
import * as listings from '../repositories/listings.js'

const send = (reply, result, created = 200) =>
  result.ok ? reply.code(created).send(result.data)
            : reply.code(result.status).send({ errors: result.errors })

export default async function marketplaceRoutes(app) {
  /** Address only, never the seed. */
  app.get('/api/market/custody', async (req, reply) => reply.send(publicCustody()))

  /** Idempotent: fund the custody account and give it all three zone credentials. */
  app.post('/api/market/custody/setup', async (req, reply) => {
    try { return reply.send(await setupCustody()) }
    catch (e) { return reply.code(500).send({ errors: [e.message] }) }
  })

  /** Open listings joined with live NAV and the discount each represents. */
  app.get('/api/market', async (req, reply) =>
    send(reply, await market.board({
      status: req.query.status ?? 'open',
      vault: req.query.vault,
      seller: req.query.seller,
    })))

  app.get('/api/market/listings/:id', async (req, reply) => {
    const row = market.listOne(req.params.id)
    return row ? reply.send(row) : reply.code(404).send({ errors: ['No such listing.'] })
  })

  /** Live vault state for the sell form: NAV, phase, whether shares transfer. */
  app.get('/api/market/vault/:vaultId', async (req, reply) => {
    try { return reply.send(await withLedger((c) => market.vaultSnapshot(c, req.params.vaultId))) }
    catch (e) { return reply.code(400).send({ errors: [e.message] }) }
  })

  /**
   * The two gates, reported separately: a credential in the vault's domain, and the
   * account's own MPTokenAuthorize. Neither implies the other.
   */
  app.get('/api/market/eligibility', async (req, reply) => {
    const { vault, account } = req.query
    if (!vault || !account) return reply.code(400).send({ errors: ['vault and account are required'] })
    try {
      return reply.send(await withLedger(async (c) => {
        const snap = await market.vaultSnapshot(c, vault)
        const el = await market.eligibility(c, account, snap.share_mpt_id, snap.domain_id)
        return { ...el, share_mpt_id: snap.share_mpt_id, domain_id: snap.domain_id }
      }))
    } catch (e) { return reply.code(400).send({ errors: [e.message] }) }
  })

  /** Custody opts in to the share MPT, so a seller's payment can land. */
  app.post('/api/market/prepare', async (req, reply) =>
    send(reply, await market.prepare(req.body?.vault_id)))

  /** The seller proves control of the account that paid the shares to custody. */
  app.post('/api/market/listings', { preHandler: requireProof() }, async (req, reply) =>
    send(reply, await market.createListing({ ...req.body, seller: req.provedAddress }), 201))

  app.post('/api/market/listings/:id/settle', { preHandler: requireProof() }, async (req, reply) =>
    send(reply, await market.settleListing(req.params.id, { ...req.body, buyer: req.provedAddress })))

  /** Only the seller, proven by signature rather than asserted in the body. */
  app.post('/api/market/listings/:id/cancel',
    { preHandler: requireProof((req) => listings.findById(req.params.id)?.seller_address) },
    async (req, reply) => send(reply, await market.cancelListing(req.params.id, req.provedAddress)))

  /** Reconciliation: shares custody holds with no open listing. */
  app.get('/api/market/stranded', async (req, reply) => {
    if (!req.query.share_mpt_id) return reply.code(400).send({ errors: ['share_mpt_id is required'] })
    return send(reply, await market.stranded(req.query.share_mpt_id))
  })
}
