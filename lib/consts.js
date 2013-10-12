
// constants and things

var phases = ['environment', 'prepare', 'test', 'deploy', 'cleanup']

var skels = {
  job: {
    id: null,
    data: null,
    phases: {},
    phase: phases[0],
    queued: null,
    started: null,
    finished: null,
    test_status: -1,
    warnings: [],
    deploy_status: -1,
    plugin_data: {},
    std: {
      out: '',
      err: '',
      merged: ''
    }
  },
  command: {
    out: '',
    err: '',
    merged: '',
    started: null,
    command: '',
    plugin: ''
  },
  phase: {
    finished: null,
    exitCode: -1,
    commands: []
  }
}

module.exports = {
  skels: skels,
  phases: phases
}
