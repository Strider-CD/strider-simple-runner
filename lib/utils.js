
var async = require('async')

module.export = {
  getUrls: function (url, ssh_key, api_key) {
    if (ssh_key) {
      return [url, url]
    }
    url = url.slice('git@'.length)
    screen = url
    if (api_key) {
      url = api_key + '@' + url
      screen = '[github oauth key]@' + screen
    }
    return ['https://' + url, 'https://' + screen]
  },

  // Pre-process detection rules - some can have properties which are async functions
  processDetectionRules: function (rules, ctx, cb) {
    // filename property of detection rules can be a function
    var processedRules = []
    var f = []
    rules.forEach(function(rule) {
      if (rule.filename && typeof(rule.filename) == 'function') {
        f.push(function(cb) {
          rule.filename(ctx, function(err, result) {
            if (err) return cb(err, {rule: rule, filename: null})
            return cb(null, {rule: rule, filename: result})
          })
        })
        return
      } 
      processedRules.push(rule)
    })

    async.parallel(f, function(err, results) {
      if (err) return cb(err, null)

      results.forEach(function(res) {
        res.rule.filename = res.filename
        processedRules.push(res.rule)
      })
      cb(null, processedRules)
    })
  }
}

function getHook(context, result, phase) {
  var hook = function(context, cb) {
    // logger.debug("running NO-OP hook for phase: %s", phase)
    cb(0)
  }

  // If actions are strings, we assume they are shell commands and try to execute them
  // directly ourselves.
  if (typeof(result[phase]) === 'string') {
    var psh = context.shellWrap(result[phase])
    hook = function(context, next) {
      // logger.debug("running shell command hook for phase %s: %s", phase, result[phase])
      context.forkProc(context.workingDir, psh.cmd, psh.args, next)
    }
  }

  // Execution actions may be delegated to functions.
  // This is useful for example for multi-step things like in Python where a virtual env must be set up.
  // Functions are of signature function(context, cb)
  // We assume the function handles any necessary shell interaction and sending of update messages.
  if (typeof(result[phase]) === 'function') {
    hook = function(ctx, cb) {
      // logger.debug("running function hook for phase %s", phase)
      result[phase](ctx, cb)
    }
  }

  return function(cb) {
    hook(context, function(hookExitCode, tasks) {
      // logger.debug("hook for phase %s complete with code %s", phase, hookExitCode)
      // Cleanup hooks can't fail
      if (phase !== 'cleanup' && hookExitCode !== 0 && hookExitCode !== undefined &&
          hookExitCode !== null && hookExitCode !== false) {
        return cb({phase: phase, code: hookExitCode, tasks: tasks}, false)
      }
      cb(null, {phase: phase, code: hookExitCode, tasks: tasks})
    })
  }
}

function collectPhases(done, rules) {
  return function (err, context) {
    var next = this
    this.context = context
    if (err) return next(err)
    utils.processDetectionRules(rules, context, function (err, rules) {
      if (err) {
        context.io.emit('error', err, 'Failed to processs detection rules')
        return done(500)
      }
      gumshoe.run(context.workingDir, rules, next)
    })
  }
}

function processPhases(done, buildHooks) {
  return function (err, result, results) {
    var next = this
      , context = this.context
      , phases = ['prepare', 'test', 'deploy', 'cleanup']
      , runPhase = {}
      , runList = []
    if (err) return next(err)

    phases.forEach(function (phase) {
      if (context.jobData.job_type === TEST_ONLY && phase === 'deploy') {
        return;
      }
      runPhase[phase] = function (next) {
        var tasks = []
        results.concat(buildHooks).forEach(function (result) {
          tasks.push(getHook(context, result, phase))
        })

        // If this job has a Heroku deploy config attached, add a single Heroku deploy function
        if (phase === 'deploy' && context.jobData.deploy_config) {
          // logger.log("have heroku config - adding heroku deploy build hook")
          tasks.push(function(cb) {
            context.striderMessage("Deploying to Heroku ...")
            // logger.debug("running Heroku deploy hook")
            // XXX will fail
            heroku.deploy(context.io,
              context.workingDir, context.jobData.deploy_config.app,
              context.jobData.deploy_config.privkey, function(herokuDeployExitCode) { 
                if (herokuDeployExitCode !== 0) {
                  return cb({phase: phase, code: herokuDeployExitCode}, false)
                }
                cb(null, {phase: phase, code: herokuDeployExitCode})
              }
            )
          })
        }

        async.series(tasks, function(err, results) {
          next(err, results)
        })
      }
      runList.push(runPhase[phase])
    })
    async.series(runList, function(err, results) {
      // logger.log("results: %j", results)
      var tasks = []
      // make sure we run cleanup phase
      if (err && err.phase !== 'cleanup') {
        // logger.debug("Failure in phase %s, running cleanup and failing build", err.phase)
        return runPhase['cleanup'](function(e) {
          done(err.code, err.tasks)
        })
      }
      results.forEach(function(r) {
        r.forEach(function(tr) {
          if (tr.tasks && Array.isArray(tr.tasks)) {
            tasks = tr.tasks.concat(tasks)
          } else if (tr.tasks && typeof(tr.tasks) === 'object') {
            tasks.push(tr.tasks)
          }
        })
      })
      return done(0, tasks)
    })
  }
}
