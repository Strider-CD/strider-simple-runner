
// constants and things

var phases = ['env', 'prepare', 'test', 'deploy', 'cleanup']

var skels = {
  job: {
    id: null,
    phases: {},
    phase: phases[0],
    queued: null,
    started: null,
    finished: null,
    test_status: -1,
    deploy_status: -1
  },
  command: {
    out: '',
    err: '',
    merged: ''
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
