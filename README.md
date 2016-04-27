## strider-simple-runner

![Worker Picture](http://farm6.staticflickr.com/5187/5883651745_c17fb322df.jpg)

Easy-to-configure in-process runner implementation for Strider Continous
Deployment. This runner comes bundled with Strider.

[![Build Status](https://travis-ci.org/Strider-CD/strider-simple-runner.svg?branch=master)](https://travis-ci.org/Strider-CD/strider-simple-runner)

## Spec

`require('strider-simple-runner').create(emitter, config, done)`

### Config

All options are optional.

```
pty(false):              use 'pty' for running commands. Currently disabled
logger(console):         .log, .warn, .error
io(new EventEmitter):    the channel of internal communication with the job worker
processJob(core.process):function to run a job. (task, config, ondone)
pluginDirs:              the directories in which to look for plugins
dataDir($HOME/.strider): the directory in which to clone/test/etc
concurrentJobs(1):       maximum number of jobs to execute at once
```

### Events

#### Expected to consume

- 'job.new'

```
{
  id: Oid,
  type: 'TEST_ONLY' | 'TEST_AND_DEPLOY',
  user_id: Oid,
  trigger: {
  },
  ref: {
    branch: String,
    id: String // commit id
  },
  // this stuff is not part of the "job" document in mongo, but is added
  project: {
    // project config straight from db, includes plugin config and
    // project level provider config
  },
  userProvider: { // user-level config for the provider. Things like a github
  }               // OAuth token. Retrieved from user.providers.[providerid]
}
```

Ex: github provider config
```js
{
  id: 'github',
  user: {
    token: '1234',
    username: 'hacker'
  },
  project: {
    url: 'example.com/repo.git',
    display_url: 'http://example.com/repo',
    auth: {
      method: 'https',
      username: null, // use user's gh auth
      password: null // use user's gh token
    }
  }
}
```

Ex: git provider config
```js
{
  id: 'git',
  user: {},
  project: {
    url: 'example.com/repo.git',
    method: 'ssh',
    privkey: null, // use repo-level ssh keys
    pubkey: null
  }
}
```

Project config looks like:

```js
{
  name: 'owner/name',
  public: false,
  active: true,
  deploy_on_green: true,
  secret: // what's this for?
  runner: {
    id: 'simple', // or docker, etc.
    pty: false
    // other config for the runner
  },
  privkey: '',
  pubkey: '',
  provider: {}, // provider config
  // owner is implicit, as it's embedded ...
  collaborators: [],
  plugins: [{
    id: 'heroku',
    // plugin config
  }, ...]
}
```

Plugins needed:

- heroku
- webhooks

Providers:

- git
- github

Tests
=====

Strider-simple-runner comes with tests. To run, simply execute `npm test`.

License
=======

Strider-simple-runner is released under a BSD license.

Credits
=======

Picture of worker ant CC-BY myprofe from http://www.flickr.com/photos/myprofe/5883651745/sizes/m/in/photostream/
