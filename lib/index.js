
var _ = require('lodash')
  , path = require('path')
  , async = require('async')
  , EventEmitter2 = require('eventemitter2').EventEmitter2

  , core = require('strider-runner-core')

  , PHASES = ['env', 'prepare', 'test', 'deploy', 'cleanup']

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
    pluginDir: path.join(__dirname, '../node_modules'),
    dataDir: process.env.STRIDER_CLONE_DEST || dotStrider
  }, config)
  this.emitter = emitter
  this.log = this.config.logger.log
  this.queue = async.queue(this.processJob.bind(this), 1)
  this.io = new EventEmitter2()
  this.hooks = []
  this.jobdata = {}
  this.attach()
}

var skels = {
  command: {
    out: '',
    err: '',
    merged: ''
  }
}

Runner.prototype = {
  // public API

  // private API
  attach: function () {
    var self = this
    this.emitter.on('job.new', this.queueJob)
    this.emitter.on('job.cancel', this.cancelJob)
    this.io.on('job.status.*', function () {
      // proxy up job.status.* updates as browser events
      self.emitter.emit('browser.update', this.event, [].slice.call(arguments))
    })
    this.io.on('job.cancelled', function (id) {
      self.emitter.emit('job.cancelled', id, self.jobdata[id])
      delete self.jobdata[id]
      // our running job was cancelled, so we need to start the next one
      async.setImmediate(self.queue.process)
    })
    // catch and cache job output
    this.io.on('job.status.phase.done', function (id, phase, time, code) {
      var job = self.jobdata[id]
        , next = PHASES[PHASES.indexOf(phase) + 1]
      job.phases[phase].finished = time
      job.phases[phase].exitCode = code
      if (phase === 'test') job.test_status = code
      if (phase === 'deploy') job.deploy_status = code
      if (!next) return
      job.phase = next
    })
    // running commands
    this.io.on('job.status.command.start', function (id, text, time, plugin) {
      var job = self.jobdata[id]
        , phase = job.phases[job.phase]
        , command = _.extend({
            started: time,
            cmd: text,
            plugin: plugin
          }, skels.command)
      phase.commands.push(command)
    })
    this.io.on('job.status.command.done', function (id, exitCode, time, elapsed) {
      var job = self.jobdata[id]
        , phase = job.phases[job.phase]
        , command = phase.commands[phase.commands.length - 1]
      command.finished = time
      command.exitCode = exitCode
    })
    this.io.on('job.status.stdout', function (id, text) {
      var job = self.jobdata[id]
        , phase = job.phases[job.phase]
        , command = phase.commands[phase.commands.length - 1]
      if (!command || typeof(command.finished) !== 'undefined') {
        command = _.extend({}, skels.command)
        phase.commands.push(command)
      }
      command.out += text
      command.merged += text
    })
    this.io.on('job.status.stderr', function (id, text) {
      var job = self.jobdata[id]
        , phase = job.phases[job.phase]
        , command = phase.commands[phase.commands.length - 1]
      if (!command || typeof(command.finished) !== 'undefined') {
        command = _.extend({}, skels.command)
        phase.commands.push(command)
      }
      command.err += text
      command.merged += text
    })
  },
  queueJob: function (task) {
    var now = new Date()
    this.jobdata[task.job.id] = {
      id: task.job.id,
      phases: {
        env: {
          finished: null,
          exitCode: -1,
          commands: []
        },
        prepare: {
          finished: null,
          exitCode: -1,
          commands: []
        },
        text: {
          finished: null,
          exitCode: -1,
          commands: []
        },
        deploy: {
          finished: null,
          exitCode: -1,
          commands: []
        },
        cleanup: {
          finished: null,
          exitCode: -1,
          commands: []
        }
      },
      phase: 'prepare',
      queued: now,
      started: null,
      finished: null,
      test_status: -1,
      deploy_status: -1
    }
    this.log('Got new job')
    this.queue.push(task)
    this.emitter.emit('browser.update', 'job.status.queued', {id: task.job.id, time: now})
  },
  cancelJob: function (id) {
    for (var i=0; i<this.queue.tasks.length; i++) {
      if (this.queue.tasks[i].job.id === id) {
        this.queue.tasks.splice(i, 1)
        this.emitter.emit('job.cancelled', id, this.jobdata[id])
        delete this.jobdata[id]
        return
      }
    }
    // if it wasn't found in the queue, fire to the worker in case it is in process
    this.io.emit('job.cancel', id)
  },
  processJob: function (task, next) {
    var self = this
      , now = new Date()
    this.jobdata[task.job.id].started = now
    core.process(task, this.config, function (err) {
      if (err) {
        self.jobdata[task.job.id].errored = true
        self.jobdata[task.job.id].error = {
          message: err.message,
          stack: err.stack
        }
        self.emitter.emit('browser.update', 'job.status.errored', [task.job.id])
      }
      self.emitter.emit('job.done', self.jobdata[task.job.id])
      delete self.jobdata[task.job.id]
      next(null)
    });
  }
};

