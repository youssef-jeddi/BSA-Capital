/** HTTP layer only: parse, delegate to the service, map the result to a status. */
import * as onboarding from '../services/onboarding.js'
import * as companies from '../repositories/companies.js'
import * as users from '../repositories/users.js'

const send = (reply, result, createdStatus = 200) =>
  result.ok
    ? reply.code(createdStatus).send(result.data)
    : reply.code(result.status).send({ errors: result.errors })

export default async function profileRoutes(app) {
  app.get('/api/profile/:address', async (req, reply) =>
    reply.send(onboarding.resolveProfile(req.params.address)))

  app.get('/api/companies', async (req, reply) =>
    reply.send(companies.list({ status: req.query.status })))

  app.get('/api/companies/:address', async (req, reply) => {
    const company = companies.findByAddress(req.params.address)
    return company ? reply.send(company) : reply.code(404).send({ errors: ['Company not found.'] })
  })

  app.post('/api/companies', async (req, reply) =>
    send(reply, onboarding.registerCompany(req.body ?? {}), 201))

  app.put('/api/companies/:address', async (req, reply) =>
    send(reply, onboarding.updateCompany(req.params.address, req.body ?? {})))

  app.get('/api/users', async (req, reply) =>
    reply.send(users.list({ status: req.query.status })))

  app.post('/api/users', async (req, reply) =>
    send(reply, onboarding.registerUser(req.body ?? {}), 201))

  app.put('/api/users/:address', async (req, reply) =>
    send(reply, onboarding.updateUser(req.params.address, req.body ?? {})))
}
