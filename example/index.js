'use strict'

const NSRVM = require('../src/nsrvm')

const SERVICES_DIR = 'services'

console.log('NSRVM')

const nsrvm = new NSRVM(__dirname, SERVICES_DIR)

nsrvm.init().catch(e => {
  console.error(e)
})
