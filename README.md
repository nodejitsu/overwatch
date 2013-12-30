## overwatch

### API

Overwatch is an `EventEmitter` (but might also have a `follow`-like api if
i feel like it) that takes a hefty bit of options (but you will see why in
a minute).

```js

var overwatch = require('overwatch');

var watcher = overwatch({
  // each couch has a `pull` and `push` property set to true by default
  // signaling the type of replication if it is not the hub.
  // Also, the set of dbs for replication will be pulled from the `hub` couch
  couches: [
    { url: 'http://username:password@couchOne', hub: true },
    { url: 'http://localhost:5984' push: false }
  ],
  // Database filter function if you want to ignore replication for a particular database
  filter: function (db) { return !/somethingIDontCareAbout/.test(db) },
  timeout: 5000, // Fulfillment timeout, this will be explained later
  follow: {}, // `follow` options for the underlying `follow` instances
  // defaults to true and signifies if we should prebuffer the database to do a full audit
  // or just start from the live changes
  buffer: true
})
```
