'use strict'

const test = require('brittle')

test('client api surface', async t => {
  const { QVACRegistryClient } = require('../../index')
  t.ok(QVACRegistryClient, 'QVACRegistryClient class exists')

  t.ok(typeof QVACRegistryClient === 'function', 'QVACRegistryClient is a constructor')
  t.ok(QVACRegistryClient.prototype.getModel, 'has getModel method')
  t.ok(QVACRegistryClient.prototype.downloadModel, 'has downloadModel method')
  t.ok(QVACRegistryClient.prototype.findBy, 'has findBy method')
  t.ok(QVACRegistryClient.prototype.ready, 'has ready method')
  t.ok(QVACRegistryClient.prototype.close, 'has close method')

  // Verify old methods are removed
  t.absent(QVACRegistryClient.prototype.findModels, 'findModels method removed')
  t.absent(QVACRegistryClient.prototype.findModelsByEngine, 'findModelsByEngine method removed')
  t.absent(QVACRegistryClient.prototype.findModelsByName, 'findModelsByName method removed')
  t.absent(QVACRegistryClient.prototype.findModelsByQuantization, 'findModelsByQuantization method removed')
})

test('client findBy is async function', async t => {
  const QVACRegistryClient = require('../../lib/client')

  t.ok(QVACRegistryClient.prototype.findBy.constructor.name === 'AsyncFunction', 'findBy is async')
})
