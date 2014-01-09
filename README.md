# overwatch

A deterministic couchdb replication watcher.

Overwatch is an `EventEmitter` that emits events reflecting various states of
the couches it watches. It has a fairly simple api that allows you to easily
setup and watch `bi-directional` replication.

## Design

The design here is based around a [hub-and-spoke] concept of replication. This
means that we take one `hub` couch and allow `n` number of `spoke`s that all
replicate through the `hub` couch. This prevents redundant replication and makes
the replication model much simpler.

While this does introduce a single-point-of-failure, `overwatch` will detect the
one case that this matters (with a proper `inactivity_ms` option on [`follow`])
and this can be managed. Remember, we are just using regular CouchDB, no
bigcouch yet ;).

## Concepts

### Followers

### Buffering

### Fulfillments

`overwatch` has this concept of fulfillments which it uses

```js

var overwatch = require('overwatch');

var watcher = overwatch({
  //
  // each couch has a `pull` and `push` property set to true by default
  // signaling the type of replication if it is not the hub.
  // Also, the set of dbs for replication will be pulled from the `hub` couch
  //
  couches: [
    { url: 'http://username:password@myDB.iriscouch.com', hub: true },
    { url: 'http://localhost:5984' }
  ],
  //
  // Fulfillment timeout.
  //
  timeout: 5000,
  //
  // Database filter function if you want to ignore replication for a particular databases
  //
  filter: function (db) { return !/somethingIDontCareAbout/.test(db) },

  //
  // `follow` options for the underlying `follow` instances
  //
  follow: {
    inactivity_ms: 1800000
  }
});

//
// Listen on some events with your own functions
//
watcher.on('error', function (err) {
  //
  // Remark: this error is probably from `follow` and we should crash as its
  // probably an unresponsive couch
  //
  console.error(err);
  process.exit(1);
});

//
// We are now listening on live changes for all feeds for this database
//
watcher.on('live', function (db) {
  console.log('Watching on live changes for ' + db);
});

//
// Log some events when we process each change for each couch and database
//
watcher.on('process:change', function (change) {
  console.log('processing change');
  console.log('couch url ' + change.couch)
  console.log('database ' + change.db);
  console.log('revision ' + change.rev);
  console.log('doc id ' + change.id)
});

//
// Oh gosh couch failed to fulfill its promise to replicate :'(.
// Bad couchdb
//
watcher.on('unfulfilled', function (unfulfilled) {
  var source = unfulfilled.source,
      target = unfulfilled.target,
      error = unfulfilled.err,
      db    = unfulfilled.db;

  console.error(error);
  console.log('We failed to replicate from '
    + source + ' to ' + target + ' for database ' + db);
  console.log('We should probably take some action');
});

//
// Emits when we are listening on live changes for a particular couch and
// database. We will keep buffering changes until all of the other couches
// at this database are caught up
//
watcher.on('caught:up', function(feed) {
  console.log('Feed for ' + feed.db ' on couch url' + feed.couch
    + ' is caught up with sequence id ' + feed.seqId);
});


```

[hub-and-spoke]: https://en.wikipedia.org/wiki/Hub_and_spoke
[follow]: https://github.com/iriscouch/follow
