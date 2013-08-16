
var expect = require('expect.js')
  , utils = require('../lib/utils')

describe('utils', function () {
  describe('ensureCommand', function () {
    var phase
    describe('when there are no commands', function () {
      beforeEach(function () {
        phase = {commands: []}
      })

      it('should create a command if there were none', function () {
        expect(utils.ensureCommand(phase)).to.be.ok()
        expect(phase.commands.length).to.equal(1)
      })

    })

    describe('when the last command is not completed', function () {
      beforeEach(function () {
        phase = {commands: [{out: '', err: '', merged: ''}]}
      })

      it('should not add a command', function () {
        var prev = phase.commands[0]
        expect(utils.ensureCommand(phase)).to.equal(prev)
        expect(phase.commands.length).to.equal(1)
      })

    })

    describe('when the last command has completed', function () {
      beforeEach(function () {
        phase = {commands: [{finished: new Date()}]}
      })

      it('should add a command', function () {
        var prev = phase.commands[0]
        expect(utils.ensureCommand(phase)).to.not.equal(prev)
        expect(phase.commands.length).to.equal(2)
      })

    })

  })

})
