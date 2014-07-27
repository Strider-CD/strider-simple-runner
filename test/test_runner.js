
var expect = require('expect.js')
  , EventEmitter2 = require('eventemitter2').EventEmitter2

  , Runner = require('../lib')

describe('Runner', function () {
  var runner, io, processing, processJob
  beforeEach(function (done) {
    processJob = function () { processing = [].slice.call(arguments) }

    io = new EventEmitter2()
    runner = new Runner(io, {
      processJob: function (job, provider, providerPlugins, config, next) {
        processJob.apply(null, arguments)
      },
      logger: {log: function () {}}
    })
    runner.loadExtensions = function(dirs, done) {
      this.extensions = {provider:{"test": {init:function() {Array.prototype.slice.call(arguments, 0)[3]()}}}}
      done(null)
    }
    runner.loadExtensions = runner.loadExtensions.bind(runner)
    runner.loadExtensions([], done)
  })
  it('should listen for job.new', function () {
    io.emit('job.new', {_id: 'jobid', project: {name: 'man'}}, {runner: {id: 'simple-runner'}})
    expect(runner.jobdata.get('jobid')).to.be.ok()
    runner.queue.tasks.length = 0
  })

  it('should have correct options passed through to processJob', function (done) {
    var runner = new Runner(io, {
      processJob: function (job, provider, providerPlugins, config, next) {
        expect(config.cachier).to.be.ok()
        expect(config.baseDir).to.be.ok()
        expect(config.dataDir).to.be.ok()
        expect(config.cacheDir).to.be.ok()
        expect(config.io).to.be.ok()
        expect(config.env).to.be.ok()
        done()
      },
      logger: {log: function () {}}
    })
    runner.loadExtensions = function(dirs, complete) {
      this.extensions = {provider:{"test": {init:function() {Array.prototype.slice.call(arguments, 0)[3]()}}}}
      complete(null)
    }
    runner.loadExtensions = runner.loadExtensions.bind(runner)
    runner.loadExtensions([], function () {
      runner.queueJob({_id: 'id1', project: {name: 'man', provider:{id: 'test'}}}, {runner: {id: 'simple-runner'}, plugins: []})
    })
  })

  describe('with a few queued jobs', function () {
    var ids = ['id1', 'id2', 'id3']
    beforeEach(function (done) {
      processJob = function () {
        Array.prototype.slice.call(arguments, 0)[4]()
      }
      ids.forEach(function (id) {
        runner.queueJob({_id: id, project: {name: 'man', provider:{id: 'test'}}}, {runner: {id: 'simple-runner'}, plugins: []})
      })
      done();
    })

    afterEach(function () {
      io.removeAllListeners();
    });

    describe('#cancelJob', function () {

      it('should cancel a queued job', function (done) {
        io.on('job.done', function (job, data) {
          expect(job.id).to.equal(ids[1])
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

  /*
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
    runner.queueJob({_id: 'theId', project: {name: 'hoya'}}, {runner: {id: 'simple-runner'}, plugins: []})
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
    runner.queueJob({_id: nid, project: {name: 'hoya'}}, {runner: {id: 'simple-runner'}, plugins: []})
  })
 */

})
