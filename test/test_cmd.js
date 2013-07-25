
var expect = require('chai').expect
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
})
