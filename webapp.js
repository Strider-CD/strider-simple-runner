// Strider Simple Worker
// Niall O'Higgins 2012
//
// A simple, in-process worker implementation for Strider.
//

var async = require('async')
var exec = require('child_process').exec
var extend = require('lodash').extend
var EventEmitter = require('events').EventEmitter
var gitane = require('gitane')
var gumshoe = require('gumshoe')
var path = require('path')
var spawn = require('child_process').spawn
var Step = require('step')
var fs = require('fs')
var pty = require('pty.js');
var ansiclean = require('./lib/ansiclean');

var TEST_ONLY = "TEST_ONLY"
var TEST_AND_DEPLOY = "TEST_AND_DEPLOY"

var npmCmd = "npm"
var nodePrepare = npmCmd + " install"
var nodeTest = npmCmd + " test"
var nodeStart = npmCmd + " start"
// get npm for environment
process.env.PATH += ':' + path.join(__dirname, 'node_modules/.bin');

// Built-in rules for project-type detection
var DEFAULT_PROJECT_TYPE_RULES = [
  // Node
  {filename:"package.json", exists:true, language:"node.js", framework:null, prepare:nodePrepare, test:nodeTest, start:nodeStart},
]

// detection rules which may be added by worker plugins
// rules must contain a property *test* which can either be a string or a function taking a callback.
// if a string, this is a shell command to be executed to run project tests (e.g. "npm install")
// if a function, this accepts a callback argument of signature function(err) which must be called.
//
// rules may contain a property *prepare* which can be a string or a function like *test*. this is for pre-test
// preparations (e.g. "npm install")
//
var detectionRules = []

// build hooks which may be added by worker plugins.
// A build hook is the same as a detection rule, but there is no predicate and it is *always* run on each job.
// Build hooks consist of an object with optional properties "test", "prepare", "deploy" and "cleanup". 
// Build hooks are useful for plugins that implement explicit build phases e.g. setting up a BrowserStack tunnel.
// Plugins can no-op their build hook functions at runtime for repos that do not have them configured, or 
// don't need them for other reasons.
//
// This enables more customization logic to move to plugins.
//
var buildHooks = []

// Return path to writeable dir for test purposes
function getDataDir() {
  return path.join(__dirname, "_work")
}

// Wrap a shell command for execution by spawn()
function shellWrap(str) {
  return { cmd:"sh", args:["-c", str] }
}

// spawnPty(cmd, [options], next)
// Arguments:
//   options = the options you'd pass to pty.js
//   next(exitCode)
function spawnPty(cmd, options, next) {
  if (arguments.length === 2) {
    next = options;
    options = {};
  }
  var term = pty.spawn('bash', ['-c', cmd + ' && echo $? || echo $?'], options)
    , out = ''
    , first = true;
  term.on('data', function (data) {
    if (first) {
      first = false;
      return;
    }
    out += data;
  });
  term.on('close', function () {
    var lastLine = ansiclean(out.trim().split('\n').pop().trim());
    var exitCode = parseInt(lastLine);
    if (isNaN(exitCode)) {
      logger.log("Warning: [strider-simple-worker] the last line wasn't a number, so I don't know the exit code.", [lastLine]);
      exitCode = 1;
    }
    term.destroy();
    return next(exitCode);
  });
  term.write(cmd);
  return term;
}

