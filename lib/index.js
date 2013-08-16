
var _ = require('lodash')
  , path = require('path')
  , async = require('async')
  , EventEmitter2 = require('eventemitter2').EventEmitter2

  , core = require('strider-runner-core')

  , JobData = require('./jobdata')

module.exports = Runner

/*
 * Options:
 *    pty: use 'pty'
 *    logger:
 *    pluginDir: the directory in which to look for plugins
 *    dataDir: the directory in which to clone/test/etc
 */
function Runner(emitter, config) {
  var dotStrider = path.join(process.env.HOME || '/', '.strider')
  this.config = _.extend({
    pty: false,
    logger: console,
    processJob: core.process,
    pluginDir: path.join(__dirname, '../node_modules'),
    dataDir: process.env.STRIDER_CLONE_DEST || dotStrider
  }, config)
  this.emitter = emitter
  this.log = this.config.logger.log
  this.queue = async.queue(this.processJob.bind(this), 1)
  this.io = new EventEmitter2()
  this.hooks = []
  this.jobdata = new JobData(this.io)
  this.attach()
}

Runner.prototype = {
  // public API

  // private API
  attach: function () {
    var self = this
    this.emitter.on('job.new', this.queueJob.bind(this))
    this.emitter.on('job.cancel', this.cancelJob.bind(this))
    this.io.on('job.status.*', function () {
      // proxy up job.status.* updates as browser events
      self.emitter.emit('browser.update', this.event, [].slice.call(arguments))
    })
    this.io.on('job.cancelled', function (id) {
      self.emitter.emit('job.cancelled', id, self.jobdata.pop(id))
      // our running job was cancelled, so we need to start the next one
      async.setImmediate(self.queue.process)
    })
  },
  queueJob: function (task) {
    var now = new Date()
    this.jobdata.add(task.job.id)
    this.log('Got new job')
    this.emitter.emit('browser.update', 'job.status.queued', {id: task.job.id, time: now})
    this.queue.push(task)
  },
  cancelJob: function (id) {
    for (var i=0; i<this.queue.tasks.length; i++) {
      if (this.queue.tasks[i].data.job.id === id) {
        this.queue.tasks.splice(i, 1)
        this.emitter.emit('job.cancelled', id, this.jobdata.pop(id))
        return
      }
    }
    // if it wasn't found in the queue, fire to the worker in case it is in process
    this.io.emit('job.cancel', id)
  },
  processJob: function (task, next) {
    var self = this
      , now = new Date()
    this.jobdata.get(task.job.id).started = now
    this.config.processJob(task, this.config, function (err) {
      var job = self.jobdata.pop(task.job.id)
      if (err) {
        job.errored = true
        job.error = {
          message: err.message,
          stack: err.stack
        }
        self.emitter.emit('browser.update', 'job.status.errored', [task.job.id])
      }
      self.emitter.emit('job.done', job)
      next(null)
    });
  }
};

