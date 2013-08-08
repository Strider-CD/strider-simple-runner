var Runner = require('./lib/worker')

var create = function(emitter, opts, cb){
  var runner = new Runner(emitter, opts)
  worker.attach()
  cb(null)
}


module.exports = {
  // Strider worker requires:

  // function(emitter, opts, cb) -> creates a 'runner' bound to the emitter
  create: create,

  // We expose these for other modules / unit testing
  Runner : Runner
}
