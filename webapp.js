// Strider Simple Worker
// Niall O'Higgins 2012
//
// A simple, in-process worker implementation for Strider.
//

var exec = require('child_process').exec
var gitane = require('gitane')
var path = require('path')
var Step = require('step')

function registerEvents(emitter) {
  // the queue.new_task event is primary way jobs are submitted

  emitter.on('queue.new_task', function(data) {
    var dir = path.join(__dirname, '_work')
    console.log('new job')
    Step(
      function() {
        exec('mkdir ' + dir, this)
      },
      function(err) {
        if (err) throw err
        gitane.run(dir, data.repo_config.privkey, 'git clone ' + data.repo_ssh_url, this)
      },
      function(err) {
        if (err) throw err
        console.log("checked out!")
      }
    )
  })


}

module.exports = function(context, cb) {
  registerEvents(context.emitter)
  // Do something with worker plugins here
  cb(null, null)
}
