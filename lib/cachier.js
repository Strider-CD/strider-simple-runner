
var spawn = require('child_process').spawn
  , path = require('path')
  , fs = require('fs')

  , mkdirp = require('mkdirp')

module.exports = cachier

function safespawn() {
  var c = spawn.apply(null, arguments)
  c.on('error', function (err) {
    // suppress node errors
  })
  return c
}

function cachier(base) {
  function child(sub) {
    return cachier(path.join(base, sub))
  }
  child.get = function (key, dest, done) {
    if (arguments.length === 2) {
      done = dest
      dest = key
      key = ''
    }
    copy(path.join(base, key), dest, done)
  }
  child.update = function (key, dest, done) {
    if (arguments.length === 2) {
      done = dest
      dest = key
      key = ''
    }
    copy(dest, path.join(base, key), done)
  }
  child.base = base
  return child
}

function copy(from, to, done) {
  fs.exists(from, function (exists) {
    if (!exists) return done(new Error('Source does not exist: ' + from))
    safespawn('rm', ['-rf', to]).on('close', function () {
      mkdirp(path.dirname(to), function () {
        var out = ''
          , child = safespawn('cp', ['-R', from, to])
        child.stdout.on('data', function (data) {
          out += data.toString()
        })
        child.stderr.on('data', function (data) {
          out += data.toString()
        })
        child.on('close', function (exitCode) {
          return done(exitCode && new Error('Failed to retrieve cached code:' + out + ' ' + exitCode))
        })
      })
    })
  })
}

