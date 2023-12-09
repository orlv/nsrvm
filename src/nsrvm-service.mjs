import { fork } from 'child_process'

const RESTART_TIMEOUT = 3000
const STOP_TIMEOUT = 5000

/**
 * @typedef {object} NSRVMServiceAPIMethod
 * @property {string} name - length 1..32
 * @property {string} description - length 0..128
 */

export default class NsrvmService {
  /**
   * @param {NSRVM} nsrvm
   * @param {string} path
   * @param {ServiceConfig} config
   */
  constructor (nsrvm, path, config) {
    this.nsrvm = nsrvm
    this.path = path
    this.config = config
    this.dead = false
    this.process = null
    this.restartTimeoutId = null
    this.api = []
  }

  /**
   * @param {number} code
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
   * @param {object} msg
   * @returns {Promise<void>}
   */
  async onMessage (msg) {
    try {
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
            this.reply({}, msg._reqId)
            break

          case 'exit':
            await this.nsrvm.stopService(this.config.name)
            this.reply({}, msg._reqId)
            break

          case 'setChildServices':
            await this.setChildServices(msg)
            this.reply({}, msg._reqId)
            break

          default:
            console.log(`[NSRVM] Unknown message from ${this.config.name}`, msg.cmd)
            this.reply({}, msg._reqId)
        }
      }
    } catch (e) {
      console.error(e)
    }
  }

  /**
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
   * start service
   */
  start () {
    if (!this.process) {
      this.dead = false

      const options = {}

      if (this.config.execPath) {
        options.execPath = this.config.execPath
      }

      if (this.config.env) {
        options.env = this.config.env
      }

      if (this.config.execArgv) {
        options.execArgv = this.config.execArgv
      }

      // noinspection JSCheckFunctionSignatures
      this.process = fork(this.path, options)

      this.process.on('exit', this.onExit.bind(this))
      this.process.on('message', this.onMessage.bind(this))
    }
  }

  /**
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
   * @param {NSRVMServiceAPIMethod[]} api
   */
  setPublicApi (api) {
    if (NsrvmService.validateAPI(api)) {
      this.api = api
    }
  }

  /**
   * @param {{configs: ServiceConfig[]}} params
   */
  async setChildServices ({ configs }) {
    if (Array.isArray(configs) && configs.length <= this.config.maxChilds) {
      await this.nsrvm.setChildServices(this, configs)
    }
  }
}
