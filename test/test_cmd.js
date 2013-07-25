
var expect = require('chai').expect
  , EventEmitter = require('events').EventEmitter
  , cmd = require('../lib/cmd')

describe('cmd', function () {
  describe('.shellWrap', function () {
    it('should wrap', function () {
      expect(cmd.shellWrap('echo hello')).to.eql({cmd: 'sh', args: ['-c', 'echo hello']})
    })
  })

  describe('.shellUnwrap', function () {
    it('should unwrap a shellwrapped command', function () {
      var opts = cmd.shellWrap('echo hello')
      expect(cmd.shellUnwrap(opts.cmd, opts.args)).to.equal('echo hello')
    })

    it('should stringify other commands', function () {
      expect(cmd.shellUnwrap('git', ['clone', 'stuff'])).to.equal('git clone stuff')
    })
  })
  describe('.run', function() {
    it('should report error exit code', function (done) {
      var io = new EventEmitter()
      cmd.run({
        io: io,
        command: 'false',
        cwd: __dirname,
        pty: false
      }, function (code, sout, serr) {
        expect(code).to.not.equal(0)
        done()
      })
    })

    it('should report another error exit code', function (done) {
      var io = new EventEmitter()
      cmd.run(io, 'notarealcommand', __dirname, function (code) {
        expect(code).to.not.equal(0)
        done()
      })
    })

    it('should honour environment vars via opts arg', function(done) {
      this.timeout(10000)
      var key = 'MY_TEST_VAR'
        , val = '12345'
        , io = new EventEmitter()
        , env = {}
      env[key] = val
      cmd.run({
        io: io,
        command: '/usr/bin/env',
        cwd: __dirname,
        env: env
      }, function (exitCode, sout, serr) {
        expect(exitCode).to.eql(0)
        expect(sout).to.have.string(key + '=' + val)
        done()
      })
    })
  })
})
