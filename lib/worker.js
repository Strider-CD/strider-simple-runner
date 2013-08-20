
var _ = require('lodash')
  , path = require('path')
  , async = require('async')
  , Step = require('step')
  , utils = require('./utils')
  , Job = require('./job')

module.exports = Worker

var NODE_RULE = {
  filename: 'package.json',
  exists: true,
  language: 'node.js',
  framework: null,
  prepare: 'npm install',
  test: 'npm test',
  start: 'npm start',
  path: path.join(__dirname, '../node_modules/npm/bin')
}

function Worker(config) {
  var dotStrider = path.join(process.env.HOME || '/', '.strider')
  this.config = _.extend({
    pty: true,
    logger: console,
    emitter: null,
    dataDir: process.env.STRIDER_CLONE_DEST || dotStrider
  }, config)
  this.log = this.config.logger.log
  this.queue = async.queue(this.processJob.bind(this), 1)
  this.rules = [NODE_RULE]
  this.hooks = []
}

Worker.prototype = {
  attach: function (emitter) {
    var self = this
    emitter.on('queue.new_job', function (task) {
      self.log('Got new job')
      self.queue.push(task)
    })
  },
  buildContext: function (config, extdir) {
    var self = this
    return {
      addDetectionRules: function (rules) {
        self.rules = self.rules.concat(rules)
      },
      addDetectionRule: function (rule) {
        self.rules.push(rule)
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
          this.context = context
          utils.collectPhases(done, context, self.rules, this)
        },
        function(err, result, results) {
          utils.processPhases(this, self.hooks, this.context, results)
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
