
// A class for collecting and managing job data

var _ = require('lodash')

  , utils = require('./utils')
  , consts = require('./consts')

module.exports = JobData

function JobData(io) {
  this.jobs = {}
  this.io = io
  this.attach()
}

JobData.prototype = {
  // public api
  add: function (data) {
    var job = this.jobs[data.id] = _.cloneDeep(consts.skels.job)
    job.id = data.id
    job.data = data
    job.queued = new Date()
    for (var i=0; i<consts.phases.length; i++) {
      job.phases[consts.phases[i]] = _.cloneDeep(consts.skels.phase)
    }
    return job
  },
  get: function (id) {
    return this.jobs[id]
  },
  pop: function (id) {
    var job = this.jobs[id]
    if (!job) {
      throw new Error('Tried to pop a nonexistent job ' + id)
    }
    delete this.jobs[id]
    return job
  },

  // private api
  attach: function () {
    var self = this
    Object.keys(this.listeners).forEach(function (name) {
      self.io.on('job.status.' + name, function (id) {
        return self.listeners[name].apply(self.jobs[id], [].slice.call(arguments, 1))
      })
    })
  },
  // all listeners are called on the *job object* referred to by the
  // first id of the event
  listeners: {
    'phase.done': function (phase, time, code) {
      var next = consts.phases[consts.phases.indexOf(phase) + 1]
      this.phases[phase].finished = time
      this.phases[phase].exitCode = code
      if (phase === 'test') this.test_status = code
      if (phase === 'deploy') this.deploy_status = code
      if (!next) return
      this.phase = next
    },
    'command.start': function (text, time, plugin) {
      var phase = this.phases[this.phase]
        , command = _.extend({
            started: time,
            cmd: text,
            plugin: plugin
          }, consts.skels.command)
      phase.commands.push(command)
    },
    'command.done': function (exitCode, time, elapsed) {
      var phase = this.phases[this.phase]
        , command = phase.commands[phase.commands.length - 1]
      command.finished = time
      command.exitCode = exitCode
    },
    'stdout': function (text) {
      var command = utils.ensureCommand(this.phases[this.phase])
      command.out += text
      command.merged += text
      this.std.out += text
      this.std.merged += text
    },
    'stderr': function (text) {
      var command = utils.ensureCommand(this.phases[this.phase])
      command.err += text
      command.merged += text
      this.std.err += text
      this.std.merged += text
    },
  }
}
