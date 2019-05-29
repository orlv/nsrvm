'use strict'

const NSRVMApiClient = require('../../../src/nsrvm-api-client')

const SERVICE_NAME = 'TestService2'

/**
 * testService
 */
async function testService () {
  console.log(`${SERVICE_NAME} started`)

  const nsrvmAPI = new NSRVMApiClient({
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
      console.log(`${SERVICE_NAME}. Exit failure test..`)
      process.exit(2)
    }
  }, 1000)

  process.on('SIGINT', async () => {
    console.log(`${SERVICE_NAME}: Caught interrupt signal. Exit`)
    process.exit(0)
  })

  process.send({ cmd: 'setPublicApi', api: [{ method: 'test2', description: 'Test method' }] })

  const config = await nsrvmAPI.request({ cmd: 'getConfig' })

  console.log(`${SERVICE_NAME}: config received`, config)
}

testService().catch(e => {
  console.error(e)
})
