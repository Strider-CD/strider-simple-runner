
var _ = require('lodash')
  , job = require('job')

var Worker = function (config) {
  this.config = _.extend({
    pty: true,
    logger: console,
    dataDir: path.join(__dirname, '_work')
  }, config)
  this.queue = async.queue(this.processJob.bind(this))
  this.rules = []
  this.hooks = []
}

Worker.prototype = {
  attach: function (emitter) {
    var self = this
    emitter.on('queue.new_job', function (task) {
      self.queue.push(task)
    })
  },
  buildContext: function (config, extdir) {
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
        self.hook.push(hook)
      },
      config: config,
      extdir: extdir,
      npmCmd: 'npm'
    }
  },
  processJob: function (data, next) {
    var shortname = data.repo_url.split('/').slice(-2).join('/')
      , dirname = data.user_id + '.' + shortname.replace('/', '.')
      , dir = path.join(this.config.dataDir, dirname)
      , job = new Job(data, dir, {
          logger: this.config.logger
        })
      , done = function (code, tasks) {
          job.complete(code, null, tasks, next)
        }
    job.start()
    Step(
      job.gitStep(next),
      utils.collectPhases(done, this.rules),
      utils.processPhases(done, this.hooks)
    )
  }
}

// XXX should we switch to a different way of things?
module.exports = function (context, next, isText) {
  var worker = new Worker({
    pty: !context.config.disablePty
  })
  context.loader.initExtensions(
    context.extdir, 'worker',
    worker.buildContext(context.config, context.extdir),
    null, function (err, initialized) {
      if (err) {
        console.log('failing. right?', err)
        return cb(err)
      }
      worker.attach(context.emitter)
      cb()
    })
}
module.exports.Worker = Worker
