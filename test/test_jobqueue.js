
var expect = require('expect.js')
  , async = require('async')
  , JobQueue = require('../lib/jobqueue.js');

describe('JobQueue', function () {
  var q, handlers

  beforeEach(function () {
    handlers = {}
  })

  // Configure a handler to be updated when handlerDispatch executes a job with an expected ID.
  function expectJobs() {
    function defaultFinish() {
      throw new Error('Job ' + jid + ' was never handled')
    }

    for (var i = 0; i < arguments.length; i++) {
      var jid = arguments[i]

      handlers[jid] = {
        wasCalled: false,
        finish: defaultFinish
      }
    }
  }

  // JobQueue handler function that manipulates handler objects set up in advance with expectJob.
  function handlerDispatch(job, config, cb) {
    var jid = job._id
    var handler = handlers[jid]
    if (!handler) {
      return cb(new Error('Unexpected job id ' + jid))
    }

    handler.wasCalled = true
    handler.finish = function () {
      cb(null)
    }
  }

  describe('with concurrency 1', function () {
    beforeEach(function () {
      q = new JobQueue(handlerDispatch, 1)
    })

    it('executes on push on next tick when unsaturated', function (done) {
      expectJobs(1)

      q.push({ _id: 1 })

      q.onNextDrain(function () {
        expect(q.isActive(1)).to.be(true)
        expect(handlers[1].wasCalled).to.be(true)

        handlers[1].finish()
        done()
      })
    })

    it('waits for an available task slot when saturated', function (done) {
      expectJobs(1, 2)

      async.series([
        function (cb) {
          q.onNextDrain(cb)

          q.push({ _id: 1 })
        },
        function (cb) {
          q.onNextDrain(cb)

          expect(handlers[1].wasCalled).to.be(true)

          // The queue is now saturated.
          q.push({ _id: 2 })
        },
        function (cb) {
          q.onNextDrain(cb)

          expect(handlers[2].wasCalled).to.be(false)

          // Finishing job 1's handler causes a slot to open, so job 2 can now run.
          handlers[1].finish()
        },
        function (cb) {
          expect(handlers[2].wasCalled).to.be(true)

          handlers[2].finish()
          cb()
        }
      ], done)
    })
  })
})
