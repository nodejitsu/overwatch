/*
 * index.js :: Main include for module
 *
 * (C) Jarrett Cruger MIT License
 *
 */

var follow = require('follow'),
    util = require('util'),
    events = require('events'),
    request = require('request').defaults({ strictSSL: false, maxSockets: 1000 });

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
        : { pullOnly: couch.pullOnly || false };
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
  this.buffers = {};
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

  request({
    method: 'GET',
    uri: this.hub + '/_all_dbs',
    json: true
  }, function (err, res, dbs) {
    if (err || res.statusCode != 200) {
      return callback(err || new Error('_all_dbs responded with ' + res.statusCode));
    }
      self.dbs = dbs.filter(self.filter);
      //
      // TODO: Start replication on spoke DBs based on the hub dbs if they do
      // not exist. We'll also need to do some trickery to postpone audit
      //
      callback();
  });
};

//
// ### function setup()
// Setup all of the data structures
//
Overwatch.prototype.setup = function () {

  this.followers = this.dbs.reduce(function (acc, db) {
    var feeds = Object.keys(this.couches).reduce(function(assoc, url) {

      var opts = extend({ db: [url, db].join('/') }, this.follow),
          feed = assoc[url] = new follow.Feed(opts);

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
      feed.on('error', this.emit.bind(this, 'error'));

      feed.follow();

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
// #### @seqId {Number} Seqeunce ID of the couch database
// Called on follow's catchup event and checks the associated couches to see if
// they have also caught up already. If this is the case, we switch the feed
// state and begin auditing and watching the couches!
//
Overwatch.prototype.onCatchUp = function (db, couch, seqId) {
  var self = this;
  //
  // A proxy of follow's catchup event
  //
  this.emit('catchUp', { db: db, couch: couch, seq: seqId });

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
    this.audit(db);
  }
};

//
// ### function switchFeedState(db)
// #### @db {String} Database that we are switching the feeds for
// Switch the state of the feed from buffering to processing so that we can
// then perform a full Audit and begin processing live changes
//
Overwatch.prototype.switchFeedState = function (db) {
  var feeds = this.followers[db],
      feedKeys = Object.keys(feeds);

  for (var i=0; i<feedKeys.length; i++) {
    feeds[feedKeys[i]].removeAllListeners('change');
    feeds[feedKeys[i]].on('change', this.processChange.bind(this, db, feedKeys[i]));
  }
};

//
// ### function audit(db)
// #### @db {String} database we are auditing for all the couches
// Emit all of the buffered changes on the various feeds for this database
// in order to perform a full audit
//
Overwatch.prototype.audit = function (db) {
  var feeds = this.followers[db],
      buffers = this.buffers[db],
      bufferKeys = Object.keys(buffers);

  this.emit('audit', db);

  for (var i=0; i<bufferKeys.length; i++) {
    emitAllTheThings(bufferKeys[i]);
  }

  this.emit('live', db);

  function emitAllTheThings (key) {
    var change;

    while (change = buffers[key].shift()) {
      feeds[key].emit('change', change);
    }
  }

};

//
// ### function bufferChange (db, couch, change)
// #### @db {String} Name of database we are buffering for
// #### @couch {String} URL of the couch we are monitoring
// #### @change {Change} Follow change object to push onto the array
// Buffer each change object onto the appropriate buffer
//
Overwatch.prototype.bufferChange = function (db, couch, change) {
  this.buffers[db][couch].push(change);
};

//
// ### function processChange (db, couch, change)
// #### @db {String} Name of database we are processing
// #### @couch {String} Couch URL that we are processing
// #### @change {Change} Follow change object to get information from
// Process the change from the follow feed that either sets up a fulfillment
// or fulfill a previous fulfillment
//
Overwatch.prototype.processChange = function (db, couch, change) {
  var fulfillments = this.fulfillments[db],
      fKeys = Object.keys(fulfillments),
      timeout = this.timeout,
      //
      // This should always be valid
      //
      rev = change.changes && change.changes[0].rev,
      id = change.id + '@' + rev,
      seq = change.seq;

  this.emit('processChange', { db: db, couch: couch, rev: rev, id: change.id, seq: seq });
  //
  // Check for fulfillments for this change,
  // if there are no fulfillments, set a fulfillment on the other couches
  //
  if (!fulfillments[couch][id]) {
    this.emit('setFulfillment', { db: db, couch: couch, rev: rev, id: change.id });
    //
    // Remark: Ok so by default we ALWAYS filter out the couch where the change
    // was just received and when the couch that received the change is set to
    // have pullOnly = true, we set no fulfillments on other couches since we
    // just accept changes, we do not delegate
    //
    return fKeys.filter(function (couchUrl) {
      return couchUrl !== couch && !this.couches[couch].pullOnly;
    }, this)
    .forEach(function (key) {
      fulfillments[key][id] =
        setTimeout(this.unfulfilled.bind(this, db, key, couch, id, seq), timeout);
    }, this);
  }

  //
  // Remark: Ok so if we have a fulfillment for ourselves, replication
  // succeeded and couch is behaving properly
  //
  this.emit('fulfilled', { db: db, couch: couch, rev: rev, id: change.id})
  clearTimeout(fulfillments[couch][id]);
  this.fulfillments[db][couch][id] = null;
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
  var self = this,
      pieces = id.split('@'),
      nId = pieces[0],
      rev = pieces[1],
      url = [couch, db, nId].join('/')
        + '?revs_info=true&conflicts=true&deleted_conflicts=true';

  //
  // Remark: Query the doc with revs_info and conflicts and
  // assess the false positive because sometimes ALL the revisions
  //
  request({
    method: 'GET',
    uri: url,
    json: true
  }, function (err, res, doc) {
    if (err || (res.statusCode != 200 && res.statusCode != 404)) {
      return onUnfulfilled(err || new Error('Failed with code ' + res.statusCode + ' on request'));
    }
    if (!doc) {
      return onUnfulfilled(new Error('No document found at ' + url));
    }
    //
    // Remark: If document has been deleted, then it was totally a valid
    // change so don't emit unfulfilled
    //
    if (doc.error === 'not_found'
          && doc.reason === 'deleted') {
      return onFulfilled('Document has been deleted');
    }
    //
    // Explicitly see if we are missing the package
    //
    if (doc.error === 'not_found'
          && doc.reason === 'missing') {
      return onUnfulfilled(new Error(nId + ' package failed to replicate'))
    }
    //
    // Remark: we need to be able to check things
    //
    if (!doc._revs_info || !doc._revs_info.length) {
      return onUnfulfilled(new Error('No revs_info, cannot check history at ' + url));
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
      ? onUnfulfilled(new Error('Failed to replicate in a timely manner or in conflicted state on hub'))
      : onFulfilled();
  });

  function onUnfulfilled(err) {
    //
    // Remark: distill the hub couch as that will be needed if we want to do
    // anything about replication
    //
    self.emit('unfulfilled', { error: err, db: db, target: couch, source: source, id: id});
  }

  function onFulfilled (reason) {
    self.emit('fulfilled', { db: db, couch: couch, rev: rev, id: nId, reason: reason });
  }

};

