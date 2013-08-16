
var expect = require('expect.js')
  , EventEmitter2 = require('eventemitter2').EventEmitter2

  , JobData = require('../lib/jobdata')

describe('JobData', function () {
  var io, JD
  beforeEach(function () {
    io = new EventEmitter2()
    JD = new JobData(io)
  })

  describe('with a job', function () {
    var job, id = 'ajobId'
    beforeEach(function () {
      job = JD.add(id)
    })

    describe('get', function () {
      it('should retrieve the job', function () {
        expect(JD.get(id)).to.equal(job)
      })

    })

    describe('pop', function () {
      it('should retrieve and remove the job', function () {
        expect(JD.pop(id)).to.equal(job)
        expect(JD.get(id)).to.not.be.ok()
      })

    })

    describe('listeners', function () {

      it('should propagate to the job', function () {
        io.emit('job.status.command.start', id, 'echo', new Date(), null)
        expect(job.phases[job.phase].commands[0].cmd).to.equal('echo')
      })

    })

  })
  
})
