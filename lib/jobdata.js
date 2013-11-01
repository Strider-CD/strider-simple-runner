
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
    var job = this.jobs[data._id] = _.cloneDeep(consts.skels.job)
    job.id = data._id
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
      console.warn('tried to pop a nonexistant job', id)
      return
    }
    delete this.jobs[id]
    return job
  },

  // private api
  attach: function () {
    var self = this
    Object.keys(this.listeners).forEach(function (name) {
      self.io.on('job.status.' + name, function (id) {
        if (!self.jobs[id]) {
          console.warn('[simple-runner][jobdata] got a status update, but the job was never added', id, Object.keys(self.jobs))
          return
        }
        return self.listeners[name].apply(self.jobs[id], [].slice.call(arguments, 1))
      })
    })
  },
  // all listeners are called on the *job object* referred to by the
  // first id of the event
  listeners: {
    'phase.done': function (data) {
      this.phases[data.phase].finished = data.time
      this.phases[data.phase].duration = data.elapsed
      this.phases[data.phase].exitCode = data.exitCode
      if (data.phase === 'test') this.test_status = data.code
      if (data.phase === 'deploy') this.deploy_status = data.code
      if (!data.next) return
      this.phase = data.next
    },
    'command.comment': function (data) {
      var phase = this.phases[this.phase]
        , command = _.extend({}, consts.skels.command)
      command.command = data.comment
      command.comment = true
      command.plugin = data.plugin
      command.finished = data.time
      phase.commands.push(command)
    },
    'command.start': function (data) {
      var phase = this.phases[this.phase]
        , command = _.extend({}, consts.skels.command, data)
      phase.commands.push(command)
    },
    'command.done': function (data) {
      var phase = this.phases[this.phase]
        , command = phase.commands[phase.commands.length - 1]
      command.finished = data.time
      command.duration = data.elapsed
      command.exitCode = data.exitCode
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
    'warning': function (warning) {
      this.warnings.push(warning);
    },
    'plugin-data': function (data) {
      var path = data.path ? [data.plugin].concat(data.path.split('.')) : [data.plugin]
        , last = path.pop()
        , method = data.method || 'replace'
        , parent
      parent = path.reduce(function (obj, attr) {
        return obj[attr] || (obj[attr] = {})
      }, this.plugin_data || (this.plugin_data = {}))
      if (method === 'replace') {
        parent[last] = data.data
      } else if (method === 'push') {
        if (!parent[last]) {
          parent[last] = []
        }
        parent[last].push(data.data)
      } else if (method === 'extend') {
        if (!parent[last]) {
          parent[last] = {}
        }
        _.extend(parent[last], data.data)
      } else {
        console.error('Invalid "plugin data" method received from plugin', data.plugin, data.method, data)
      }
    }
  }
}
