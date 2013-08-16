
var _ = require('lodash')

  , consts = require('./consts')

module.exports = {
  ensureCommand: ensureCommand
}

function ensureCommand(phase) {
  var command = phase.commands[phase.commands.length - 1]
  if (!command || typeof(command.finished) !== 'undefined') {
    command = _.extend({}, consts.skels.command)
    phase.commands.push(command)
  }
  return command
}

