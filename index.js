/*
 * index.js :: Main include for module
 *
 * (C) Jarrett Cruger MIT License
 *
 */

var follow = require('follow'),
    util = require('util'),
    events = require('events'),
    hyperquest = require('hyperquest'),
    concat = require('concat-stream');

var extend = util._extend;

var Overwatch = module.exports = function (options) {
  if (!(this instanceof Overwatch)) { return new Overwatch(options) }
  events.EventEmitter.call(this);

  if (!options || !options.couches) {
    throw new Error('Couches is a required field!')
  }

  if (!Array.isArray(options.couches)) {
    throw new Error('You must provide an array of couch objects!');
  }
  //
  // Remark: Dirty configuration setup to support the couch options
  //
  var hubs = 0;
  this.couches = options.couches
    .reduce(function (acc, couch, idx) {
      if (couch.hub) {
        hubs++;
        this.hub = couch.url;
      }

      //
      // We only set push/pull on non `hub`
      // We also allow false to override the default true value
      // as we assume bi-directional replication by default
      // TODO: support these options
      //
      acc[couch.url] = couch.hub
        ? { hub: couch.hub }
        : {
          push: couch.push === false ? false : true,
          pull: couch.pull === false ? false : true
        };
      return acc;
    }.bind(this), {}
  );

  if (!hubs) {
    throw new Error('There must be one hub couch');
  }

  if (hubs > 1) {
    throw new Error('There can be ONLY ONE hub!');
  }

  this.timeout = options.timeout || 5 * 1000;
  //
  // Remark: Function for filtering out custom databases
  //
  this.filter = typeof options.filter === 'function'
    ? options.filter
    : function () { return true }
  this.follow = options.follow || {};
  this.buffers = {};
  this.fulfillments = {};

};

util.inherits(Overwatch, events.EventEmitter);

//
// ### function watch
// Begin watching the couches!
//
Overwatch.prototype.watch = function () {
  this.fetchDbs(this.setup.bind(this));
};

Overwatch.prototype.fetchDbs = function (callback) {
  var self = this;

  hyperquest(this.hub + '/all_dbs')
    .pipe(concat(function (dbs) {
      try { dbs = JSON.parse(dbs) }
      catch (ex) { self.emit('error', new Error('Hub DB unreachable')) }

      self.dbs = dbs.filter(self.filter);
      //
      // TODO: Start replication on spoke DBs based on the hub dbs if they do
      // not exist
      //
      callback();
    })
  );
};

Overwatch.prototype.setup = function () {
  this.followers = this.dbs.reduce(function (acc, db) {
    var feeds = Object.keys(this.couches).reduce(function(assoc, url) {
      var opts = extend({ db: url }, this.follow),
          feed = assoc[url] = new feed.follow(opts);

      this.buffers[db] = this.buffers[db] || {};
      this.buffers[db][url] = [];

      this.fulfillments[db] = this.fulfillments[db] || {};
      this.fulfillments[db][url] = {};

      feed.on('catchup', this.onCatchUp.bind(this, db, url));
      //
      // TODO: Figure out how to not ALWAYS buffer changes if we want to
      // just start auditing from the live state
      //
      feed.on('change', this.bufferChange.bind(this, db, url));
      feed.on('error', this.onFeedError.bind(this));

      feed.follow();

      return assoc;
    }.bind(this), {});

    acc[db] = feeds;
    return acc;
  }.bind(this), {});
};

Overwatch.prototype.onCaughtUp = function (db, couch, seqId) {
  var self = this;

  this.emit('caughtUp', { db: db, couch: couch, seqId: seqId });

  var allCaughtUp =
    Object.keys(this.followers[db])
      .filter(function (feedKey) {
        return feedKey !== couch;
      }).every(function (key) {
        return this.followers[db][key].caught_up;
  }, this);

  //
  // Remark: Once all of the couches are caught up, switch the feeds to process
  // the changes and emit all the previously buffered changes for the full
  // audit
  //
  if (allCaughtUp) {
    this.switchFeedState(db);
    this.catchUp(db);
  }
};

