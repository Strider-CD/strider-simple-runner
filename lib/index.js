
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
    this.io.on('job.status.*', function () {
      // proxy up job.status.* updates as browser events
      self.emitter.emit('browser.update', this.event, [].slice.call(arguments))
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

    // Backwards compat: TODO remove
    this.io.on('job.status.std*', function (id, text) {
      var which = this.event.split('.')[2]
        , data = {
            jobId: id,
            stdout: '',
            stderr: ''
          }
        , job = self.jobdata.get(id)
      data.userId = job.data.user_id
      // # seconds since it started
      data.timeElapsed = (new Date().getTime() - job.started.getTime())/1000
      data[which] = text
      data.repoUrl = job.provider.project.display_url
      self.emitter.emit('queue.job_update', data)
    })
    this.io.on('job.done', function (job) {
      self.emitter.emit('queue.job_complete', {
        stdout: job.std.out,
        stderr: job.std.err,
        stdmerged: job.std.merged,
        testExitCode: job.test_status,
        deployExitCode: job.deploy_status,
        tasks: [] // what are these??
      });
    });
    /*
    this.emitter.on('queue.new_job', function (old, more) {
      this.emitter.emit('job.new', oldJobToNew(old, more));
    });
    */
  },

  queueJob: function (job) {
    var now = new Date()
    this.jobdata.add(job.id)
    this.log('Got new job')
    this.emitter.emit('browser.update', 'job.status.queued', {id: job.id, time: now})
    this.queue.push(job)
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
  processJob: function (job, next) {
    var self = this
      , now = new Date()
    this.jobdata.get(job.id).started = now
    this.config.processJob(job, this.config, function (err) {
      var jobdata = self.jobdata.pop(job.id)
      if (err) {
        jobdata.errored = true
        jobdata.error = {
          message: err.message,
          stack: err.stack
        }
        self.emitter.emit('browser.update', 'job.status.errored', [job.id])
      }
      self.emitter.emit('job.done', jobdata)
      next(null)
    });
  }
};

