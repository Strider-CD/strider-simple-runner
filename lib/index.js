
var fs = require('fs')
  , path = require('path')

  , _ = require('lodash')
  , async = require('async')
  , mkdirp = require('mkdirp')
  , EventEmitter2 = require('eventemitter2').EventEmitter2
  , Loader = require('strider-extension-loader')

  , core = require('strider-runner-core')

  , JobData = require('./jobdata')

// timeout for callbacks. Helps to kill misbehaving plugins, etc
function t(time, done) {
  if (arguments.length === 1) {
    done = time
    time = 2000
  }
  var error = new Error('Callback took too long (max: ' + time + ')')
  var waiting = true
  function handler() {
    if (!waiting) return
    clearTimeout(timeout)
    waiting = false
    done.apply(this, arguments)
  }
  var timeout = setTimeout(function () {
    if (!waiting) return
    waiting = false
    done(error)
  }, time)
  return handler
}

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
  console.log('RUNNER INIT')
  var dotStrider = path.join(process.env.HOME || '/', '.strider')
  this.config = _.extend({
    pty: false,
    io: new EventEmitter2({
      wildcard: true
    }),
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

function initDataDir(baseDir, job) {
  // XXX this doesn't support "pull only"; it will always clone a new repo.
  var name = job.project.name.replace('/', '.') + '-' + job._id
    , dataDir = path.join(baseDir, name)
  if (!fs.existsSync(dataDir)) {
    mkdirp.sync(dataDir)
  }
  return dataDir
}

Runner.prototype = {
  id: 'simple-runner',
  
  // public API
  loadExtensions: function (dirs, done) {
    var self = this
      , loader = new Loader()
    loader.collectExtensions(dirs, function (err) {
      if (err) return done(err)
      loader.initWorkerExtensions({}, function (err, extensions) {
        if (err) return done(err)
        self.extensions = extensions
        done(null)
      })
    })
  },

  // Determine which jobs are zombies. This is called when strider
  // starts up.
  //
  // jobs: unfinished jobs that belong to this runner
  // done(err, zombies)
  findZombies: function (jobs, done) {
    done(null, jobs)
  },

  // private API
  attach: function () {
    var self = this
    this.emitter.on('job.new', this.queueJob.bind(this))
    this.emitter.on('job.cancel', this.cancelJob.bind(this))
    this.io.on('job.status.*', function (id) {
      // console.log('job status: ', this.event, id, [].slice.call(arguments))
      // proxy up job.status.* updates as browser events
      var project = self.jobdata.get(id).data.project.name
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
    console.log('runner IO', this.io)
  },

  queueJob: function (job, config) {
    if (config.runner.id !== this.id) return
    var now = new Date()
    this.jobdata.add(job)
    this.log('[runner:' + this.id + '] Got new job')
    this.emitter.emit('browser.update', job.project.name, 'job.status.queued', {id: job._id, time: now})
    this.queue.push({job: job, config: config})
  },

  cancelJob: function (id) {
    for (var i=0; i<this.queue.tasks.length; i++) {
      if (this.queue.tasks[i].data.job._id === id) {
        this.queue.tasks.splice(i, 1)
        this.emitter.emit('job.cancelled', id, this.jobdata.pop(id))
        return
      }
    }
    // if it wasn't found in the queue, fire to the worker in case it is in process
    this.io.emit('job.cancel', id)
  },

  // initialize the provider and job plugins for a job
  plugins: function (user, config, job, dataDir, done) {
    console.log('plugins for', dataDir)
    var self = this
      , extensions = self.extensions
    var tasks = [function (next) {
      var plugin = self.extensions.provider[job.project.provider.id]
      if (!plugin) return next(new Error('Provider plugin "' + job.project.provider.id + '" not found in this environment!'))
      console.log('Initializing provider', job.project.provider.id)
      plugin.init(dataDir, user.providers[job.project.provider.id], job.project.provider.config, job, t(function (err, provider) {
        if (provider) provider.id = job.project.provider.id
        next(err, provider)
      }))
    }]
    // XXX: do we want/need more things in the context? See
    // extension-loader readme for what gets passed in to the
    // individual phase functions as "Phase context"
    var context = {
      dataDir: dataDir
    }
    config.plugins.forEach(function (plugin) {
      if (!plugin.enabled) return
      if (!self.extensions.job[plugin.id]) {
        return done(new Error('Plugin required but not found: ' + plugin.id))
      }
      tasks.push(function (next) {
        self.extensions.job[plugin.id].init(user.jobplugins[plugin.id], plugin.config, job, context, t(function (err, obj) {
          if (obj) obj.id = plugin.id
          next(err, obj)
        }))
      })
    })
    async.parallel(tasks, function (err, results) {
      if (err) return done(err)
      console.log('yeah', results)
      done(null, {
        provider: results.shift(),
        jobplugins: results
      })
    })
  },

  processJob: function (data, next) {
    var job = data.job
      , config = data.config
      , dataDir = initDataDir(this.dataDir, job)
      , now = new Date()
      , self = this
    this.jobdata.get(job._id).started = now
    this.emitter.emit('browser.update', job.project.name, 'job.status.started', [job._id, now])
    this.plugins(job.project.creator, config, job, dataDir, function (err, workers) {
      if (err) return next(err)
      console.log('going to process', dataDir)
      self.config.processJob(job, workers.provider, workers.jobplugins, {
        dataDir: dataDir,
        io: self.config.io,
        log: console.log,
        error: console.error,
        logger: console
      }, function (err) {
        var jobdata = self.jobdata.pop(job._id)
        if (err) {
          jobdata.errored = true
          jobdata.error = {
            message: err.message,
            stack: err.stack
          }
          self.emitter.emit('browser.update', job.project.name, 'job.status.errored', [job._id, jobdata.error])
        }
        delete jobdata.data
        jobdata.finished = new Date()
        self.emitter.emit('job.done', jobdata)
        next(null)
      })
    })
  }
};

