'use strict'

const ApiClient = require('../../../src/nsrvm-api-client')

const SERVICE_NAME = 'TestService1'

async function testService () {
  console.log(`${SERVICE_NAME} started`)

  const api = new ApiClient({
    onMessage: msg => {
      console.log(`${SERVICE_NAME} message.`, msg)

      switch (msg.cmd) {
        default:
          console.error(`${SERVICE_NAME}: unknown message`)
      }
    }
  })

  let i = 0

  setInterval(() => {
    console.log(`${SERVICE_NAME}. Iteration #${++i}`)
    process.send({ cmd: 'test' })

    if (i >= 3) {
      console.log(`${SERVICE_NAME}. Done`)
      process.exit(2)
    }
  }, 1000)

  process.on('SIGINT', async () => {
    console.log(`${SERVICE_NAME}: Caught interrupt signal. Exit`)
    process.exit(0)
  })

  process.send({ cmd: 'setPublicApi', api: [{ method: 'test', description: 'Test method' }] })

  const config = await api.request({ cmd: 'getConfig' })

  console.log(`${SERVICE_NAME}: config received`, config)
}

testService().catch(e => {
  console.error(e)
})
