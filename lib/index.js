'use strict';

var fs = require('fs-extra');
var path = require('path');
var _ = require('lodash');
var async = require('async');
var debug = require('debug')('strider-simple-runner');
var EventEmitter2 = require('eventemitter2').EventEmitter2;
var Loader = require('strider-extension-loader');
var core = require('strider-runner-core');
var keeper = require('dirkeeper');
var cachier = require('./cachier');
var JobData = require('./jobdata');
var JobQueue = require('./jobqueue');
var branchFromJob = require('./utils').branchFromJob;

// timeout for callbacks. Helps to kill misbehaving plugins, etc
function t(time, done) {
  if (arguments.length === 1) {
    done = time;
    time = 2000;
  }
  var error = new Error(`Callback took too long (max: ${time})`);
  var waiting = true;

  var timeout = setTimeout(function () {
    if (!waiting) return;
    waiting = false;
    done(error);
  }, time);

  function handler() {
    if (!waiting) return;
    clearTimeout(timeout);
    waiting = false;
    done.apply(this, arguments);
  }

  return handler;
}

module.exports = Runner;

/*
 * Options:
 *    pty: use 'pty'
 *    io: the means of communication with the job worker
 *    pluginDir: the directory in which to look for plugins
 *    dataDir: the directory in which to clone/test/etc
 */
function Runner(emitter, config) {
  debug('RUNNER INIT');
  var dotStrider = path.join(process.env.HOME || '/', '.strider');
  this.config = _.extend({
    pty: false,
    io: new EventEmitter2({
      wildcard: true
    }),
    processJob: core.process,
    pluginDir: path.join(__dirname, '../node_modules'),
    dataDir: process.env.STRIDER_CLONE_DEST || dotStrider,
    concurrentJobs: parseInt(process.env.CONCURRENT_JOBS || '1', 10) || 1,
    defaultRecentBuilds: parseInt(process.env.DEFAULT_RECENT_BUILDS || '1', 10) || 1
  }, config);
  this.emitter = emitter;
  this.queue = new JobQueue(this.processJob.bind(this), this.config.concurrentJobs);
  this.io = this.config.io;
  this.callbackMap = {};
  this.hooks = [];
  this.jobdata = new JobData(this.io);
  this.attach();
}

// base: the base directory where all jobs data for this project and branch is stored
// the job object.
// done(err, {base:, data:, cache:})
function initJobDirs(branchBase, job, cache, done) {
  var dirs = {
    base: branchBase,
    data: path.join(branchBase, `job-${job._id.toString()}`),
    cache: cache
  };

  async.series([
    function checkData(next) {
      fs.exists(dirs.data, function (exists) {
        if (!exists) return next();
        fs.remove(dirs.data, function () {
          next();
        });
      });
    },
    fs.mkdirp.bind(null, dirs.data),
    fs.mkdirp.bind(null, dirs.cache)
  ], function (err) {
    done(err, dirs);
  });
}

