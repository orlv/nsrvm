'use strict'

const ApiClient = require('../../../src/nsrvm-api-client')

const SERVICE_NAME = 'TestService2'

async function testService () {
  console.log(`[NSRVM] ${SERVICE_NAME} started`)

  const api = new ApiClient({
    onMessage: msg => {
      console.log(`[NSRVM] ${SERVICE_NAME} message.`, msg)

      switch (msg.cmd) {
        default:
          console.error(`${SERVICE_NAME}: unknown message`)
      }
    }
  })

  let i = 0

  setInterval(() => {
    console.log(`[NSRVM] ${SERVICE_NAME}. Iteration #${++i}`)
  }, 2000)

  process.on('SIGINT', async () => {
    console.log(`[NSRVM] ${SERVICE_NAME}: Caught interrupt signal. Exit`)
    process.exit(0)
  })

  process.send({ cmd: 'setPublicApi', api: [{ method: 'test2', description: 'Test method' }] })

  const config = await api.request({ cmd: 'getConfig' })

  console.log(`[NSRVM] ${SERVICE_NAME}: config received`, config)
}

testService().catch(e => {
  console.error(e)
})
