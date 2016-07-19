var _ = require('lodash');
var consts = require('./consts');
var stringify = require('json-stable-stringify');

module.exports = {
  ensureCommand: ensureCommand,
  branchFromJob: branchFromJob
};

function ensureCommand(phase) {
  var command = phase.commands[phase.commands.length - 1];
  if (!command || typeof(command.finished) !== 'undefined') {
    command = _.extend({}, consts.skels.command);
    phase.commands.push(command);
  }
  return command;
}

// Extract a branch name, suitable for use as a filesystem path, from the contents of the job's
// ref field. Prefer common ref structures when available (branch, fetch) but fall back to something
// that's ugly but unique and stable for arbitrary ref payloads.
function branchFromJob(job) {
  var ref = job.ref;

  if (typeof ref === 'undefined') {
    return '';
  }

  if ('branch' in ref) {
    return ref.branch;
  } else if ('fetch' in ref) {
    return ref.fetch;
  } else {
    // This is going to be incredibly ugly, but it will be (a) consistent for consistent refs and
    // (b) include only filesystem-safe characters.
    return encodeURIComponent(stringify(ref));
  }
}
