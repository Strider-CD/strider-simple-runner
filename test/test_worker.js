var expect = require('chai').expect
var EventEmitter = require('events').EventEmitter
var worker = require('../webapp')

describe('worker', function() {

  // Hook for initExtensions call
  var initExtensionsHook
  // Mock webapp context
  var containerCtx
  // Mock gitane module
  var mockGitane
  // Mock gumshoe module
  var mockGumshoe
  // Mock gumshoe result
  var mockGumshoeResult

  // Reset test state before each test
  beforeEach(function() {
    // Mock gitane module
    mockGitane = {
      run: function(dir, privkey, cmd, cb) {
        cb(null, "", "")
      }
    }
    // Mock gumshoe result
    mockGumshoeResult = {}
    // Mock gumshoe module
    mockGumshoe = {
      run:function(dir, rules, cb) {
        cb(null, mockGumshoeResult)
      }
    }
    initExtensionsHook = function(ctx, cb) { return cb(null, []) }
    // Mock webapp context
    containerCtx = {
      loader:{
        initExtensions: function(extdir, type, ctx, foo, cb) {
          initExtensionsHook(ctx, cb)
        }
      },
      exec: function(cmd, cb) { cb(null, null) },
      extdir: "foodir",
      config: {foo:"bar"},
      emitter: new EventEmitter(),
      gitane: mockGitane,
      gumshoe: mockGumshoe,
      // Silence output during tests
      log: function() {},
    }
  })

  // Tests for context given to extensions
  describe('#worker extension context', function() {

    it('should match API spec', function(done) {
      var ctxApiSpec = {
        forkProc:'function',
        updateStatus:'function',
        striderMessage:'function',
        shellWrap:'function',
        workingDir:'string',
        jobData:'object',
        npmCmd:'string'
      }
      var ctxApiKeys = Object.keys(ctxApiSpec)

      function verifyCtx(ctx) {
          for (var i=0; i<ctxApiKeys.length; i++) {
            var key = ctxApiKeys[i]
            var type = ctxApiSpec[key]
            expect(ctx).to.have.property(key)
                .that.is.a(type)
          }
      }

      mockGumshoeResult = {
        prepare: function(ctx, cb) {
          verifyCtx(ctx)
          cb(0)
        },
        test: function(ctx, cb) {
          verifyCtx(ctx)
          cb(0)
          done()
        },
      }
      worker(containerCtx, function(err, z) {
        containerCtx.emitter.emit('queue.new_job', {
          repo_ssh_url:"REPO_SSH_URL",
          repo_config: {
            privkey: "REPO_CONFIG.PRIVKEY"
          }
        })
      })
    })
  })

  describe('#forkProc', function() {
    it('should honour environment vars via opts arg', function(done) {
      var key = 'MY_TEST_VAR'
      var val = '12345'
      mockGumshoeResult = {
        // Hook for ctx.forkProc
        prepare: function(ctx, cb) {
          var env = {}
          env[key] = val
          var proc = ctx.forkProc({cmd:"/usr/bin/env", cwd:__dirname, args:[], env:env}, function(exitCode) {
            expect(exitCode).to.eql(0)
            expect(proc.stdoutBuffer).to.have.string('PAAS_NAME=strider')
            expect(proc.stdoutBuffer).to.have.string(key + '=' + val)
            done()
          })
        },
      }
      worker(containerCtx, function(err, z) {
        containerCtx.emitter.emit('queue.new_job', {
          repo_ssh_url:"REPO_SSH_URL",
          repo_config: {
            privkey: "REPO_CONFIG.PRIVKEY"
          }
        })
      })
    })

    it('should honour environment vars via repo_config', function(done) {
      var key = 'MY_TEST_VAR2'
      var val = '54321'
      var env = {}
      env[key] = val
      mockGumshoeResult = {
        // Hook for ctx.forkProc
        prepare: function(ctx, cb) {
          var proc = ctx.forkProc(
            {
              cmd:"/usr/bin/env",
              cwd:__dirname,
              args:[],
              env:{}
            }, function(exitCode) {
            expect(exitCode).to.eql(0)
            expect(proc.stdoutBuffer).to.have.string('PAAS_NAME=strider')
            expect(proc.stdoutBuffer).to.have.string(key + '=' + val)
            done()
          })
        },
      }
      worker(containerCtx, function(err, z) {
        containerCtx.emitter.emit('queue.new_job', {
          repo_ssh_url:"REPO_SSH_URL",
          repo_config: {
            env:env,
            privkey: "REPO_CONFIG.PRIVKEY"
          }
        })
      })
    })

  })

})
