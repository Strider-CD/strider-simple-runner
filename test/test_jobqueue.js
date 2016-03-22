
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

  // Execute a function after each queue drain. Each function should finish with an action that
  // causes a drain to occur (push a new task or complete an active task).
  function onEachDrain(steps, done) {
    var wrappedSteps = []

    var makeStep = function (arg) {
      return function (cb) {
        q.onNextDrain(cb)

        arg()
      }
    }

    for (var i = 0; i < steps.length; i++) {
      wrappedSteps.push(makeStep(steps[i]))
    }

    async.series(wrappedSteps, done)
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

      onEachDrain([
        function () {
          q.push({ _id: 1 })
        },
        function () {
          expect(handlers[1].wasCalled).to.be(true)
          q.push({ _id: 2 })
        },
        function () {
          expect(handlers[2].wasCalled).to.be(false)
          handlers[1].finish()
        }
      ], function () {
        expect(handlers[2].wasCalled).to.be(true)

        handlers[2].finish()
        done()
      });
    })
  })

  describe('with concurrency 2', function () {
    beforeEach(function () {
      q = new JobQueue(handlerDispatch, 2)
    })

    it('executes the first two tasks immediately, then waits for task completion', function (done) {
      expectJobs(1, 2, 3)

      onEachDrain([
        function () {
          q.push({ _id: 1 })
        },
        function () {
          expect(handlers[1].wasCalled).to.be(true)
          q.push({ _id: 2 })
        },
        function () {
          expect(handlers[2].wasCalled).to.be(true)
          q.push({ _id: 3 })
        },
        function () {
          // The queue was saturated when job 3 was added. It should not have run yet
          expect(handlers[3].wasCalled).to.be(false)
          handlers[2].finish()
        },
        function () {
          expect(handlers[3].wasCalled).to.be(true)

          // Call the handlers for jobs 1 and 3 to be tidy.
          handlers[1].finish()
        }
      ], function () {
        handlers[3].finish()
        done()
      })
    });
  })
})
