'use strict'

const path = require('path')
const fs = require('fs')
const crypto = require('crypto')
const Service = require('./nsrvm-service')

const SERVICES_CONFIG = 'services/services-config.json'

/**
 * @typedef {object} ServiceConfig
 * @property {string} name - service name
 * @property {number} apiPort - service port
 * @property {string[]} allowedAPI - allowed services list
 */

class NSRVM {
  /**
   * @param {string} rootDir
   * @param {string} servicesDir
   * @param {string} [servicesConfigFilename]
   */
  constructor (rootDir, servicesDir, servicesConfigFilename = SERVICES_CONFIG) {
    this.servicesDir = servicesDir
    this.rootDir = rootDir
    this.servicesConfigFilename = path.resolve(rootDir, servicesConfigFilename)
    this.services = {}
    this.apiKeys = {}
    this.config = { services: {}, restartCmd: '' }
  }

  /**
   * @returns {Promise<void>}
   */
  async init () {
    process.on('SIGINT', async () => {
      console.log('NSRVM SIGINT received')
      await this.restartServer()
    })

    this.watchConfig()
    this.config = await NSRVM.loadConfig(this.servicesConfigFilename)
    this.generateAPIKeys()
    await this.runServices()
  }

  generateAPIKeys () {
    this.apiKeys = Object.keys(this.config.services).reduce((apiKeys, serviceName) => {
      apiKeys[serviceName] = crypto.randomBytes(16).toString('hex')
      return apiKeys
    }, {})
  }

  watchConfig () {
    fs.watchFile(this.servicesConfigFilename, async () => {
      console.log(`[NSRVM] Services config changed`)
      this.config = await NSRVM.loadConfig(this.servicesConfigFilename)
      await this.runServices()
    })
  }

  static validateConfig (config) {
    // TODO: validate config
    return typeof config === 'object' && config !== null && typeof config.services === 'object'
  }

  /**
   * @param {string} servicesConfigFilename
   * @returns {Promise<object>}
   */
  static async loadConfig (servicesConfigFilename) {
    try {
      const config = JSON.parse(await fs.promises.readFile(servicesConfigFilename, { encoding: 'utf-8' }))

      console.log('[NSRVM] Loaded config:', config)

      if (NSRVM.validateConfig(config)) {
        return config
      } else {
        console.log('[NSRVM] Bad config')
      }
    } catch (e) {
      console.error('loadConfig error:', e)
    }

    return { services: {}, restartCmd: '' }
  }

  /**
   * @returns {Promise<void>}
   */
  async runServices () {
    // Find differences between this.services & this.config.services
    const stopping = Object.values(this.services)
      .filter(service => !(service.config.name in this.config.services) || (service.config.apiPort !== this.config.services[service.config.name].apiPort))
      .map(service => this.stopService(service.config.name))

    if (stopping.length > 0) {
      console.log(`[NSRVM] Stopping ${stopping.length} services..`)
      await Promise.all(stopping)
    }

    // Start services
    const starting = Object.keys(this.config.services)
      .filter(serviceName => !(serviceName in this.services) || this.services[serviceName].dead)

    starting.forEach(serviceName => {
      if (!(serviceName in this.apiKeys)) {
        this.apiKeys[serviceName] = crypto.randomBytes(16).toString('hex')
      }
    })

    console.log(`[NSRVM] Starting ${starting.length} services..`)

    await Promise.all(starting.map(serviceName => this.startService(this.config.services[serviceName])))
  }

  /**
   * @param {string} serviceName
   * @returns {Promise<void>}
   */
  async stopService (serviceName) {
    console.log(`[NSRVM] Stopping ${serviceName}`)

    const service = this.services[serviceName]

    if (service) {
      delete this.services[serviceName]
      await service.stop()
    }
  }

