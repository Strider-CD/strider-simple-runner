
var _ = require('lodash')
  , path = require('path')
  , async = require('async')
  , EventEmitter2 = require('eventemitter2').EventEmitter2
  , Loader = require('strider-extension-loader')

  , core = require('strider-runner-core')

  , JobData = require('./jobdata')

module.exports = Runner

/*
 * Options:
 *    pty: use 'pty'
 *    logger:
 *    io: the means of communication with the job worker
 *    pluginDir: the directory in which to look for plugins
 *    dataDir: the directory in which to clone/test/etc
 */
function Runner(emitter, config) {
  var dotStrider = path.join(process.env.HOME || '/', '.strider')
  this.config = _.extend({
    pty: false,
    io: new EventEmitter2(),
    logger: console,
    processJob: core.process,
    pluginDir: path.join(__dirname, '../node_modules'),
    dataDir: process.env.STRIDER_CLONE_DEST || dotStrider
  }, config)
  this.emitter = emitter
  this.log = this.config.logger.log
  this.queue = async.queue(this.processJob.bind(this), 1)
  this.io = this.config.io
  this.hooks = []
  this.jobdata = new JobData(this.io)
  this.attach()
}

Runner.prototype = {
  id: 'runner',
  
  // public API
  loadExtensions: function (dirs, done) {
    var self = this
      , loader = new Loader()
    loader.collectExtensions(require.main.paths, function (err) {
      if (err) return done(err)
      loader.initWorkerExtensions(self.getContext(), function (err, extensions) {
        if (err) return done(err)
        self.extensions = extensions
        done(null)
      })
    })
  },

  getContext: function () {
    return {}
  },

  // private API
  attach: function () {
    var self = this
    this.emitter.on('job.new', this.queueJob.bind(this))
    this.emitter.on('job.cancel', this.cancelJob.bind(this))
    this.io.on('job.status.*', function (id) {
      // proxy up job.status.* updates as browser events
      var project = this.jobdata.get(id).data.project.name
      self.emitter.emit('browser.update', project, this.event, [].slice.call(arguments))
    })
    this.io.on('job.cancelled', function (id) {
      self.emitter.emit('job.cancelled', id, self.jobdata.pop(id))
      // our running job was cancelled, so we need to start the next one
      async.setImmediate(self.queue.process)
    })
    // proxy up plugin events
    this.io.on('plugin.*', function () {
      self.emitter.emit.apply(self.emitter, [this.event].concat([].slice.call(arguments)))
    })
  },

  queueJob: function (job, config) {
    if (job.runner.id !== this.id) return
    var now = new Date()
    this.jobdata.add(job)
    this.log('Got new job')
    this.emitter.emit('browser.update', 'job.status.queued', {id: job.id, time: now})
    this.queue.push([job, config])
  },

  cancelJob: function (id) {
    for (var i=0; i<this.queue.tasks.length; i++) {
      if (this.queue.tasks[i].data.id === id) {
        this.queue.tasks.splice(i, 1)
        this.emitter.emit('job.cancelled', id, this.jobdata.pop(id))
        return
      }
    }
    // if it wasn't found in the queue, fire to the worker in case it is in process
    this.io.emit('job.cancel', id)
  },

  plugins: function (config) {
    // TODO work here
    return {
      provider: {},
      plugins: []
    }
  },

  processJob: function (data, next) {
    var job = data[0]
      , config = data[1]
      , now = new Date()
      , self = this
    this.jobdata.get(job.id).started = now
    this.emitter.emit('browser.update', 'job.status.started', [job.id, now])
    this.config.processJob(job, config, function (err) {
      var jobdata = self.jobdata.pop(job.id)
      if (err) {
        jobdata.errored = true
        jobdata.error = {
          message: err.message,
          stack: err.stack
        }
        self.emitter.emit('browser.update', 'job.status.errored', [job.id])
      }
      delete jobdata.data
      self.emitter.emit('job.done', jobdata)
      next(null)
    });
  }
};

