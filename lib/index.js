
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

function initDataDir(base, job) {
  // XXX this doesn't support "pull only"; it will always clone a new repo.
  var name = job.project.name.replace('/', '.') + '-' + job._id
    , baseDir = path.join(base, name)
    , dataDir = path.join(baseDir, 'code')
  if (!fs.existsSync(dataDir)) {
    mkdirp.sync(dataDir)
  }
  return [baseDir, dataDir]
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
    function proxy(id) {
      // proxy up job.status.* updates as browser events
      var job = self.jobdata.get(id)
        , project = job && job.data.project.name
      if (!job) return
      self.emitter.emit('browser.update', project, this.event, [].slice.call(arguments))
    }
    this.io.on('job.status.*', proxy)
    this.io.on('job.status.*.*', proxy)
    this.io.on('job.status.*.*.*', proxy)
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
    if (config.runner.id !== this.id) return
    var now = new Date()
    this.jobdata.add(job)
    this.log('[runner:' + this.id + '] Got new job')
    this.emitter.emit('browser.update', job.project.name, 'job.status.queued', [job._id, now])
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
  // dirs = [baseDir, dataDir]
  plugins: function (user, config, job, dirs, done) {
    var self = this
      , extensions = self.extensions
    var tasks = [function (next) {
      var plugin = self.extensions.provider[job.project.provider.id]
        , msg
      if (!plugin) {
        msg = 'Provider plugin "' + job.project.provider.id + '" not found in this environment!'
        return next(new Error(msg))
      }
      console.log('Initializing provider', job.project.provider.id)
      var finished = t(function (err, provider) {
        if (provider) provider.id = job.project.provider.id
        next(err, provider)
      })
      if (!plugin.hosted) {
        return plugin.init(dirs[1], job.project.provider.config, job, finished)
      }
      plugin.init(dirs[1], user.account(job.project.provider), job.project.provider.config, job, finished)
    }]
    // XXX: do we want/need more things in the context? See
    // extension-loader readme for what gets passed in to the
    // individual phase functions as "Phase context"
    var context = {
      baseDir: dirs[0],
      dataDir: dirs[1]
    }
    var bad = config.plugins.some(function (plugin) {
      if (!plugin.enabled) {
        console.warn('I got a disabled plugin', plugin)
        return
      }
      if (!self.extensions.job[plugin.id]) {
        console.warn('Plugin not found', plugin.id)
        done(new Error('Plugin required but not found: ' + plugin.id))
        return true
      }
      tasks.push(function (next) {
        var fn = self.extensions.job[plugin.id].init
          , cb = t(function (err, obj) {
              if (obj) obj.id = plugin.id
              next(err, obj)
            })
        if (fn.length === 3) fn(plugin.config, context, cb)
        else if (fn.length === 4) fn(plugin.config, job, context, cb)
        else fn(user.jobplugins && user.jobplugins[plugin.id], plugin.config, job, context, cb)
      })
    })
    if (bad) return
    async.parallel(tasks, function (err, results) {
      if (err) return done(err)
      done(null, {
        provider: results.shift(),
        jobplugins: results
      })
    })
  },

  processJob: function (data, next) {
    var job = data.job
      , config = data.config
      , dirs = initDataDir(this.config.dataDir, job)
      , now = new Date()
      , self = this
    this.jobdata.get(job._id).started = now
    this.emitter.emit('browser.update', job.project.name, 'job.status.started', [job._id, now])
    this.plugins(job.project.creator, config, job, dirs, function (err, workers) {
      if (err) {
        var jobdata = self.jobdata.pop(job._id)
        jobdata.errored = true
        jobdata.error = {
          message: err.message,
          stack: err.stack
        }
        // self.emitter.emit('browser.update', job.project.name, 'job.status.errored', [job._id, jobdata.error])
        delete jobdata.data
        jobdata.finished = new Date()
        self.emitter.emit('job.done', jobdata)
        next(null)
        return
      }
      self.config.processJob(job, workers.provider, workers.jobplugins, {
        baseDir: dirs[0],
        dataDir: dirs[1],
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

