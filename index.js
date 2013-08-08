var Runner = require('./lib/worker')

var listen = function(emitter, extensions, opts, cb){
  var worker = new Worker({
    pty: opts.enablePty,
    emitter: emitter,
    logger: opts.logger
  })

  worker.attach(emitter)
  opts.logger.log('Simple Worker ready')

  cb(null)


}


module.exports = {
  // Strider worker requires:
  listen: listen,

  // We expose these for other modules / unit testing
  Runner : Runner
}