// Pre-process detection rules - some can have properties which are async functions
function processDetectionRules(rules, ctx, cb) {
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

// Tasks are discrete properties which plugins may add to each job object.
// These will be persisted to the database along with the job document.
// They can be used for example to add machine-readable data to a job - e.g. number of qunit tests which passed/failed

// Default logger
logger = {log: console.log, debug: console.debug}

function registerEvents(emitter) {


  // Use an async.queue of concurrency 1 to ensure jobs are processed serially
  var q = async.queue(function(task, cb) {
    processJob(task, cb)
  }, 1)

  //
  // the queue.new_job event is primary way jobs are submitted
  //
  emitter.on('queue.new_job', function(data) {
    q.push(data)
  })

  function processJob(data, done) {
    // cross-process (per-job) output buffers
    var stderrBuffer = ""
    var stdoutBuffer = ""
    var stdmergedBuffer = ""
    // Put stuff under `_work`
    var dir = getDataDir()
    logger.log('new job')
    // Start the clock
    var t1 = new Date()

    // Emit a status update event. This can result in data being sent to the
    // user's browser in realtime via socket.io.
    function updateStatus(evType, opts) {
      var t2 = new Date()
      var elapsed = (t2.getTime() - t1.getTime()) / 1000
      var msg = {
        userId:data.user_id,
        jobId:data.job_id,
        timeElapsed:elapsed,
        repoUrl:data.repo_config.url,
        stdout: opts.stdout || "",
        stderr: opts.stderr || "",
        stdmerged: opts.stdmerged || "",
        autodetectResult:opts.autodetectResult || null,
        testExitCode: null,
        deployExitCode: null,
        tasks: null,
      }
      if (opts.testExitCode !== undefined) {
        msg.testExitCode = opts.testExitCode
      }
      if (opts.deployExitCode !== undefined) {
        msg.deployExitCode = opts.deployExitCode
      }
      if (opts.tasks !== undefined) {
        msg.tasks = opts.tasks
      }

      emitter.emit(evType, msg)
    }

    // Insert a synthetic (non job-generated) output message
    // This automatically prefixes with "[STRIDER]" to make the source
    // of the message clearer to the user.
    function striderMessage(message) {
      var msg = "\u001b[35m[STRIDER]\u001b[0m " + message + "\n"
      stdmergedBuffer += msg
      stdoutBuffer += msg
      updateStatus("queue.job_update", {stdout:msg, stdmerged:msg})
      logger.log("simpleworker >> ", msg)
    }


    // Deploy to Heroku
    function deployHeroku(cwd, app, key, cb) {
      var cmd = 'git remote add heroku git@heroku.com:' + app + '.git'
      gitane.run(cwd, key, cmd, function(err, stdout, stderr) {
        stdoutBuffer += stdout
        stderrBuffer += stderr
        stdmergedBuffer += stdout + stderr
        updateStatus("queue.job_update", {stdout:stdout, stderr:stderr, stdmerged:stdout+stderr})
        if (err) {
          striderMessage("Ignoring error adding git remote")
        }
        cmd = 'git push heroku --force master'
        gitane.run(cwd, key, cmd, function(err, stdout, stderr) {
          stdoutBuffer += stdout
          stderrBuffer += stderr
          stdmergedBuffer += stdout + stderr
          if (err) {
            striderMessage("Deployment to Heroku unsuccessful: %s", stdout+stderr)
            return cb(1, null)
          }
          updateStatus("queue.job_update", {stdout:stdout, stderr:stderr, stdmerged:stdout+stderr})
          striderMessage("Deployment to Heroku successful.")
          cb(0)
        })
      })
    }

    //
    // forkProc(cwd, shell, cb)
    // or
    // forkProc(cwd, cmd, args, cb)
    // or
    // forkProc({opts}, cb)
    //
    function forkProc(cwd, cmd, args, cb) {
      var extras = {}
      var env = extend(extras, process.env)
        , usePty = data.repo_config.pseudo_terminal
        , proc;

      if (data.repo_config.env !== undefined)
        env = extend(env, data.repo_config.env)
      if (typeof(cwd) === 'object') {
        cb = cmd
        var cmd = cwd.cmd
        var args = cwd.args
        env = extend(env, cwd.env)
        cwd = cwd.cwd
      }
      if (typeof(cmd) === 'string' && typeof(args) === 'function') {
        cb = args;
        args = [];
        if (!usePty) {
          args = cmd.split(/\s+/);
          cmd = args.shift();
        }
      }
      env.PAAS_NAME = 'strider';

      // colored awesome courtesy of pseudo terminal
      if (usePty) {
        if (cmd === 'sh' && args.length === 2 && args[0] === '-c') {
          cmd = args[1];
          args = [];
        } else {
          cmd += ' ' + args.join(' ');
        }
        proc = spawnPty(cmd, {
          name: 'xterm-color',
          cols: 1000,
          rows: 50,
          cwd: cwd,
          env: env
        }, function(exitCode) {
          logger.log("process exited with code: %d", exitCode);
          if (isNaN(exitCode)) {
            logger.log('Warning: NaN exitCode');
            exitCode = 1;
          }
          cb(exitCode);
        });
        var first = true;
        proc.on('data', function (buf) {
          // the first output is just a regurgitation of the input
          if (first) {
            first = false;
            buf = '\u001b[35mstrider $\u001b[0m \u001b[33m' + buf + '\u001b[0m\n';
            proc.stdoutBuffer += buf
            proc.stdmergedBuffer += buf
            stdoutBuffer += buf
            stdmergedBuffer += buf
            return;
          }
          proc.stdoutBuffer += buf
          proc.stdmergedBuffer += buf
          stdoutBuffer += buf
          stdmergedBuffer += buf
          updateStatus("queue.job_update", {stdout:buf})
        });
      } else {
        proc = spawn(cmd, args, {cwd: cwd, env: env})

        proc.stdout.setEncoding('utf8')
        proc.stderr.setEncoding('utf8')

        proc.stdout.on('data', function(buf) {
          proc.stdoutBuffer += buf
          proc.stdmergedBuffer += buf
          stdoutBuffer += buf
          stdmergedBuffer += buf
          updateStatus("queue.job_update" , {stdout:buf})
        })

        proc.stderr.on('data', function(buf) {
          proc.stderrBuffer += buf
          proc.stdmergedBuffer += buf
          stderrBuffer += buf
          stdmergedBuffer += buf
          updateStatus("queue.job_update", {stderr:buf})
        })

        proc.on('close', function(exitCode) {
          logger.log("process exited with code: %d", exitCode)
          cb(exitCode)
        });
      }

      // per-process output buffers
      proc.stderrBuffer = ""
      proc.stdoutBuffer = ""
      proc.stdmergedBuffer = ""

      return proc
    }
    function complete(testCode, deployCode, tasks, cb) {
      logger.log("complete() tasks: %j", tasks)
      updateStatus("queue.job_complete", {
        stderr:stderrBuffer,
        stdout:stdoutBuffer,
        stdmerged:stdmergedBuffer,
        testExitCode:testCode,
        deployExitCode:deployCode,
        tasks: tasks
      })
      if (typeof(cb) === 'function') cb(null)
    }

    var workingDir = path.join(dir, path.basename(data.repo_ssh_url.replace('.git', '')))
    // Context object for build hooks
    var context = {
      forkProc: forkProc,
      updateStatus: updateStatus,
      striderMessage: striderMessage,
      shellWrap:shellWrap,
      workingDir: workingDir,
      jobData: data,
      npmCmd: npmCmd,
      events: new EventEmitter(),
    }

    context.events.setMaxListeners(256)

    Step(
      function() {
        var next = this
        // Check if there's a git repo or not:
        if (fs.existsSync(workingDir + '/.git')){
          // Assume that the repo is good and that there are no
          // local-only commits.
          // TODO: Maybe fix this?
          // TODO: This assumes there will never be another repo with the same name :( would be better to clone into dir named after ssh_url
          var msg = "Updating repo from " + data.repo_ssh_url
          striderMessage(msg)
          gitane.run(workingDir, data.repo_config.privkey, 'git reset --hard', function(err, stdout, stderr) {
            if (err) {
              striderMessage("[ERROR] Git failure: " + stdout + stderr)
              return complete(1, null, null, done)
            }

            // XXX: `master branch` not guaranteed to exist. how do you find the default branch?
            gitane.run(workingDir, data.repo_config.privkey, 'git checkout master', function(err, stdout, stderr) {
              if (err)  {
                striderMessage("[ERROR] Git failure: " + stdout + stderr)
                return complete(1, null, null, done)
              }
              gitane.run(workingDir, data.repo_config.privkey, 'git pull', next)
            })
          })
        } else {
          exec('rm -rf ' + dir + ' ; mkdir -p ' + dir, function(err) {
            logger.log("cloning %s into %s", data.repo_ssh_url, dir)
            var msg = "Starting git clone of repo at " + data.repo_ssh_url
            striderMessage(msg)
            gitane.run(dir, data.repo_config.privkey, 'git clone --recursive ' + data.repo_ssh_url, next)
          })
        }
      },
      function(err, stderr, stdout) {
        if (err)  {
          striderMessage("[ERROR] Git failure: " + stdout + stderr)
          logger.log("[ERROR] Git failure: " + stdout + stderr)
          return complete(1, null, null, done)
        }
        var next = this
        updateStatus("queue.job_update", {stdout:stdout, stderr:stderr, stdmerged:stdout+stderr})
        var msg = "Git clone complete"
        logger.log(msg)
        striderMessage(msg)
        processDetectionRules(detectionRules, context, function(err, rules) {
          if (err) {
            var msg = "[ERROR] Could not process detection rules: " + err
            striderMessage(msg)
            logger.log(msg)
            return complete(1, null, null, done)
          }
          gumshoe.run(workingDir, rules, next)
        })
      },
      function(err, result, results) {
        if (!results) {
          results = []
        }

        var self = this

        var phases = ['prepare', 'test', 'deploy', 'cleanup']

        var f = []

        var noHerokuYet = true

        phases.forEach(function(phase) {
          // skip deploy on TEST_ONLY
          if (data.job_type === TEST_ONLY && phase === 'deploy') {
            f.push(function(cb) { return cb(null, []); });
            return;
          }
          f.push(function(cb) {
            var h = []

            results.concat(buildHooks).forEach(function(result) {

              var hook = function(context, cb) {
                logger.debug("running NO-OP hook for phase: %s", phase)
                cb(0)
              }


              // If actions are strings, we assume they are shell commands and try to execute them
              // directly ourselves.
              if (typeof(result[phase]) === 'string') {
                var psh = shellWrap(result[phase])
                hook = function(context, cb) {
                  logger.debug("running shell command hook for phase %s: %s", phase, result[phase])
                  forkProc(workingDir, psh.cmd, psh.args, cb)
                }
              }

              // Execution actions may be delegated to functions.
              // This is useful for example for multi-step things like in Python where a virtual env must be set up.
              // Functions are of signature function(context, cb)
              // We assume the function handles any necessary shell interaction and sending of update messages.
              if (typeof(result[phase]) === 'function') {
                hook = function(ctx, cb) {
                  logger.debug("running function hook for phase %s", phase)
                  result[phase](ctx, cb)
                }
              }

              // If this job has a Heroku deploy config attached, add a single Heroku deploy function
              if (phase === 'deploy' && data.deploy_config && noHerokuYet ) {
                logger.log("have heroku config - adding heroku deploy build hook")
                h.push(function(cb) {
                  striderMessage("Deploying to Heroku ...")
                  logger.debug("running Heroku deploy hook")
                  deployHeroku(workingDir,
                    data.deploy_config.app, data.deploy_config.privkey, function(herokuDeployExitCode) { 
                      if (herokuDeployExitCode !== 0) {
                        return cb({phase: phase, code: herokuDeployExitCode}, false)
                      }
                      cb(null, {phase: phase, code: herokuDeployExitCode})
                    }
                  )
                })
                // Never want to add more than one Heroku deploy build hook
                noHerokuYet = false
              }

              h.push(function(cb) {
                hook(context, function(hookExitCode, tasks) {
                  logger.debug("hook for phase %s complete with code %s", phase, hookExitCode)
                  // Cleanup hooks can't fail
                  if (phase !== 'cleanup' && hookExitCode !== 0 && hookExitCode !== undefined && hookExitCode !== null && hookExitCode !== false) {
                    return cb({phase: phase, code: hookExitCode, tasks: tasks}, false)
                  }
                  cb(null, {phase: phase, code: hookExitCode, tasks: tasks})
                })
              })

            })
            async.series(h, function(err, results) {
              cb(err, results)
            })
          })
        })
        async.series(f, function(err, results) {
            logger.log("results: %j", results)
            var tasks = []
            // make sure we run cleanup phase
            if (err && err.phase !== 'cleanup') {
              logger.debug("Failure in phase %s, running cleanup and failing build", err.phase)
              var runCleanup = f[phases.indexOf('cleanup')]
              return runCleanup(function(e) {
                complete(err.code, null, err.tasks, done)
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
            return complete(0, null, tasks, done)
        })
      }
    )
  }
}

// Add an array of detection rules to head of list
function addDetectionRules(r) {
  detectionRules = r.concat(detectionRules)
}

// Add a single detection rule to head of list
function addDetectionRule(r) {
  detectionRules = [r].concat(detectionRules)
}

// Add an array of build hooks to head of list
function addBuildHooks(h) {
  buildHooks = h.concat(buildHooks)
}

// Add a single build hook to the head of the list.
function addBuildHook(h) {
  buildHooks = [h].concat(buildHooks)
}

module.exports = function(context, cb, isTest) {
  // XXX test purposes
  detectionRules = DEFAULT_PROJECT_TYPE_RULES
  // Way to get functions out to tests
  if (isTest) {
    return {
      processDetectionRules: processDetectionRules
    }
  }
  // Build a worker context, which is a stripped-down version of the webapp context
  var workerContext = {
    addDetectionRule:addDetectionRule,
    addDetectionRules:addDetectionRules,
    addBuildHook:addBuildHook,
    addBuildHooks:addBuildHooks,
    config: context.config,
    extdir: context.extdir,
    npmCmd: npmCmd,
  }

  // Hooks for tests
  if (context.gitane) {
    gitane = context.gitane
  }
  if (context.gumshoe) {
    gumshoe = context.gumshoe
  }
  if (context.exec) {
    exec = context.exec
  }
  if (context.log) {
    logger = {log: context.log, debug: context.log}
  }

  Step(
    function() {
      context.loader.initExtensions(context.extdir, "worker", workerContext, null, this)
    },
    function(err, initialized) {
      registerEvents(context.emitter)
      logger.log("strider-simple-worker ready")
      cb(null, null)
    }
  )
}
