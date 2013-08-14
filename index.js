
var Runner = require('./lib')

var create = function(emitter, opts, cb){
  var runner = new Runner(emitter, opts)
  cb(null)
}

module.exports = {
  // Strider worker requires:

  // function(emitter, opts, cb) -> creates a 'runner' bound to the emitter
  create: create,
    // Must handle events:
    // --> 'job.new' { repo: {...}, job: {...} }
    // --> 'job.cancel' jobid
    // Events it may emit
    // --> 'browser.update' (eventname, data)
    // --> 'job.queued' jobid, time
    // --> 'job.done' { id: jobid, commands: [...], times: {...}, test_status: int, deploy_status: int }

  // We expose these for other modules / unit testing
  Runner : Runner
}
