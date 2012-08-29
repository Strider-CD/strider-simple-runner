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

// Built-in rules for project-type detection
var DEFAULT_PROJECT_TYPE_RULES = [

  // Node
  {filename:"package.json", grep:/express/i, language:"node.js", framework:"express", prepare:"npm install", test:"npm test"},
  {filename:"package.json", grep:/connect/i, language:"node.js", framework:"connect", prepare:"npm install", test:"npm test"},
  {filename:"package.json", exists:true, language:"node.js", framework:null, prepare:"npm install", test:"npm test"},
  // Python
  {filename:"setup.py", grep:/pyramid/i, language:"python", framework:"pyramid"},
  {filename:"manage.py", grep:/django/i, language:"python", framework:"django"},
  {filename:"setup.py", exists:true, language:"python", framework:null},

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


  // the queue.new_task event is primary way jobs are submitted
  //

  emitter.on('queue.new_job', function(data) {

    function updateStatus(evType, timeElapsed, opts) {
      var msg = {
        userId:data.user_id,
        jobId:data.job_id,
        timeElapsed:timeElapsed,
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

    // cross-process (per-job) output buffers
    var stderrBuffer = ""
    var stdoutBuffer = ""
    var stdmergedBuffer = ""

    function forkProc(t1, cwd, shell) {
      var split = shell.split(/\s+/)
      var cmd = split[0]
      var args = split.slice(1)
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
        var t2 = new Date()
        var elapsed = (t2.getTime() - t1.getTime()) / 1000
        updateStatus("queue.task_update", elapsed, {stdout:buf})
      })

      proc.stderr.on('data', function(buf) {
        proc.stderrBuffer += buf
        proc.stdmergedBuffer += buf
        stderrBuffer += buf
        stdmergedBuffer += buf
        var t2 = new Date()
        var elapsed = (t2.getTime() - t1.getTime()) / 1000
        updateStatus("queue.task_update", elapsed, {stderr:buf})
      })

      return proc
    }

    function doTestRun(cwd, prepareCmd, testCmd) {
      var preProc = forkProc(t1, cwd, prepareCmd)
      preProc.on('exit', function(exitCode) {
        console.log("process exited with code: %d", exitCode)
        if (exitCode === 0) {
          // Preparatory phase completed OK - continue
          var testProc = forkProc(t1, cwd, testCmd)

          testProc.on('exit', function(exitCode) {
            var t2 = new Date()
            var elapsed = (t2.getTime() - t1.getTime()) / 1000
            updateStatus("queue.task_complete", elapsed, {
              stderr:stderrBuffer,
              stdout:stdoutBuffer,
              stdmerged:stdmergedBuffer,
              testExitCode:exitCode,
              deployExitCode:null
            })
          })
        } else {
          var t2 = new Date()
          var elapsed = (t2.getTime() - t1.getTime()) / 1000
          updateStatus("queue.task_complete", elapsed, {
            stderr:stderrBuffer,
            stdout:stdoutBuffer,
            stdmerged:stdmergedBuffer,
            testExitCode:exitCode,
            deployExitCode:null
          })

        }
      })
    }

    var dir = path.join(__dirname, '_work')
    console.log('new job')
    var t1 = new Date()
    Step(
      function() {
        // XXX: Support incremental builds at some point
        exec('rm -rf ' + dir + ' ; mkdir -p ' + dir, this)
      },
      function(err) {
        if (err) throw err
        console.log("cloning %s", data.repo_ssh_url)
        var t2 = new Date()
        var elapsed = (t2.getTime() - t1.getTime()) / 1000
        var msg = "Starting git clone of repo at " + data.repo_ssh_url + "\n"
        updateStatus("queue.task_update", elapsed, {stdout:msg, stdmerged:msg})
        gitane.run(dir, data.repo_config.privkey, 'git clone ' + data.repo_ssh_url, this)
      },
      function(err, stderr, stdout) {
        if (err) throw err
        this.workingDir = path.join(dir, path.basename(data.repo_ssh_url.replace('.git', '')))
        var t2 = new Date()
        var elapsed = (t2.getTime() - t1.getTime()) / 1000
        var msg = "Git clone complete\n"
        updateStatus("queue.task_update", elapsed, {stdout:stdout, stderr:stderr, stdmerged:stdout+stderr})
        updateStatus("queue.task_update", elapsed, {stdout:msg, stdmerged:msg})
        gumshoe.run(this.workingDir, detectionRules, this)
      },
      function(err, result) {
        if (err) throw err
        // XXX: Setup
        doTestRun(this.workingDir, result.prepare, result.test)
        // XXX: Teardown

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
