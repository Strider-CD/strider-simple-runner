
var Runner = require('./lib')

var create = function(emitter, opts, cb){
  console.log(">>>>> RUNNER:: CREATE", arguments)
  var runner = new Runner(emitter, opts)

  // TEMP - assume all the extensions are loaded. This
  // will be replaced when we pass the extension config
  // through in the run events.
 
  var pth = require.main.paths
  loader.initWorkerExtensions(pth, runner.buildContext({}, pth), function(){
    console.log("!!!!! RUNNER CREATE>", arguments)
    cb(null)
  })
}

module.exports = {
  // Strider runner requires:

  // function(emitter, opts, cb) -> creates a 'runner' bound to the emitter
  create: create,
    // Must handle events:
    // --> 'job.new' { repo: {...}, job: {...} }
    // --> 'job.cancel' jobid
    // Events it is expected to emit
    // --> 'browser.update' eventname, data
    // --> 'job.queued' jobid, time
    // --> 'job.done' { id: jobid, commands: [...], times: {...}, test_status: int, deploy_status: int }

  // We expose these for other modules / unit testing
  Runner : Runner
}
