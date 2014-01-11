# overwatch

A deterministic couchdb replication watcher.

Overwatch is an `EventEmitter` that emits events reflecting various states of
the couches it watches. It has a fairly simple api that allows you to easily
watch and monitor `bi-directional` replication.

## Design

The design here is based around a [hub-and-spoke] concept of replication. This
means that we take one `hub` couch and allow `n` number of `spoke`s that all
replicate through the `hub` couch. This prevents redundant replication and makes
the replication model much simpler.

## Concepts

### Followers

In `overwatch`, `followers` are the data structure of [`follow`][follow] feeds that are used
to monitor the changes feeds of each couchdb that you would like. The various
databases are correctly associated with the feeds for all of the couches being
monitored. This allows us to set proper [`fulfillments`](#fulfillments).

### Buffering

The follow feeds have two states, `bufferChange` and `processChange`. The
`bufferChange` state allows us to buffer all of the past changes from CouchDB to
be re-emitted when we want to process them. The timing for processing is key here as
we do not want to begin processing until *ALL* couches at a particular database
our caught up on their changes. When this occurs, we perform a full audit of the
couches for that database and begin setting fulfillments.

### Fulfillments

`overwatch` has this concept of `fulfillments` which is a timer that is set
for each time we receive a new `change` event from [`follow`][follow]. Since we are
listening on multiple couch `_changes` feeds to ensure replication is occurring,
we need a way to determinsitically evaluate that this occured. If two CouchDBs
are assumed to be replicating their `foo` databases, if we receive a change on
one and not the other (with some extra checking involved),
CouchDB has failed to fulfill its promise to us. This is
where we emit the `unfulfilled` event for you to take action on this!

## Example

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
  // probably an unresponsive couch and we have bigger problems.
  // This is tweaked through setting the `inactivity_ms` in the follow options object.
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
watcher.on('processChange', function (change) {
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
      error = unfulfilled.error,
      db    = unfulfilled.db;

  console.error(error);
  console.log('We failed to replicate from '
    + source + ' to ' + target + ' for database ' + db);
  console.log('We should probably take some action');
});

//
// Emits when we are listening on live changes for a particular couch and
// database. It is a proxy of `follow`s catchup event and is just a signal of
// progress in the initialization. We may still be buffering events if this is
// not the last database to catchup
//
watcher.on('catchUp', function(feed) {
  console.log('Feed for ' + feed.db ' on couch url' + feed.couch
    + ' is caught up with sequence id ' + feed.seqId);
});

```

[hub-and-spoke]: https://en.wikipedia.org/wiki/Hub_and_spoke
[follow]: https://github.com/iriscouch/follow
