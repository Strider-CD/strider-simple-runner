
var expect = require('chai').expect
  , utils = require('../lib/utils')
  , cmd = require('../lib/cmd')

describe('utils', function () {
  describe('.getUrls', function () {
    var repo = 'git@github.com:Strider-CD/strider.git'
      , https_end = 'github.com/Strider-CD/strider.git'
      , api_key = '123456asd345'
    it('should no-op if using an ssh key', function () {
      expect(utils.getUrls(repo, 'asd', api_key)).to.eql([repo, repo])
    })

    it('should make a screen-friendly version without the api key', function () {
      expect(utils.getUrls(repo, false, api_key)).to.eql([
        'https://' + api_key + ':@' + https_end,
        'https://[github oauth key]@' + https_end
      ])
    })

    it('should just give the https urls if no api and no ssh', function () {
      expect(utils.getUrls(repo, false, false)).to.eql([
        'https://' + https_end,
        'https://' + https_end
      ])
    })
  })

  describe('.getHookFn', function () {
    it('should no-op when no hook is found', function (done) {
      // is there a better way to validate this?
      utils.getHookFn(undefined)({}, function (code) {
        expect(code).to.equal(0)
        done()
      })
    })

    it('should make a forkProc hook if a string is found', function (done) {
      var callback = function (code){
            expect(code).to.equal(0)
            done()
          }
        , command = 'make test'
        , wrapped = cmd.shellWrap(command)
        , cwd = '/'
      utils.getHookFn(command)({
        workingDir: cwd,
        shellWrap: cmd.shellWrap,
        forkProc: function (dir, command, args, next) {
          expect(dir).to.equal(cwd)
          expect(command).to.equal(wrapped.cmd)
          expect(args).to.eql(wrapped.args)
          next(0)
        }
      }, callback)
    })

    it('should call a function transparently', function (done) {
      var ctx = {}
        , next = function () {}
      utils.getHookFn(function (context, cb) {
        expect(context).to.equal(ctx)
        expect(cb).to.equal(next)
        done()
      })(ctx, next)
    })

    it('should return false if an illegal hook (not a string or function) is passed', function () {
      expect(utils.getHookFn({})).to.be.false
    })
  })

  // TODO: add tests about tasks. What are they for?
  describe('.makeHook', function () {

    it('should return false if a bad hook is given', function () {
      expect(utils.makeHook(null, {'test': {}}, 'test')).to.be.false
    })

    describe('when given a normal hook', function () {
      var test = function (context, next) {
        if (context.fail) return next(1)
        next(0)
      }
      it('should pass correctly', function (done) {
        var hook = utils.makeHook({fail: false}, {'test': test}, 'test')
        expect(hook).to.be.a.function
        hook(function (err, data) {
          expect(err).to.not.be.ok
          expect(data.phase).to.equal('test')
          expect(data.code).to.equal(0)
          done()
        })
      })
      it('should fail correctly', function (done) {
        var hook = utils.makeHook({fail: true}, {'test': test}, 'test')
        expect(hook).to.be.a.function
        hook(function (err, data) {
          expect(err).to.be.ok
          expect(err.phase).to.equal('test')
          expect(err.code).to.equal(1)
          done()
        })
      })
      it('should pass a failing cleanup', function (done) {
        var hook = utils.makeHook({fail: true}, {'cleanup': test}, 'cleanup')
        expect(hook).to.be.a.function
        hook(function (err, data) {
          expect(err).to.not.be.ok
          expect(data.phase).to.equal('cleanup')
          expect(data.code).to.equal(1)
          done()
        })
      })
    })
  })
})
