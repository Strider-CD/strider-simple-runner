var Runner = require('./lib/worker')
  , loader = require('strider-extension-loader')

var create = function(emitter, opts, cb){
  console.log(">>>>> RUNNER:: CREATE", arguments)
  var runner = new Runner(emitter, opts)
  runner.attach()

  // TEMP - assume all the extensions are loaded. This
  // will be replaced when we pass the extension config
  // through in the run events.
 
  var pth = require('path').resolve(__dirname, '..')
  loader.initWorkerExtensions(pth, runner.buildContext({}, pth), function(){
    console.log("!!!!! RUNNER CREATE>", arguments)
    cb(null)
  })
}


module.exports = {
  // Strider worker requires:

  // function(emitter, opts, cb) -> creates a 'runner' bound to the emitter
  create: create,
    // Must handle events:
    // --> 'job.create' {enablePty : Boolean, repoConfig: {...}, extensionConfig: [...] }
    // --> 'job.cancel' ?

  // We expose these for other modules / unit testing
  Runner : Runner
}
