import {
  setupZones, listZoneDomains, domainForZones, issueZoneCredential, zonesOf, publicAdmin,
} from '../services/platformAdmin.js'
import { ZONES, validateZones } from '../lib/zones.js'

export default async function zoneRoutes(app) {
  /** The zone catalogue and the domain backing each combination. */
  app.get('/api/zones', async (req, reply) => reply.send({
    zones: ZONES.map(({ code, label }) => ({ code, label })),
    admin: publicAdmin(),
    domains: listZoneDomains(),
  }))

  /** Idempotent: creates the platform account and any missing domains. */
  app.post('/api/zones/setup', async (req, reply) => {
    try { return reply.send(await setupZones()) }
    catch (e) { return reply.code(500).send({ errors: [e.message] }) }
  })

  /** Which zone credentials an account holds, and whether it accepted them. */
  app.get('/api/zones/holder/:address', async (req, reply) => {
    try { return reply.send(await zonesOf(req.params.address)) }
    catch (e) { return reply.code(400).send({ errors: [e.message] }) }
  })

  /**
   * Issue a zone credential after the investor attests to their residency.
   * They still have to accept it with their own wallet.
   */
  app.post('/api/zones/credentials', async (req, reply) => {
    const { address, zone } = req.body ?? {}
    const errors = validateZones(zone ? [zone] : [])
    if (!address) errors.push('address is required')
    if (errors.length) return reply.code(400).send({ errors })
    try { return reply.send(await issueZoneCredential(address, zone)) }
    catch (e) { return reply.code(400).send({ errors: [e.message] }) }
  })

  /** Resolve a chosen zone set to the domain a VaultCreate should carry. */
  app.post('/api/zones/domain', async (req, reply) => {
    const zones = req.body?.zones ?? []
    const errors = validateZones(zones)
    if (errors.length) return reply.code(400).send({ errors })
    if (!zones.length) return reply.send({ domain_id: null, zones: [] })
    const found = domainForZones(zones)
    return found
      ? reply.send({ domain_id: found.domain_id, zones: found.zones })
      : reply.code(404).send({ errors: ['No domain for that zone combination. Run: npm run setup-zones'] })
  })
}
