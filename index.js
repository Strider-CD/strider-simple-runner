var Runner = require('./lib/worker')

var create = function(emitter, opts, cb){
  var runner = new Runner(emitter, opts)
  runner.attach()
  cb(null)
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
