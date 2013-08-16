
var expect = require('expect.js')
  , EventEmitter2 = require('eventemitter2').EventEmitter2

  , Runner = require('../lib')

describe('Runner', function () {
  var runner, io, processing, processJob
  beforeEach(function () {
    processJob = function () { processing = [].slice.call(arguments) }
    io = new EventEmitter2()
    runner = new Runner(io, {
      processJob: function (task, config, next) {
        processJob(task, config, next)
      },
      logger: {log: function () {}}
    })
  })
  it('should listen for job.new', function () {
    io.emit('job.new', {job: {id: 'jobid'}})
    expect(runner.jobdata.get('jobid')).to.be.ok()
  })
  
  describe('with a few queued jobs', function () {
    var ids = ['id1', 'id2', 'id3']
    beforeEach(function () {
      processJob = function () {}
      ids.forEach(function (id) {
        runner.queueJob({job: {id: id}})
      })
    })
    describe('#cancelJob', function () {

      it('should cancel a queued job', function (done) {
        io.on('job.cancelled', function (id, data) {
          expect(id).to.equal(ids[1])
          expect(runner.queue.length()).to.equal(1)
          done()
        })
        runner.cancelJob(ids[1])
      })

      it('should pass on the cancel event if the job is not queued', function (done) {
        var nid = 'anotherId'
        runner.io.on('job.cancel', function (id) {
          expect(id).to.equal(nid)
          done()
        })
        runner.cancelJob(nid)
      })

    })

  })

  it('should report up errors', function (done) {
    processJob = function (task, config, next) {
      next(new Error('problems!'))
    }
    var got = {}
    io.on('job.done', function () {
      expect(got.errored, 'browser errored event').to.be.ok()
      done()
    })
    io.on('browser.update', function (type, args) {
      if (type === 'job.status.errored') {
        got.errored = true
      }
    })
    runner.queueJob({job: {id: 'theId'}})
  })

  it('should send done event', function (done) {
    var nid = 'theId'
    processJob = function (task, config, next) {
      next(new Error('problems!'))
    }
    io.on('job.done', function (job) {
      expect(job.id).to.equal(nid)
      done()
    })
    runner.queueJob({job: {id: nid}})
  })

})
