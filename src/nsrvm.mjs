import path from 'path'
import fs from 'fs'
import crypto from 'crypto'
import Service from './nsrvm-service.mjs'

const SERVICES_CONFIG = 'services/services-config.json'

/**
 * @typedef {object} ServiceConfig
 * @property {string} [parent] - parent service name
 * @property {string} name - service name
 * @property {string} [modulePath] - entry point
 * @property {number} apiPort - service port
 * @property {string[]} allowedAPI - allowed services list
 * @property {number} [maxChilds=0] - maximum childs cnt
 */

export default class NSRVM {
  /**
   * @param {string} rootDir
   * @param {string} servicesDir
   * @param {string} [servicesConfigFilename]
   */
  constructor (rootDir, servicesDir, servicesConfigFilename = SERVICES_CONFIG) {
    this.servicesDir = servicesDir
    this.rootDir = rootDir
    this.servicesConfigFilename = path.resolve(rootDir, servicesConfigFilename)
    this.services = /** @type {Object<name, NsrvmService>} */ {}
    this.childs = /** @type {Object<name, ServiceConfig[]>} */ {}
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
    this.config = await this.loadConfig(this.servicesConfigFilename)
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
      this.config = await this.loadConfig(this.servicesConfigFilename)

      // Assign childs
      for (const parentName of Object.keys(this.childs)) {
        const configs = this.childs[parentName]
        const parent = this.services[parentName]

        if (parent) {
          this.assignChilds(parent, configs)
        } else if (!(parentName in this.config.services)) {
          console.log(`[NSRVM] delete ${parentName} childs`)
          delete this.childs[parentName]
        }
      }

      await this.runServices()
    })
  }

  /**
   * @param {NsrvmService} parent
   * @param {ServiceConfig[]} configs
   */
  async setChildServices (parent, configs) {
    console.log(`[NSRVM] Set child services for '${parent.config.name}'`)

    const childs = this.childs[parent.config.name] || (this.childs[parent.config.name] = [])

    // Remove deleted configs
    for (const oldConfig of childs) {
      if (!configs.some(newConfig => newConfig.name === oldConfig.name)) {
        console.log(`[NSRVM] Remove service '${parent.config.name}.${oldConfig.name}'`)
        delete this.config.services[oldConfig.name]

        // Remove permissions
        const idx = parent.config.allowedAPI.findIndex(name => name === oldConfig.name)

        if (idx !== -1) {
          parent.config.allowedAPI.splice(idx, 1)
        }
      }
    }

    for (const config of configs) {
      this.patchConfig(config)

      const prevConfig = this.config.services[config.name]

      // Skip if service with the same name started by other
      if (prevConfig && prevConfig.parent !== parent.config.name) {
        console.error(`[NSRVM] Service ${config.name} already started by ${config.parent || 'NSRVM'}`)
      } else {
        childs.push(config)
      }
    }

    this.assignChilds(parent, childs)

    // Start new services/stop deleted services
    await this.runServices()
  }

  /**
   * @param {NsrvmService} service
   * @param {ServiceConfig[]} configs
   */
  assignChilds (service, configs) {
    for (const config of configs) {
      console.log(`[NSRVM] Add child ${config.name} to ${service.config.name}. Config:`, config)

      config.parent = service.config.name

      // Append new service (or refresh exiting config)
      this.config.services[config.name] = config

      // Add permissions
      if (!service.config.allowedAPI.includes(config.name)) {
        service.config.allowedAPI.push(config.name)
      }
    }
  }

  /**
   * @param {ServiceConfig} config
   * @returns {boolean}
   */
  static validateConfig (config) {
    // TODO: validate config
    return typeof config === 'object' && config !== null && typeof config.services === 'object'
  }

  /**
   * @param {string} servicesConfigFilename
   * @returns {Promise<object>}
   */
  async loadConfig (servicesConfigFilename) {
    try {
      const config = JSON.parse(await fs.promises.readFile(servicesConfigFilename, { encoding: 'utf-8' }))

      console.log('[NSRVM] Loaded config:', config)

      if (NSRVM.validateConfig(config)) {
        for (const serviceConfig of Object.values(config.services)) {
          this.patchConfig(serviceConfig)
        }

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
   * @param {ServiceConfig} config
   */
  patchConfig (config) {
    if (!('maxChilds' in config)) {
      config.maxChilds = 0
    }
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

    const toStart = []

    // Update configs
    for (const config of Object.values(this.config.services)) {
      const service = this.services[config.name]

      if (!(config.name in this.apiKeys)) {
        this.apiKeys[config.name] = crypto.randomBytes(16).toString('hex')
      }

      if (service) {
        service.config = config
      }

      if (!service || service.dead) {
        toStart.push(config.name)
      }
    }

    if (toStart.length) {
      console.log(`[NSRVM] Starting ${toStart.length} services..`)
      await Promise.all(toStart.map(serviceName => this.startService(this.config.services[serviceName])))
    }
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
   * @returns {Promise<string>}
   */
  async resolveModulePath (serviceConfig) {
    const name = serviceConfig.modulePath || serviceConfig.name

    try {
      const modulePath = path.resolve(this.rootDir, this.servicesDir, name)
      const stat = await fs.promises.stat(modulePath)

      if (stat.isDirectory()) {
        try {
          const modulePath = path.resolve(this.rootDir, this.servicesDir, name, 'index.mjs')
          const stat = await fs.promises.stat(modulePath)

          return stat.isFile() ? modulePath : ''
        } catch {}

        try {
          const modulePath = path.resolve(this.rootDir, this.servicesDir, name, 'index.js')
          const stat = await fs.promises.stat(modulePath)

          return stat.isFile() ? modulePath : ''
        } catch {}

        return ''
      } else {
        return modulePath
      }
    } catch {}

    try {
      const modulePath = path.resolve(this.rootDir, this.servicesDir, `${name}.mjs`)
      const stat = await fs.promises.stat(modulePath)

      return stat.isFile() ? modulePath : ''
    } catch {}

    try {
      const modulePath = path.resolve(this.rootDir, this.servicesDir, `${name}.js`)
      const stat = await fs.promises.stat(modulePath)

      return stat.isFile() ? modulePath : ''
    } catch {}

    return ''
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

    const servicePath = await this.resolveModulePath(serviceConfig)

    if (!servicePath) {
      console.error(`Module ${serviceConfig.name} not found!`)
      return
    }

    const service = this.services[serviceConfig.name] = new Service(this, servicePath, serviceConfig)
    const childs = this.childs[serviceConfig.name]

    if (childs) {
      this.assignChilds(service, childs)
    }

    service.start()
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
          return { status: true }
        }

        break

      case 'stopService':
        if (NSRVM.checkPermissions(service, 'nsrvm')) {
          await this.stopService(msg.serviceName)
          return { status: true }
        }

        break

      case 'startService':
        if (NSRVM.checkPermissions(service, 'nsrvm')) {
          await this.startServiceQuery(msg.serviceName)
          return { status: true }
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
