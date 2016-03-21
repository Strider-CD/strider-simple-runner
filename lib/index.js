
var fs = require('fs-extra')
  , path = require('path')

  , _ = require('lodash')
  , async = require('async')
  , EventEmitter2 = require('eventemitter2').EventEmitter2
  , Loader = require('strider-extension-loader')

  , core = require('strider-runner-core')

  , cachier = require('./cachier')
  , keeper  = require('dirkeeper')
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
  this.callbackMap = {}
  this.hooks = []
  this.jobdata = new JobData(this.io)
  this.attach()
}

// base: the base directory where all jobs data is stored
// the job object.
// done(err, {base:, data:, cache:})
function initJobDirs(base, job, cache, done) {
  var name = job.project.name
    , dirs = {
        base: base,
        data: path.join(base, "data", name.replace('/','-') + "-" + job._id.toString()),
        cache: cache
      }

  async.series([
    function checkData(next) {
      fs.exists(dirs.data, function (exists) {
        if (!exists) return next()
        fs.remove(dirs.data, function () {
          next()
        })
      })
    },
    fs.mkdirp.bind(null, dirs.data),
    fs.mkdirp.bind(null, dirs.cache),
  ], function (err, results) {
    done(err, dirs)
  })
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

  getJobData: function (id) {
    return this.jobdata.get(id)
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
    this.emitter.on('job.info', function (id, respond) {
      var job = self.jobdata.get(id)
      if (job) respond(job)
    })
    function proxy(id) {
      // proxy up job.status.* updates as browser events
      var job = self.jobdata.get(id)
        , project = job && job.data.project.name
      if (!job) return
      self.emitter.emit('browser.update', project, this.event, [].slice.call(arguments))
    }
    this.io.on('job.status.**', proxy)
    this.io.on('job.cancelled', function (id) {
      // our running job was cancelled, so we need to start the next one
      var jobdata = self.jobdata.pop(id)
      self.emitter.emit('job.cancelled', id, jobdata)
      if (!jobdata) {
        jobdata = {
          _id: id
        }
        console.error('Job cancelled, but no data!', id)
      }
      jobdata.errored = true
      jobdata.error = {
        message: 'Cancelled by the user'
      }
      // self.emitter.emit('browser.update', job.project.name, 'job.status.errored', [job._id, jobdata.error])
      delete jobdata.data
      jobdata.finished = new Date()
      self.emitter.emit('job.done', jobdata)
      if (!self.callbackMap[id]) {
        console.error('Job cancelled, but no callback found. The queue is probably broken.')
        return self.queue.process()
      }
      self.callbackMap[id]()
      delete self.callbackMap[id]
    })
    // proxy up plugin events
    this.io.on('plugin.**', function () {
      self.emitter.emit.apply(self.emitter, [this.event].concat([].slice.call(arguments)))
    })
  },

  queueJob: function (job, config) {
    if (config.runner.id !== this.id) return
    var now = new Date()
    this.jobdata.add(job)
    this.log('[runner:' + this.id + '] Queued new job. Project: ' + job.project.name + ' Job ID: ' + job._id)
    this.emitter.emit('browser.update', job.project.name, 'job.status.queued', [job._id, now])
    this.queue.push({job: job, config: config})
  },

  cancelJob: function (id) {
    var jobdata
    for (var i=0; i<this.queue.tasks.length; i++) {
      if (this.queue.tasks[i].data.job._id.toString() === id.toString()) {
        this.queue.tasks.splice(i, 1)
        this.log('[runner:' + this.id + '] Cancelled job. Job ID: ' + id)
        jobdata = this.jobdata.pop(id)
        jobdata.errored = true
        jobdata.error = {
          message: 'Cancelled by the user'
        }
        // self.emitter.emit('browser.update', job.project.name, 'job.status.errored', [job._id, jobdata.error])
        delete jobdata.data
        jobdata.started = new Date()
        jobdata.finished = new Date()
        this.emitter.emit('job.done', jobdata)
        return
      }
    }
    // if it wasn't found in the queue, fire to the worker in case it is in process
    this.io.emit('job.cancel', id)
  },

  // initialize the provider and job plugins for a job
  // dirs = {base:, data:, cache:}
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
      var finished = t(function (err, provider) {
        if (provider) provider.id = job.project.provider.id
        next(err, provider)
      })
      if (!plugin.hosted) {
        return plugin.init(dirs, job.providerConfig, job, finished)
      }
      plugin.init(dirs, user.account(job.project.provider).config, job.providerConfig, job, finished)
    }]
    // XXX: do we want/need more things in the context? See
    // extension-loader readme for what gets passed in to the
    // individual phase functions as "Phase context"
    var context = {
      baseDir: dirs.base,
      dataDir: dirs.data,
      cacheDir: dirs.cache
    }
    var bad = config.plugins.some(function (plugin) {
      if (false === plugin.enabled) {
        self.log('[runner:' + self.id + '] Found a disabled plugin: ' +  plugin.id + ' Project: ' + job.project.name +' Job ID: ' + job._id)
        return
      }
      if (!self.extensions.job[plugin.id]) {
        self.log('[runner:' + self.id + '] Error: Plugin not found ' +  plugin.id + ' Project: ' + job.project.name +' Job ID: ' + job._id)
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

  cacheDir: function (project) {
    return path.join(this.config.dataDir, 'cache', project.name)
  },

  getCache: function (project) {
    return cachier(this.cacheDir(project))
  },

  clearCache: function (project, done) {
    fs.remove(this.cacheDir(project), function (err) {
      done(err && new Error('Failed to clear the cache. Error code: ' + err))
    })
  },

  processJob: function (data, next) {
    var job = data.job
      , config = data.config
      , cache = this.getCache(job.project)
      , now = new Date()
      , self = this
      , oldnext = next
    next = function () {
      delete self.callbackMap[job._id]
      oldnext()
    }
    this.callbackMap[job._id] = next
    // Keep around N most recent build directories.
    // Default is 0, ie wipe at start of each run.
    // Later, this can be configurable in the UI.
    keeper({baseDir: path.join(this.config.dataDir, "data"), count: 0}, function(err) {
      initJobDirs(self.config.dataDir, job, cache.base, jobDirsReady)
    })

    var jobDirsReady = function(err, dirs) {
      if (err) {
        var jobdata = self.jobdata.pop(job._id)
        if (!jobdata) return next(null)
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
      self.jobdata.get(job._id).started = now
      self.emitter.emit('browser.update', job.project.name, 'job.status.started', [job._id, now])
      self.log('[runner:' + self.id + '] Job started. Project: ' + job.project.name +' Job ID: ' + job._id)
      self.plugins(job.project.creator, config, job, dirs, function (err, workers) {
        if (err) {
          var jobdata = self.jobdata.pop(job._id)
          if (!jobdata) return next(null)
          jobdata.errored = true
          jobdata.error = {
            message: err.message,
            stack: err.stack
          }
          // self.emitter.emit('browser.update', job.project.name, 'job.status.errored', [job._id, jobdata.error])
          delete jobdata.data
          jobdata.finished = new Date()
          self.emitter.emit('job.done', jobdata)
          self.log('[runner:' + self.id + '] Job done with error. Project: ' + job.project.name + ' Job ID: ' + job._id)
          next(null)
          return
        }
        var env = {}
        if (config.envKeys) {
          env.STRIDER_SSH_PUB = config.pubkey
          env.STRIDER_SSH_PRIV = config.privkey
        }
        self.config.processJob(job, workers.provider, workers.jobplugins, {
          cachier: cache,
          baseDir: dirs.base,
          dataDir: dirs.data,
          cacheDir: dirs.cache,
          io: self.config.io,
          branchConfig: config,
          env: env,
          log: console.log,
          error: console.error,
          logger: console
        }, function (err) {
          var jobdata = self.jobdata.pop(job._id)
          if (!jobdata) return next(null)
          if (err) {
            jobdata.errored = true
            jobdata.error = {
              message: err.message,
              stack: err.stack
            }
            self.emitter.emit('browser.update', job.project.name, 'job.status.errored', [job._id, jobdata.error])
            self.log('[runner:' + self.id + '] Job done with error. Project: ' + job.project.name + ' Job ID: ' + job._id)
          }
          delete jobdata.data
          jobdata.finished = new Date()
          self.emitter.emit('job.done', jobdata)
          self.log('[runner:' + self.id + '] Job done without error. Project: ' + job.project.name + ' Job ID: ' + job._id)
          next(null)
        })
      })
    };
  }
};

