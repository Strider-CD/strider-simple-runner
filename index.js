
var Runner = require('./lib')
  , Loader = require('strider-extension-loader')

var create = function(emitter, opts, cb){
  console.log(">>>>> RUNNER:: CREATED")
  var loader = new Loader()
  var runner = new Runner(emitter, opts)
  runner.loadExtensions(require.main.paths, cb)
}

module.exports = {
  // Strider runner requires:

  // function(emitter, opts, cb) -> creates a 'runner' bound to the emitter
  create: create,
    // Must handle events:
    // --> 'job.new' { repo: {...}, job: {...} }
    // --> 'job.cancel' jobid
    // Events it is expected to emit
    // <-- 'browser.update' eventname, data
    // <-- 'job.queued' jobid, time
    // <-- 'job.done' { id: jobid, commands: [...], times: {...}, test_status: int, deploy_status: int }

    // Backwards compat: TODO remove
    // --> queue.new_job
    // <-- queue.job_update
    // <-- queue.job_complete

  // We expose these for other modules / unit testing
  Runner : Runner
}
