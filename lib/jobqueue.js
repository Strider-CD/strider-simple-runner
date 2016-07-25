'use strict';

var branchFromJob = require('./utils').branchFromJob;

module.exports = JobQueue;

function JobQueue(handler, concurrency) {
  this.concurrency = concurrency;
  this.handler = handler;
  this.tasks = [];

  this.active = {};

  this.drainCallback = null;
}

JobQueue.prototype = {
  // public api

  // Add a job to the end of the queue. If the queue is not currently saturated, immediately
  // schedule a task to handle the new job. If a callback is provided, call it when this job's task
  // completes.
  push: function (job, config, callback) {
    var task = {
      job: job,
      config: config,
      callback: callback || function () {
      }
    };

    task.id = task.job._id;

    // Tasks with identical keys will be prevented from being scheduled concurrently.
    task.key = task.job.project + branchFromJob(task.job);

    this.tasks.push(task);

    // Defer task execution to the next event loop tick to ensure that the push() function's
    // callback is *always* invoked asynchronously.
    // http://blog.izs.me/post/59142742143/designing-apis-for-asynchrony
    process.nextTick(this.drain.bind(this));
  },

  // Launch the asynchronous handler function for each eligible waiting task until the queue is
  // saturated.
  drain: function () {
    var self = this;

    // See how much capacity we have left to fill.
    var launchCount = this.concurrency - Object.keys(this.active).length;

    // Identify up to launchCount eligible tasks, giving priority to those earlier in the queue.
    var offset = 0;
    var launchTasks = [];
    while (launchTasks.length < launchCount && this.tasks.length > offset) {
      var task = this.tasks[offset];

      if (task.key in this.active) {
        // This task cannot run right now, so skip it.
        offset += 1;
      } else {
        // This task is eligible to run. Remove it from the queue and prepare it to launch.
        this.tasks.splice(offset, 1);
        launchTasks.push(task);
      }
    }

    // Create a task completion callback. Remove the task from the active set, invoke the tasks'
    // push() callback, then drain() again to see if another task is ready to run.
    function makeTaskHandler(task) {
      return function (err) {
        delete self.active[task.key];

        task.callback(err);

        // Defer the next drain() call again in case the task's callback was synchronous.
        process.nextTick(self.drain.bind(self));
      };
    }

    // Launch the queue handler for each chosen task.
    for (var i = 0; i < launchTasks.length; i++) {
      var each = launchTasks[i];

      this.active[each.key] = each;

      this.handler(each.job, each.config, makeTaskHandler(each));
    }

    // Fire and unset the drain callback if one has been registered.
    if (this.drainCallback) {
      var lastCallback = this.drainCallback;
      this.drainCallback = null;
      lastCallback();
    }
  },

  // Count the number of tasks waiting on the queue.
  length: function () {
    return this.tasks.length;
  },

  // Return true if "id" corresponds to the job ID of an active job.
  isActive: function (id) {
    for (var key in this.active) {
      if (this.active.hasOwnProperty(key) && this.active[key].id === id) {
        return true;
      }
    }
    return false;
  },

  // Fire a callback the next time that a drain() is executed.
  onNextDrain: function (callback) {
    this.drainCallback = callback;
  }
};
