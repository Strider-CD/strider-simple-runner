// Strider Simple Worker
// Niall O'Higgins 2012
//
// A simple, in-process worker implementation for Strider.
//

var async = require('async')
var exec = require('child_process').exec
var EventEmitter = require('events').EventEmitter
var gitane = require('gitane')
var gumshoe = require('gumshoe')
var path = require('path')
var spawn = require('child_process').spawn
var Step = require('step')


// Work around npm not being installed on some systems - use own copy
// the test clause is for Heroku
var npmCmd = "$(test -x ~/bin/node && echo ~/bin/node || echo node) ../../node_modules/npm/bin/npm-cli.js"
var nodePrepare = npmCmd + " install"
var nodeTest = npmCmd + " test"
var nodeStart = npmCmd + " start"

// Built-in rules for project-type detection
var DEFAULT_PROJECT_TYPE_RULES = [
  // Node
  {filename:"package.json", grep:/express/i, language:"node.js", framework:"express", prepare:nodePrepare, test:nodeTest, start:nodeStart},
  {filename:"package.json", grep:/connect/i, language:"node.js", framework:"connect", prepare:nodePrepare, test:nodeTest, start:nodeStart},
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
// pre-start commands which may be added by worker plugins
// E.g. to start mongodb or postgresql
// pre-start commands may be either a string or a function
// XXX: foreground vs daemonprocesses

// if a string, this is a shell command to be executed to run project tests (e.g. "mongod")
// if a function, this accepts a callback argument of signature function(err) which must be called.
var setupActions = []
// teardown commands which may be added by worker plugins
// E.g. to stop mongodb or postgresql
// teardown commands may be either a string or a function
// XXX: foreground vs daemonprocesses
// if a string, this is a shell command to be executed to run project tests (e.g. "kill $PID")
// if a function, this accepts a callback argument of signature function(err) which must be called.
var teardownActions = []

// Return path to writeable dir for test purposes
function getDataDir() {
  return path.join(__dirname, "_work")
}

// Wrap a shell command for execution by spawn()
function shellWrap(str) {
  return { cmd:"sh", args:["-c", str] }
}

// Default logger
logger = {log: console.log}

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
      }
      if (opts.testExitCode !== undefined) {
        msg.testExitCode = opts.testExitCode
      }
      if (opts.deployExitCode !== undefined) {
        msg.deployExitCode = opts.deployExitCode
      }

      emitter.emit(evType, msg)
    }

    // Insert a synthetic (non job-generated) output message
    // This automatically prefixes with "[STRIDER]" to make the source
    // of the message clearer to the user.
    function striderMessage(message) {
      var msg = "[STRIDER] " + message + "\n"
      stdmergedBuffer += msg
      stdoutBuffer += msg
      updateStatus("queue.job_update", {stdout:msg, stdmerged:msg})
    }


    // Deploy to Heroku
    function deployHeroku(cwd, app, key, cb) {
      var cmd = 'git remote add heroku git@heroku.com:' + app + '.git'
      gitane.run(cwd, key, cmd, function(err, stdout, stderr) {
        if (err) return cb(1, null)
        stdoutBuffer += stdout
        stderrBuffer += stderr
        stdmergedBuffer += stdout + stderr
        updateStatus("queue.job_update", {stdout:stdout, stderr:stderr, stdmerged:stdout+stderr})
        cmd = 'git push heroku --force master'
        gitane.run(cwd, key, cmd, function(err, stdout, stderr) {
          if (err) return cb(1, null)
          stdoutBuffer += stdout
          stderrBuffer += stderr
          stdmergedBuffer += stdout + stderr
          updateStatus("queue.job_update", {stdout:stdout, stderr:stderr, stdmerged:stdout+stderr})
          striderMessage("Deployment to Heroku successful.")
          cb(0)
        })
      })
    }

    function mergeObj(src, dst) {
      var keys = Object.keys(src)
      for (var i=0; i < keys.length; i++) {
        dst[keys[i]] = src[keys[i]]
      }
    }

    //
    // forkProc(cwd, shell, cb)
    // or
    // forkProc(cwd, cmd, args, cb)
    // or
    // forkProc({opts}, cb)
    //
    function forkProc(cwd, cmd, args, cb) {
      var env = process.env
      if (data.repo_config.env !== undefined) {
        mergeObj(data.repo_config.env, env)
      }
      if (typeof(cwd) === 'object') {
        cb = cmd
        var cmd = cwd.cmd
        var args = cwd.args
        // Merge/override any variables
        mergeObj(cwd.env, env)
        cwd = cwd.cwd
      }
      if (typeof(cmd) === 'string' && typeof(args) === 'function') {
        var split = cmd.split(/\s+/)
        cmd = split[0]
        cb = args
        args = split.slice(1)
      }
      env.PAAS_NAME = 'strider'
      var proc = spawn(cmd, args, {cwd: cwd, env: env})

      // per-process output buffers
      proc.stderrBuffer = ""
      proc.stdoutBuffer = ""
      proc.stdmergedBuffer = ""

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
      })

      return proc
    }

    Step(
      function() {
        // XXX: Support incremental builds at some point
        exec('rm -rf ' + dir + ' ; mkdir -p ' + dir, this)
      },
      function(err) {
        if (err) throw err
        logger.log("cloning %s into %s", data.repo_ssh_url, dir)
        var msg = "Starting git clone of repo at " + data.repo_ssh_url
        striderMessage(msg)
        gitane.run(dir, data.repo_config.privkey, 'git clone ' + data.repo_ssh_url, this)
      },
      function(err, stderr, stdout) {
        if (err) throw err
        this.workingDir = path.join(dir, path.basename(data.repo_ssh_url.replace('.git', '')))
        updateStatus("queue.job_update", {stdout:stdout, stderr:stderr, stdmerged:stdout+stderr})
        var msg = "Git clone complete"
        logger.log(msg)
        striderMessage(msg)
        gumshoe.run(this.workingDir, detectionRules, this)
      },
      function(err, result) {
        if (err) throw err
        // TODO: Setup phase (database bringup, etc)

        // Context object for action functions
        var context = {
          forkProc: forkProc,
          updateStatus: updateStatus,
          striderMessage: striderMessage,
          shellWrap:shellWrap,
          workingDir: this.workingDir,
          jobData: data,
          npmCmd: npmCmd,
          events: new EventEmitter(),
        }

        // No-op defaults
        var prepare, test, deploy
        prepare = test = deploy = function(context, cb) {
          cb(null)
        }
        // If this job has a Heroku deploy config attached, use the Heroku deploy function
        if (data.deploy_config) {
          logger.log("have heroku config")
          var self = this
          deploy = function(ctx, cb) {
            striderMessage("Deploying to Heroku ...")
            deployHeroku(self.workingDir,
              data.deploy_config.app, data.deploy_config.privkey, cb)
          }
        }


        function complete(testCode, deployCode, cb) {
          updateStatus("queue.job_complete", {
            stderr:stderrBuffer,
            stdout:stdoutBuffer,
            stdmerged:stdmergedBuffer,
            testExitCode:testCode,
            deployExitCode:deployCode
          })
          if (typeof(cb) === 'function') cb(null)
        }

        // If actions are strings, we assume they are shell commands and try to execute them
        // directly ourselves.
        var self = this
        if (typeof(result.prepare) === 'string') {
          var psh = shellWrap(result.prepare)
          prepare = function(context, cb) {
            forkProc(self.workingDir, psh.cmd, psh.args, cb)
          }
        }

        if (typeof(result.test) === 'string') {
          var tsh = shellWrap(result.test)
          test = function(context, cb) {
            forkProc(self.workingDir, tsh.cmd, tsh.args, cb)
          }
        }

        if (typeof(result.deploy) === 'string') {
          var tsh = shellWrap(result.deploy)
          deploy = function(context, cb) {
            forkProc(self.workingDir, tsh.cmd, tsh.args, cb)
          }
        }
        // Execution actions may be delegated to functions.
        // This is useful for example for multi-step things like in Python where a virtual env must be set up.
        // Functions are of signature function(context, cb)
        // We assume the function handles any necessary shell interaction and sending of update messages.
        if (typeof(result.prepare) === 'function') {
          prepare = result.prepare
        }
        if (typeof(result.test) === 'function') {
          test = result.test
        }
        if (typeof(result.deploy) === 'function') {
          deploy = result.deploy
        }

        prepare(context, function(prepareExitCode) {
          if (prepareExitCode !== 0) {
            // Prepare step failed
            var msg = "Prepare failed; exit code: " + prepareExitCode
            striderMessage(msg)
            logger.log(msg)
            logger.log("stdmergedBuffer: %s", stdmergedBuffer);
            return complete(prepareExitCode, null, done)
          }
          test(context, function(testExitCode) {
            var msg = "Test exit code: " + testExitCode
            logger.log(msg)
            striderMessage(msg)
            if (testExitCode !== 0 || data.job_type !== "TEST_AND_DEPLOY") {
              // Test step failed or no deploy requested
              complete(testExitCode, null, done)
            } else {
              // Test step passed and deploy requested
              deploy(context, function(deployExitCode) {
                complete(testExitCode, deployExitCode, done)
              })
            }

          })
        })

        // TODO: Teardown phase (database shutdown, etc)

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

module.exports = function(context, cb) {
  // XXX test purposes
  detectionRules = DEFAULT_PROJECT_TYPE_RULES
  // Build a worker context, which is a stripped-down version of the webapp context
  var workerContext = {
    addDetectionRule:addDetectionRule,
    addDetectionRules:addDetectionRules,
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
    logger = {log: context.log}
  }

  Step(
    function() {
      context.loader.initExtensions(context.extdir, "worker", workerContext, null, this)
    },
    function(err, initialized) {
      registerEvents(context.emitter)
      logger.log("Strider Simple Worker ready")
      cb(null, null)
    }
  )
}
