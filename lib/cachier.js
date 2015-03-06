'use strict';

var path = require('path');
var fs = require('fs-extra');
  
module.exports = cachier;

function cachier(base) {
  function child(sub) {
    return cachier(path.join(base, sub));
  }
  
  child.get = function (key, dest, done) {
    if (arguments.length === 2) {
      done = dest;
      dest = key;
      key = '';
    }
    
    copy(path.join(base, key), dest, done);
  };
  
  child.update = function (key, dest, done) {
    if (arguments.length === 2) {
      done = dest;
      dest = key;
      key = '';
    }
    
    copy(dest, path.join(base, key), done);
  }
  
  child.base = base;
  
  return child;
}

function copy(from, to, done) {
  fs.exists(from, function (exists) {
    if (!exists) {
      return done(new Error('Source does not exist: ' + from));
    }
    
    fs.remove(to, function () {
      fs.mkdirp(path.dirname(to), function () {
        fs.copy(from, to, function (err) {
          return done(err && new Error('Failed to retrieve cached code: ' + err));
        });
      });
    });
  });
}
