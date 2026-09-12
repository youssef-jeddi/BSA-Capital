import { issueChallenge, openSession, AUTH_REQUIRED } from '../services/auth.js'
import { isValidClassicAddress } from 'ripple-address-codec'

export default async function authRoutes(app) {
  /** Lets the client skip the whole sign-in dance when the server does not want it. */
  app.get('/api/auth/mode', async (req, reply) => reply.send({ required: AUTH_REQUIRED }))

  /**
   * A nonce to sign. The client signs the returned tx_json with submit: false and
   * sends it back as `proof`; nothing reaches the ledger.
   */
  app.post('/api/auth/challenge', async (req, reply) => {
    const address = req.body?.address
    if (!isValidClassicAddress(address ?? '')) {
      return reply.code(400).send({ errors: ['A valid XRPL address is required.'] })
    }
    return reply.send(issueChallenge(address))
  })

  /** Exchange one signed challenge for a token, so writes stop asking to sign. */
  app.post('/api/auth/session', async (req, reply) => {
    try { return reply.send(openSession(req.body?.proof)) }
    catch (e) { return reply.code(401).send({ errors: [e.message] }) }
  })
}