Overwatch.prototype.switchFeedState = function (db) {
  var feeds = this.followers[db],
      feedKeys = Object.keys(feeds);

  for (var i=0; i<feedKeys.length; i++) {
    feeds[feedKeys[i]].removeAllListeners('change');
    feeds[feedKeys[i]].on('change', this.processChange.bind(this, db, feedKeys[i]));
  }
};

Overwatch.prototype.catchUp = function (db) {
  var feeds = this.followers[db],
      buffers = this.buffers[db],
      bufferKeys = Object.keys(buffers);

  this.emit('catchUp', db);

  for (var i=0; i<bufferKeys.length; i++) {
    emitAllTheThings(bufferKeys[i]);
  }

  this.emit('live', db);

  function emitAllTheThings (key) {
    var change;

    while (change = buggers[key].shift()) {
      feeds[key].emit('change', change);
    }
  }

};

Overwatch.prototype.bufferChange = function (db, couch, change) {
  this.buffers[db][couch].push(change);
};

Overwatch.prototype.processChange = function (db, couch, change) {
  var fulfillments = this.fulfillments[db],
  fKeys = Object.keys(fulfillments),
  timeout = this.timeout,
  //
  // This should always be valid
  //
  rev = change.changes && change.changes[0].rev,
  id = change.id + '@' + rev;

  this.emit('processChange', { db: db, couch: couch, rev: rev, id: change.id });
  //
  // Check for fulfillments for this change,
  // if there are no fulfillments, set a fulfillment on the other couches
  //
  if (!fulfillments[couch][id]) {
    return fKeys.filter(function (couchUrl) {
      return couchUrl !== couch;
    })
    .forEach(function (key) {
      fulfillments[key][id] =
        setTimeout(this.unFulfilled.bind(this, db, key, couch, id, change.seq), timeout);
    }, this);
  }

  //
  // Remark: Ok so if we have a fulfillment for ourselves, replication
  // succeeded and couch is behaving properly
  //
  clearTimeout(fulfillments[couch][id]);
  this.fulfillments[db][couch][id] = null;
};

Overwatch.prototype.unFulfilled = function (db, couch, source, id, seq) {
  var self = this;
      pieces = id.split('@'),
      nId = pieces[0],
      rev = pieces[1],
      url = [couch, db, nId].join('/')
        + '?revs_info=true&conflicts=true&deleted_conflicts=true',
      error;

  //
  // Remark: Query the doc with revs_info and conflicts and
  // assess the false positive because sometimes ALL the revisions
  //
  hyperquest(url)
    .on('error', onError)
    .pipe(concat(function (doc) {
      try { doc = JSON.parse(doc) }
      catch(ex) { return onError(ex) }
      if (!doc || !doc._revs_info) {
        error = new Error('No document at : ' + url);
        return onError(error);
      }
      //
      // Check and see if the revision exists somewhere in the tree, if not
      // this is actually REALLY BAD and replication is probably down.
      // We check revs in the current tree, any possible conflicts and deleted
      // conflicts if it was resolved.
      //
      var fulfilled =
        doc._revs_info.some(function(info) {
          return info.rev === rev;
        })
        || doc._conflicts && doc._conflicts.some(function (_rev) {
          return _rev === rev;
        })
        || doc._deleted_conflicts && doc._deleted_conflicts.some(function (_rev) {
          return _rev === rev;
        })

      return !fulfilled
        ? onError(new Error('Failed to replicate in a timely manner'));
        : falsePositive()
    })
  );

  function onError(err) {
    this.emit('unfulfilled', { error: err, db: db, target: couch, source: source});
  }.bind(this);

  function falsePositive () {

    //
    // Remark: not sure what I should emit here to keep the events
    // un-namespaced
    //
  }.bind(this);

};
