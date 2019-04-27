'use strict'

const path = require('path')
const { fork } = require('child_process')

const RESTART_TIMEOUT = 3000
const STOP_TIMEOUT = 5000

/**
 * @typedef {object} NSRVMServiceAPIMethod
 * @property {string} name - length 1..32
 * @property {string} description - length 0..128
 */

class NsrvmService {
  /**
   * NsrvmService
   * @param {NSRVM} nsrvm
   * @param {string} servicesPath
   * @param {ServiceConfig} config
   */
  constructor (nsrvm, servicesPath, config) {
    this.nsrvm = nsrvm
    this.servicePath = path.resolve(servicesPath, config.name)
    this.config = config
    this.dead = false
    this.process = null
    this.restartTimeoutId = null
    this.api = []

    this.start()
  }

  /**
   * onExit
   * @param code
   */
  onExit (code) {
    console.log(`[NSRVM] Service ${this.config.name} exited with code ${code}`)

    this.dead = true
    this.process.removeAllListeners()
    this.process = null

    if (code !== 0) {
      console.log(`[NSRVM] Pending restart ${this.config.name} in ${RESTART_TIMEOUT / 1000} seconds`)

      clearTimeout(this.restartTimeoutId)
      this.restartTimeoutId = setTimeout(this.start.bind(this), RESTART_TIMEOUT)
    }
  }

  /**
   * stop
   * @returns {Promise<any>}
   */
  stop () {
    clearTimeout(this.restartTimeoutId)

    return new Promise(resolve => {
      if (this.dead || !this.process) {
        this.process = null
        this.dead = true
        resolve(true)
      } else {
        this.process.removeAllListeners()

        const killTimeoutId = setTimeout(() => {
          console.log(`[NSRVM] Kill service ${this.config.name}`)
          this.process.kill('SIGKILL')
        }, STOP_TIMEOUT)

        this.process.on('exit', () => {
          console.log(`[NSRVM] Service ${this.config.name} exited`)
          this.dead = true
          clearTimeout(killTimeoutId)
          this.process.removeAllListeners()
          this.process = null
          resolve(true)
        })

        if (process.platform === 'win32') {
          this.process.send('SIGINT')
        } else {
          this.process.kill('SIGINT')
        }
      }
    })
  }

  /**
   * onMessage
   * @param {object} msg
   */
  async onMessage (msg) {
    if (!this.dead && typeof msg === 'object' && msg !== null) {
      switch (msg.cmd) {
        case 'getConfig':
          this.reply({ config: this.config, apiKey: this.nsrvm.apiKeys[this.config.name] }, msg._reqId)
          break

        case 'api':
          this.reply(await this.nsrvm.query(this, msg), msg._reqId)
          break

        case 'setPublicApi':
          this.setPublicApi(msg.api)
          break

        case 'exit':
          this.nsrvm.stopService(this.config.name)
          break

        default:
          console.log(`[NSRVM] Unknown message from ${this.config.name}`, msg.cmd)
      }
    }
  }

  /**
   * reply
   * @param {object|undefined} res
   * @param {number} reqId
   */
  reply (res, reqId) {
    if (!this.dead && this.process && typeof res === 'object' && res !== null) {
      res._reqId = reqId
      this.process.send(res)
    }
  }

  /**
   * start
   */
  start () {
    if (!this.process) {
      this.dead = false
      // noinspection JSCheckFunctionSignatures
      this.process = fork(this.servicePath, { windowsHide: true })

      this.process.on('exit', this.onExit.bind(this))
      this.process.on('message', this.onMessage.bind(this))
    }
  }

  /**
   * validateAPI
   * @param {NSRVMServiceAPIMethod[]} api
   * @returns {boolean}
   */
  static validateAPI (api) {
    return Array.isArray(api) && api.length <= 16 &&
      api.every(method => typeof method === 'object' && method !== null &&
        Object.keys(method).length === 2 &&
        typeof method.name === 'string' && method.name.length > 0 && method.name.length <= 32 &&
        typeof method.description === 'string' && method.description.length <= 128
      )
  }

  /**
   * setPublicApi
   * @param {NSRVMServiceAPIMethod[]} api
   */
  setPublicApi (api) {
    if (NsrvmService.validateAPI(api)) {
      this.api = api
    }
  }
}

module.exports = NsrvmService
