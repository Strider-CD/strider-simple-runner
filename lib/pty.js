
var pty = require('pty.js')
  , ansiclean = require('./ansiclean')

// pty.spawn(cmd, [options], next)
// this is a wrapper around pty.js's spawn, which makes it act a little bit
// more like the normal spawn, in that it gives you an exit code.
//
// Arguments:
//   cmd: string. Will be executed by bash
//   options = the options you'd pass to pty.js
//   next(exitCode)
module.exports = {
  spawn: function (cmd, options, next) {
    if (arguments.length === 2) {
      next = options
      options = {}
    }
    var term = pty.spawn('bash', ['-c', cmd + ' && echo $? || echo $?'], options)
      , out = ''
      , first = true
    term.on('data', function (data) {
      if (first) {
        first = false
        return
      }
      out += data;
    });
    term.on('close', function () {
      var lastLine = ansiclean(out.trim().split('\n').pop().trim())
        , exitCode = parseInt(lastLine, 10)
      if (isNaN(exitCode)) {
        exitCode = 500;
      }
      term.destroy()
      return next(exitCode, out)
    });
    term.write(cmd)
    return term
  }
}
