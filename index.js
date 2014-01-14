/*
 * index.js :: Main include for module
 *
 * (C) Jarrett Cruger MIT License
 *
 */

var follow = require('follow-stream'),
    util = require('util'),
    events = require('events'),
    hyperquest = require('hyperquest'),
    concat = require('concat-stream');

var extend = util._extend;

//
// ### function Overwatch (options)
// #### @options {Object} Options that we accept
// ##### @couches {Array} An array of couch objects to watch
// ##### @timeout {ms} Milliseconds that we want for a fulfillment timeout
// #####
//
var Overwatch = module.exports = function (options) {
  if (!(this instanceof Overwatch)) { return new Overwatch(options) }
  events.EventEmitter.call(this);

  if (!options || !options.couches) {
    throw new Error('Couches is a required field!')
  }

  if (!Array.isArray(options.couches)) {
    throw new Error('You must provide an array of couch objects!');
  }

  if (options.dbs && !Array.isArray(options.dbs)){
    throw new Error('If you pass in dbs, it must be an array');
  }
  //
  // Remark: Dirty configuration setup to support the couch options
  //
  var hubs = 0;
  this.couches = options.couches
    .reduce(function (acc, couch) {
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

  this.dbs = options.dbs || null;

  this.follow = options.follow || {};
  this.fulfillments = {};
};

//
// We are EventEmitter!
//
util.inherits(Overwatch, events.EventEmitter);

//
// ### function watch()
// Begin watching the couches!
//
Overwatch.prototype.watch = function () {
  return !this.dbs
  ? this.fetchDbs(this.setup.bind(this))
  : this.setup();

};

//
// ### function fetchDbs(callback)
// #### @callback {function} Continuation to call upon fetch
// Optionally fetch the databases from the Hub CouchDB if no databases were
// passed in
//
Overwatch.prototype.fetchDbs = function (callback) {
  var self = this;

  hyperquest(this.hub + '/_all_dbs')
    .pipe(concat(function (dbs) {
      try { dbs = JSON.parse(dbs) }
      catch (ex) { self.emit('error', new Error('Hub DB unreachable')) }
      self.dbs = dbs.filter(self.filter);
      //
      // TODO: Start replication on spoke DBs based on the hub dbs if they do
      // not exist. We'll also need to do some trickery to postpone audit
      //
      callback();
    })
  );
};

//
// ### function setup()
// Setup all of the data structures
//
Overwatch.prototype.setup = function () {

  this.followers = this.dbs.reduce(function (acc, db) {
    var feeds = Object.keys(this.couches).reduce(function(assoc, url) {

      var opts = extend({ db: [url, db].join('/'), highWaterMark: Infinity }, this.follow),
          feed = assoc[url] = follow(opts);

      this.fulfillments[db] = this.fulfillments[db] || {};
      this.fulfillments[db][url] = {};

      feed.on('catchup', this.onCatchUp.bind(this, db, url));
      //
      // TODO: Figure out how to not ALWAYS buffer changes if we want to
      // just start auditing from the live state
      //
      feed.on('error', this.emit.bind(this, 'error'));

      return assoc;
    }.bind(this), {});

    acc[db] = feeds;
    return acc;
  }.bind(this), {});
};

//
// ### function onCatchUp (db, couch, seqId)
// #### @db {String} Database that just caught up to live
// #### @couch {String} couch URL that just caught up to live
// #### @seqId {Number} Seqeunce ID of the couch
// Called on follow's catchup event and checks the associated couches to see if
// they have also caught up already. If this is the case, we switch the feed
// state and begin auditing and watching the couches!
//
Overwatch.prototype.onCatchUp = function (db, couch, seqId) {
  var self = this;
  //
  // A proxy of follow's catchup event
  //
  this.emit('catchUp', { db: db, couch: couch, seqId: seqId });
  //
  // This is purely to emit the `live` event if we really even care
  //
  this._seqs[db][couch] = seqId;

  var allCaughtUp =
    Object.keys(this.followers[db])
      .filter(function (feedKey) {
        return feedKey !== couch;
      }).every(function (key) {
        return this.followers[db][key].feed.caught_up;
  }, this);

  //
  // Remark: Once all of the couches are caught up, switch the feeds to process
  // the changes and emit all the previously buffered changes for the full
  // audit
  //
  if (allCaughtUp) {
    this.enableProcessing(db);
  }
};

//
// ### function enableProcessing(db)
// #### @db {String} Database that we are enabling the process
// Sets up the various listeners for the feeds
//
Overwatch.prototype.enableProcessing = function (db) {
  var feeds = this.followers[db],
      feedKeys = Object.keys(feeds);

  for (var i=0; i<feedKeys.length; i++) {
    feeds[feedKeys[i]].on('readable', this.processChange.bind(this, db, feedKeys[i]));
  }

  this.emit('audit', db);
};

//
// ### function processChange (db, couch, change)
// #### @db {String} Name of database we are processing
// #### @couch {String} Couch URL that we are processing
// #### @change {Change} Follow change object to get information from
// Process the change from the follow feed that either sets up a fulfillment
// or fulfill a previous fulfillment
//
Overwatch.prototype.processChange = function (db, couch) {
  var stream = this.followers[db][couch],
      fulfillments = this.fulfillments[db],
      fKeys = Object.keys(fulfillments),
      timeout = this.timeout,
      change;

  //
  // Remark: this will run `n` number of times while there is data buffered
  // but will eventually only run when we are readable and this function is
  // called.
  //
  while (change = stream.read()) {

    //
    // This should always be valid
    //
    var rev = change.changes && change.changes[0].rev,
        id = change.id + '@' + rev;

    this.emit('processChange', { db: db, couch: couch, rev: rev, id: change.id });
    //
    // Check for fulfillments for this change,
    // if there are no fulfillments, set a fulfillment on the other couches
    //
    if (!fulfillments[couch][id]) {
      this.emit('setFulfillment', { db: db, couch: couch, rev: rev, id: change.id });
      return fKeys.filter(function (couchUrl) {
        return couchUrl !== couch;
      })
      .forEach(function (key) {
        fulfillments[key][id] =
          setTimeout(this.unfulfilled.bind(this, db, key, couch, id, change.seq), timeout);
      }, this);
    }

    //
    // Remark: Ok so if we have a fulfillment for ourselves, replication
    // succeeded and couch is behaving properly
    //
    this.emit('fulfilled', { db: db, couch: couch, rev: rev, id: change.id})
    clearTimeout(fulfillments[couch][id]);
    this.fulfillments[db][couch][id] = null;
  }
};

//
// ### function unfulfilled(db, couch, source, id, seq)
// #### @db {String} Database string
// #### @couch {String} CouchDB URL that didn't receive the exact change
// #### @source {String} CouchDB URL that received change
// #### @id {Sring} ID of document
// #### @seq {String} sequenceId
// This is where we assess if the failure to receive a change was valid or not
// and emit `unfulfilled` if that happens to be the case
//
Overwatch.prototype.unfulfilled = function (db, couch, source, id, seq) {
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
    .on('error', onUnfulfilled)
    .pipe(concat(function (doc) {
      try { doc = JSON.parse(doc) }
      catch(ex) { return onUnfulfilled(ex) }
      if (!doc || !doc._revs_info) {
        error = new Error('No document at : ' + url);
        return onUnfulfilled(error);
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
        ? onUnfulfilled(new Error('Failed to replicate in a timely manner'))
        : onFulfilled();
    })
  );

  function onUnfulfilled(err) {
    //
    // Remark: distill the hub couch as that will be needed if we want to do
    // anything about replication
    //
    self.emit('unfulfilled', { error: err, db: db, target: couch, source: source, id: id});
  }

  function onFulfilled () {
    self.emit('fulfilled', { db: db, couch: couch, rev: rev, id: nId });
  }

};

