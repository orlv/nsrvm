export default class NSRVMApiClient {
  /**
   * @param {object} [parameters]
   * @param {number} [parameters.timeout] - send timeout
   * @param {Function} [parameters.onMessage]
   */
  constructor (parameters) {
    const { timeout, onMessage } = parameters || {}

    this.timeout = typeof timeout === 'number' && timeout > 0 ? timeout : 10000
    this.requests = {}
    this.lastReqId = 1

    if (typeof onMessage === 'function') {
      this.onMessage = onMessage
    } else {
      this.onMessage = () => {}
    }

    process.on('message', this.onMsg.bind(this))
  }

  getReqId () {
    if (++this.lastReqId > 0xffffffff) {
      this.lastReqId = 1
    }

    return this.lastReqId
  }

  /**
   * @param {object} msg
   */
  onMsg (msg) {
    if (typeof msg === 'object' && msg !== null && typeof msg._reqId === 'number') {
      const request = this.requests[msg._reqId]

      if (request) {
        delete this.requests[msg._reqId]
        clearTimeout(request.timeoutId)
        request.resolve(msg)
      }
    } else if (typeof msg === 'string') {
      if (msg === 'SIGINT') {
        process.emit('SIGINT')
      }
    } else {
      this.onMessage(msg)
    }
  }

  /**
   * @param {object} msg
   * @returns {Promise<any>}
   */
  async request (msg) {
    const reqId = msg._reqId = this.getReqId()

    return new Promise(resolve => {
      const timeoutId = setTimeout(() => {
        const request = this.requests[reqId]

        if (request) {
          console.log(`Request timeout ${reqId} ${request.date}`)
          delete this.requests[reqId]
          request.resolve()
        }
      }, this.timeout)

      this.requests[reqId] = {
        resolve,
        timeoutId,
        date: Date.now()
      }

      process.send(msg)
    })
  }
}
