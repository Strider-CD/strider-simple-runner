// Strider Simple Worker
// Niall O'Higgins 2012
//
// A simple, in-process worker implementation for Strider.
//

var exec = require('child_process').exec
var gitane = require('gitane')
var gumshoe = require('gumshoe')
var path = require('path')
var spawn = require('child_process').spawn
var Step = require('step')

var djangoPrepare = "virtualenv-2.7 env && env/bin/pip -r requirements.txt"
var djangoTest = "env/bin/python manage.py test"
var setupPyPrepare = "virtualenv-2.7 env && env/bin/python setup.py develop ; env/bin/pip -r requirements.txt"
var setupPyTest = "env/bin/python setup.py test"

// Built-in rules for project-type detection
var DEFAULT_PROJECT_TYPE_RULES = [

  // Node
  {filename:"package.json", grep:/express/i, language:"node.js", framework:"express", prepare:"npm install", test:"npm test", start:"npm start"},
  {filename:"package.json", grep:/connect/i, language:"node.js", framework:"connect", prepare:"npm install", test:"npm test", start:"npm start"},
  {filename:"package.json", exists:true, language:"node.js", framework:null, prepare:"npm install", test:"npm test", start:"npm start"},
  // Python
  {filename:"setup.py", grep:/pyramid/i, language:"python", framework:"pyramid", prepare:setupPyPrepare, test:setupPyTest},
  {filename:"manage.py", grep:/django/i, language:"python", framework:"django", prepare:djangoPrepare, test:djangoTest},
  {filename:"setup.py", exists:true, language:"python", framework:null, prepare:setupPyPrepare, test:setupPyTest},

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

function registerEvents(emitter) {


  // the queue.new_job event is primary way jobs are submitted
  //

  emitter.on('queue.new_job', function(data) {
    // cross-process (per-job) output buffers
    var stderrBuffer = ""
    var stdoutBuffer = ""
    var stdmergedBuffer = ""
    // Put stuff under `_work`
    var dir = path.join(__dirname, '_work')
    console.log('new job')
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
        updateStatus("queue.task_update", {stdout:msg, stdmerged:msg})
    }


    function forkProc(cwd, shell, cb) {
      var split = shell.split(/\s+/)
      var cmd = split[0]
      var args = split.slice(1)
      // Inherit parent environment
      var env = process.env
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
        updateStatus("queue.task_update" , {stdout:buf})
      })

      proc.stderr.on('data', function(buf) {
        proc.stderrBuffer += buf
        proc.stdmergedBuffer += buf
        stderrBuffer += buf
        stdmergedBuffer += buf
        updateStatus("queue.task_update", {stderr:buf})
      })

      proc.on('exit', function(exitCode) {
        console.log("process exited with code: %d", exitCode)
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
        console.log("cloning %s into %s", data.repo_ssh_url, dir)
        var msg = "Starting git clone of repo at " + data.repo_ssh_url
        striderMessage(msg)
        gitane.run(dir, data.repo_config.privkey, 'git clone ' + data.repo_ssh_url, this)
      },
      function(err, stderr, stdout) {
        if (err) throw err
        this.workingDir = path.join(dir, path.basename(data.repo_ssh_url.replace('.git', '')))
        updateStatus("queue.task_update", {stdout:stdout, stderr:stderr, stdmerged:stdout+stderr})
        var msg = "Git clone complete"
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
          workingDir: this.workingDir,
        }

        // No-op defaults
        var prepare = test = deploy = function(context, cb) {
          cb(null)
        }


        function complete(testCode, deployCode, cb) {
          updateStatus("queue.task_complete", {
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
          prepare = function(context, cb) {
            forkProc(self.workingDir, result.prepare, cb)
          }
        }

        if (typeof(result.test) === 'string') {
          test = function(context, cb) {
            forkProc(self.workingDir, result.test, cb)
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

        prepare(context, function(prepareExitCode) {
          if (prepareExitCode !== 0) {
            // Prepare step failed
            var msg = "Prepare failed; exit code: " + testExitCode
            striderMessage(msg)
            console.log(msg)
            return complete(prepareExitCode, null)
          }
          test(context, function(testExitCode) {
            var msg = "Test exit code: " + testExitCode
            console.log(msg)
            striderMessage(msg)
            if (testExitCode !== 0 || data.job_type !== "TEST_AND_DEPLOY") {
              // Test step failed or no deploy requested
              complete(testExitCode, null)
            } else {
              // Test step passed and deploy requested
              deploy(context, function(deployExitCode) {
                complete(testExitCode, deployExitCode)
              })
            }

          })
        })


        // TODO: Deploy (e.g. Heroku, dotCloud)

        // TODO: Teardown phase (database shutdown, etc)

      }

    )
  })
}

// Add an array of detection rules
function addDetectionRules(r) {
  detectionRules = detectionRules.concat(r)
}

// Add a single detection rule
function addDetectionRule(r) {
  detectionRules.push(r)
}

module.exports = function(context, cb) {
  // XXX test purposes
  detectionRules = DEFAULT_PROJECT_TYPE_RULES
  // Build a worker context, which is a stripped-down version of the webapp context
  var workerContext = {
    addDetectionRule:addDetectionRule,
    addDetectionRules:addDetectionRules,
    config: context.config,
    emitter: context.emitter,
    extdir: context.extdir,
  }

  Step(
    function() {
      context.loader.initExtensions(context.extdir, "worker", workerContext, null, this)
    },
    function(err, initialized) {
      registerEvents(context.emitter)
      console.log("Strider Simple Worker ready")
      cb(null, null)
    }
  )

}