Runner.prototype = {
  id: 'simple-runner',

  // public API
  loadExtensions: function (dirs, done) {
    var self = this;
    var loader = new Loader();
    loader.collectExtensions(dirs, function (err) {
      if (err) return done(err);
      loader.initWorkerExtensions({}, function (err, extensions) {
        if (err) return done(err);
        self.extensions = extensions;
        done(null);
      });
    });
  },

  getJobData: function (id) {
    return this.jobdata.get(id);
  },

  // Determine which jobs are zombies. This is called when strider
  // starts up.
  //
  // jobs: unfinished jobs that belong to this runner
  // done(err, zombies)
  findZombies: function (jobs, done) {
    done(null, jobs);
  },

  // private API
  attach: function () {
    var self = this;
    this.emitter.on('job.new', this.queueJob.bind(this));
    this.emitter.on('job.cancel', this.cancelJob.bind(this));
    this.emitter.on('job.info', function (id, respond) {
      var job = self.jobdata.get(id);
      if (job) respond(job);
    });
    function proxy(id) {
      // proxy up job.status.* updates as browser events
      var job = self.jobdata.get(id);
      var project = job && job.data.project.name;
      if (!job) return;
      self.emitter.emit('browser.update', project, this.event, [].slice.call(arguments));
    }

    this.io.on('job.status.**', proxy);
    this.io.on('job.cancelled', function (id) {
      // our running job was cancelled, so we need to start the next one
      var jobdata = self.jobdata.pop(id);
      self.emitter.emit('job.cancelled', id, jobdata);
      if (!jobdata) {
        jobdata = {
          _id: id
        };
        debug('Job cancelled, but no data!', id);
      }
      jobdata.errored = true;
      jobdata.error = {
        message: 'Cancelled by the user'
      };
      // self.emitter.emit('browser.update', job.project.name, 'job.status.errored', [job._id, jobdata.error])
      delete jobdata.data;
      jobdata.finished = new Date();
      self.emitter.emit('job.done', jobdata);
      if (!self.callbackMap[id]) {
        debug('Job cancelled, but no callback found. The queue is probably broken.');
        return self.queue.process();
      }
      self.callbackMap[id]();
      delete self.callbackMap[id];
    });
    // proxy up plugin events
    this.io.on('plugin.**', function () {
      self.emitter.emit.apply(self.emitter, [this.event].concat([].slice.call(arguments)));
    });
  },

  queueJob: function (job, config) {
    if (config.runner.id !== this.id) return;
    var now = new Date();
    this.jobdata.add(job);
    this.queue.push(job, config);
    this.emitter.emit('browser.update', job.project.name, 'job.status.queued', [job._id, now]);
    debug(`[runner:${this.id}] Queued new job. Project: ${job.project.name} Job ID: ${job._id}`);
  },

  cancelJob: function (id) {
    var jobdata;
    for (var i = 0; i < this.queue.tasks.length; i++) {
      if (this.queue.tasks[i].job._id.toString() === id.toString()) {
        this.queue.tasks.splice(i, 1);
        debug(`[runner:${this.id}] Cancelled job. Job ID: ${id}`);
        jobdata = this.jobdata.pop(id);
        jobdata.errored = true;
        jobdata.error = {
          message: 'Cancelled by the user'
        };
        // self.emitter.emit('browser.update', job.project.name, 'job.status.errored', [job._id, jobdata.error])
        delete jobdata.data;
        jobdata.started = new Date();
        jobdata.finished = new Date();
        this.emitter.emit('job.done', jobdata);
        return;
      }
    }
    // if it wasn't found in the queue, fire to the worker in case it is in process
    this.io.emit('job.cancel', id);
  },

  // initialize the provider and job plugins for a job
  // dirs = {base:, data:, cache:}
  plugins: function (user, config, job, dirs, done) {
    var self = this;
    var tasks = [function (next) {
      var plugin = self.extensions.provider[job.project.provider.id];
      if (!plugin) {
        var msg = `Provider plugin '${job.project.provider.id}' not found in this environment!`;
        return next(new Error(msg));
      }
      var finished = t(function (err, provider) {
        if (provider) provider.id = job.project.provider.id;
        next(err, provider);
      });
      if (!plugin.hosted) {
        return plugin.init(dirs, job.providerConfig, job, finished);
      }
      plugin.init(dirs, user.account(job.project.provider).config, job.providerConfig, job, finished);
    }];
    // XXX: do we want/need more things in the context? See
    // extension-loader readme for what gets passed in to the
    // individual phase functions as "Phase context"
    var context = {
      baseDir: dirs.base,
      dataDir: dirs.data,
      cacheDir: dirs.cache
    };
    var anyPluginFailed = config.plugins.some(function (plugin) {
      if (false === plugin.enabled) {
        debug(`[runner:${self.id}] Found a disabled plugin: ${plugin.id} Project: ${job.project.name} Job ID: ${job._id}`);
        return;
      }
      if (!self.extensions.job[plugin.id]) {
        debug(`[runner:${self.id}] Error: Plugin not found ${plugin.id} Project: ${job.project.name} Job ID: ${job._id}`);
        debug('Plugin not found', plugin.id);
        done(new Error(`Plugin required but not found: ${plugin.id}`));
        return true;
      }
      debug(`Initializing plugin '${plugin.id}'...`);
      tasks.push(function (next) {
        var fn = self.extensions.job[plugin.id].init;
        var cb = t(function (err, obj) {
          if (obj) obj.id = plugin.id;
          next(err, obj);
        });
        switch (fn.length) {
        case 1:
          return fn(cb);
        case 2:
          return fn(plugin.config, cb);
        case 3:
          return fn(plugin.config, context, cb);
        case 4:
          return fn(plugin.config, job, context, cb);
        default:
          return fn(user.jobplugins && user.jobplugins[plugin.id], plugin.config, job, context, cb);
        }
      });
    });
    if (anyPluginFailed) return;
    async.parallel(tasks, function (err, results) {
      if (err) return done(err);
      done(null, {
        provider: results.shift(),
        jobplugins: results
      });
    });
  },

  cacheDir: function (project) {
    return path.join(this.config.dataDir, 'cache', project.name);
  },

  getCache: function (project) {
    return cachier(this.cacheDir(project));
  },

  clearCache: function (project, done) {
    fs.remove(this.cacheDir(project), function (err) {
      done(err && new Error(`Failed to clear the cache. Error code: ${err}`));
    });
  },

  processJob: function (job, config, next) {
    var cache = this.getCache(job.project);
    var now = new Date();
    var self = this;
    var oldnext = next;
    next = function () {
      delete self.callbackMap[job._id];
      oldnext();
    };
    this.callbackMap[job._id] = next;

    var projectName = job.project.name.replace('/', '-');
    var branchName = branchFromJob(job).replace('/', '-');
    var branchBase = path.join(self.config.dataDir, 'data', `${projectName}-${branchName}`);
    var recentBuilds = _.get(config, 'runner.config.recentBuilds');

    if (typeof recentBuilds === 'undefined') {
      recentBuilds = self.config.defaultRecentBuilds;
    }

    recentBuilds = Math.max(recentBuilds, 1);

    if (recentBuilds > 1) {
      debug(`Preserving the most recent ${recentBuilds} builds within ${branchBase}.`);
    }

    // Keep around N most recent build directories for this branch.
    // The default is 0, ie wipe at start of each run.
    // Later, this can be configurable in the UI.
    keeper({baseDir: branchBase, count: recentBuilds - 1}, function (err) {
      if (err) return next(err);

      initJobDirs(branchBase, job, cache.base, jobDirsReady);
    });

    function jobDirsReady(err, dirs) {
      if (err) {
        var jobdata = self.jobdata.pop(job._id);
        if (!jobdata) return next();
        jobdata.errored = true;
        jobdata.error = {
          message: err.message,
          stack: err.stack
        };
        // self.emitter.emit('browser.update', job.project.name, 'job.status.errored', [job._id, jobdata.error])
        delete jobdata.data;
        jobdata.finished = new Date();
        self.emitter.emit('job.done', jobdata);

        return next();
      }

      self.jobdata.get(job._id).started = now;
      self.emitter.emit('browser.update', job.project.name, 'job.status.started', [job._id, now]);
      debug(`[runner:${self.id}] Job started. Project: ${job.project.name} Job ID: ${job._id}`);
      debug('Initializing plugins...');
      self.plugins(job.project.creator, config, job, dirs, function (err, workers) {
        if (err) {
          let jobdata = self.jobdata.pop(job._id);
          if (!jobdata) return next(err);
          jobdata.errored = true;
          jobdata.error = {
            message: err.message,
            stack: err.stack
          };
          // self.emitter.emit('browser.update', job.project.name, 'job.status.errored', [job._id, jobdata.error])
          delete jobdata.data;
          jobdata.finished = new Date();
          self.emitter.emit('job.done', jobdata);

          debug(`[runner:${self.id}] Job done with error. Project: ${job.project.name} Job ID: ${job._id}`);
          return next(err);
        }

        var env = {};

        if (config.envKeys) {
          env.STRIDER_SSH_PUB = config.pubkey;
          env.STRIDER_SSH_PRIV = config.privkey;
        }

        self.config.processJob(job, workers.provider, workers.jobplugins, {
          cachier: cache,
          baseDir: dirs.base,
          dataDir: dirs.data,
          cacheDir: dirs.cache,
          io: self.config.io,
          branchConfig: config,
          env: env
        }, function (err) {
          var jobdata = self.jobdata.pop(job._id);
          if (!jobdata) return next(err);

          if (err) {
            jobdata.errored = true;
            jobdata.error = {
              message: err.message,
              stack: err.stack
            };
            self.emitter.emit('browser.update', job.project.name, 'job.status.errored', [job._id, jobdata.error]);

            delete jobdata.data;
            jobdata.finished = new Date();
            debug(`[runner:${self.id}] Job done with error. Project: ${job.project.name} Job ID: ${job._id}`);
            return next(err);
          }

          delete jobdata.data;
          jobdata.finished = new Date();
          self.emitter.emit('job.done', jobdata);
          debug(`[runner:${self.id}] Job done without error. Project: ${job.project.name} Job ID: ${job._id}`);
          next();
        });
      });
    }
  }
};