  /**
   * @param {ServiceConfig} serviceConfig
   * @returns {Promise<void>}
   */
  async startService (serviceConfig) {
    console.log(`[NSRVM] Starting ${serviceConfig.name}`)

    const prevService = this.services[serviceConfig.name]

    if (prevService) {
      delete this.services[serviceConfig.name]
      await prevService.stop()
    }

    this.services[serviceConfig.name] = new Service(this, path.resolve(this.rootDir, this.servicesDir), serviceConfig)
  }

  /**
   * @param {NsrvmService} service
   * @param {object} msg
   * @param {string} msg.method
   * @param {string} [msg.serviceName]
   * @param {number} [msg._reqId]
   * @returns {Promise<?object>}
   */
  async query (service, msg) {
    switch (msg.method) {
      case 'getApiKey':
        if (NSRVM.checkPermissions(service, msg.serviceName)) {
          return this.getApiKeyQuery(msg.serviceName)
        } else {
          console.log(`[NSRVM] getApiKeyQuery by ${service.config.name} for ${msg.serviceName} failed: access denied`)
        }

        break

      case 'restartService':
        if (NSRVM.checkPermissions(service, 'nsrvm')) {
          await this.restartServiceQuery(msg.serviceName)
        }

        break

      case 'stopService':
        if (NSRVM.checkPermissions(service, 'nsrvm')) {
          await this.stopService(msg.serviceName)
        }

        break

      case 'startService':
        if (NSRVM.checkPermissions(service, 'nsrvm')) {
          await this.startServiceQuery(msg.serviceName)
        }

        break

      case 'restartServer':
        if (NSRVM.checkPermissions(service, 'nsrvm')) {
          await this.restartServer()
        }

        break

      case 'getServicesList':
        if (NSRVM.checkPermissions(service, 'nsrvm')) {
          return this.getServicesList()
        }

        break
    }
  }

  /**
   * @param {string} serviceName
   * @returns {{serviceName: string, apiPort: number|null, apiKey: string}}
   */
  getApiKeyQuery (serviceName) {
    const apiKey = this.apiKeys[serviceName]
    const serviceConfig = this.config.services[serviceName]

    if (!apiKey || !serviceConfig) {
      console.log(`[NSRVM] API key or config for ${serviceName} not found`)
      return { serviceName, apiPort: null, apiKey: '' }
    }

    return { serviceName, apiPort: serviceConfig.apiPort, apiKey }
  }

  /**
   * @returns {{services: Array<{serviceName: string, api: string[], status: boolean}>}}
   */
  getServicesList () {
    return {
      services: Object.keys(this.config.services)
        .map(serviceName => {
          const service = this.services[serviceName]

          return {
            serviceName,
            api: service ? service.api : [],
            status: !!service
          }
        })
    }
  }

  /**
   * @param {string} serviceName
   * @returns {Promise<void>}
   */
  async restartServiceQuery (serviceName) {
    console.log(`[NSRVM] restartServiceQuery ${serviceName}`)

    const serviceConfig = this.config.services[serviceName]

    if (serviceConfig) {
      await this.startService(serviceConfig)
    } else {
      console.log(`[NSRVM] Service config not found`)
      await this.stopService(serviceName)
    }
  }

  /**
   * @param {string} serviceName
   * @returns {Promise<void>}
   */
  async startServiceQuery (serviceName) {
    console.log(`[NSRVM] startServiceQuery ${serviceName}`)

    const serviceConfig = this.config.services[serviceName]

    if (serviceConfig) {
      const service = this.services[serviceName]

      if (!service || service.dead) {
        await this.startService(serviceConfig)
      }
    }
  }

  /**
   * @returns {Promise<void>}
   */
  async restartServer () {
    const services = this.services

    this.services = {}
    this.config = {}

    await Promise.all(Object.values(services).map(service => service.stop()))
    process.exit(0)
  }

  /**
   * @param {NsrvmService} service
   * @param {string} target
   * @returns {boolean}
   */
  static checkPermissions (service, target) {
    return service.config.allowedAPI.includes(target)
  }
}

module.exports = NSRVM
