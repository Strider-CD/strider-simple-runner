
var _ = require('lodash')
  , path = require('path')
  , async = require('async')
  , Step = require('step')
  , utils = require('./utils')
  , Job = require('./job')

module.exports = Runner

function Runner(emitter, config) {
  var dotStrider = path.join(process.env.HOME || '/', '.strider')
  this.config = _.extend({
    pty: false,
    logger: console,
    emitter: emitter,
    dataDir: process.env.STRIDER_CLONE_DEST || dotStrider
  }, config)
  this.log = this.config.logger.log
  this.queue = async.queue(this.processJob.bind(this), 1)
  this.hooks = []
}

Runner.prototype = {
  attach: function (emitter) {
    var self = this
    this.config.emitter.on('queue.new_job', function (task) {
      self.log('Got new job')
      self.queue.push(task)
    })
  },
  buildContext: function (config, extdir) {
    var self = this
    return {
      addDetectionRules: function (rules) {
        throw "No longer supported"
      },
      addDetectionRule: function (rule) {
        throw "No Longer supported"
      },
      addBuildHooks: function (hooks) {
        self.hooks = self.hooks.concat(hooks)
      },
      addBuildHook: function (hook) {
        self.hooks.push(hook)
      },
      config: config,
      extdir: extdir,
      npmCmd: 'npm'
    }
  },
  processJob: function (data, next) {
    var d = require('domain').create()
    var self = this
    var done, io
    d.on('error', function (err) {
      self.log('Domain caught error while processing', err.message, err.stack)
      io.emit('error', err)
      done(500)
    })
    self.log('Processing job', data.job_id)
    d.run(function () {
      var shortname = data.repo_config.url.split('/').slice(-2).join('/')
        , dirname = data.user_id + '.' + shortname.replace('/', '.')
        , dir = path.join(self.config.dataDir, dirname)
        , job = new Job(data, dir, self.config.emitter, {
            logger: self.config.logger,
            pty: self.config.pty
          })
      done = function (code, tasks) {
        self.log('done', code)
        job.complete(code, null, tasks, next)
      }
      io = job.io
      job.start()
      Step(
        function() {
          job.gitStep(done, this)
        },
        function(err, context) {
          utils.processPhases(this, self.hooks, context)
        },
        function (err, tasks) {
          if (err) {
            return done(err, tasks)
          }
          done(0, tasks)
        }
      )
    })
  }
}
