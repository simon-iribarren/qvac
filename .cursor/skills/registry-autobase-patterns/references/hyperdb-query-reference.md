# HyperDB Query Reference

HyperDB is a P2P-first database used by the QVAC registry. This document covers query patterns and best practices.

## Query API

### Basic Query

```javascript
const stream = db.find(collectionOrIndex, query, options)
const results = await stream.toArray()
```

### Query Format

Queries use range operators on the index key fields:

```javascript
{
  gt: { field: value },   // greater than
  gte: { field: value },  // greater than or equal
  lt: { field: value },   // less than
  lte: { field: value }   // less than or equal
}
```

### Options

```javascript
{
  limit: 10,        // max results
  reverse: false    // reverse order
}
```

## Index Design

### Single-Field Index

```javascript
db.indexes.register({
  name: 'models-by-engine',
  collection: '@ns/model',
  key: ['engine']
})
```

Query:
```javascript
db.find('@ns/models-by-engine', {
  gte: { engine: 'llama.cpp' },
  lte: { engine: 'llama.cpp' }
})
```

### Compound Index (Multiple Fields)

HyperDB natively supports compound indexes with multiple key fields. This is confirmed in the official builder example (`builder/example/example.js`):

```javascript
// Registration
db.indexes.register({
  name: 'collection1-by-struct',
  collection: '@example/collection1',
  key: ['name', 'age']  // Compound key - order matters!
})

// Query both fields
db.find('@example/collection1-by-struct', {
  gte: { name: 'alice', age: 20 },
  lte: { name: 'alice', age: 99 }
})

// Query leftmost field only (prefix matching)
db.find('@example/collection1-by-struct', {
  gte: { name: 'alice' },
  lte: { name: 'alice' }
})
```

**Key rules** (same as B-tree compound key ordering):
- You CAN query by leftmost prefix: `name` alone works
- You CAN query by full compound: `name + age` works
- You CANNOT skip leftmost fields: `age` alone does NOT work
- Fields are matched in declaration order

### Mapped Index (Computed Keys)

For complex key derivation, use a map function:

```javascript
// helpers.js
exports.mapModelSearchKey = (record) => {
  return [{
    engine: record.engine,
    quantization: record.quantization || ''
  }]
}

// builder
db.require('./helpers.js')
db.indexes.register({
  name: 'models-search',
  collection: '@ns/model',
  key: {
    type: {
      fields: [
        { name: 'engine', type: 'string' },
        { name: 'quantization', type: 'string' }
      ]
    },
    map: 'mapModelSearchKey'
  }
})
```

## Query Patterns

### Exact Match

```javascript
db.find(index, {
  gte: { field: value },
  lte: { field: value }
})
```

### Prefix Match (Strings)

```javascript
db.find(index, {
  gte: { name: 'llama' },
  lte: { name: 'llama\uffff' }  // \uffff = highest Unicode char
})
```

### Range Query

```javascript
db.find(index, {
  gte: { age: 18 },
  lt: { age: 65 }
})
```

### Get All

```javascript
db.find(collection, {})  // empty query = all records
```

## Limitations

1. **No cross-index queries**: Each `find()` queries ONE index. To filter by multiple fields, you need either:
   - A compound index covering those fields (preferred)
   - Query one index + filter in memory (fallback)
   - Scan full collection + filter in memory (simplest for small datasets)

2. **Compound index field order**: Must query leftmost fields first. Index `['a', 'b', 'c']` supports:
   - Query by `a`
   - Query by `a, b`
   - Query by `a, b, c`
   - NOT: Query by `b` alone or `c` alone

3. **No OR queries**: Use multiple queries and merge results

4. **No ad-hoc multi-field queries**: There is no `WHERE engine = X AND quantization = Y` syntax. Multi-field queries require a compound index defined at schema build time.

## QVAC Registry Indexes

Current indexes in `@qvac-main-registry`:

| Index | Key | Use Case |
|-------|-----|----------|
| `model` (collection) | `[path, source]` | Get specific model |
| `models-by-engine` | `[engine]` | Filter by engine |
| `models-by-name` | `mapPathToName` | Filter by name |
| `models-by-quantization` | `[quantization]` | Filter by quantization |

### Potential Improvements

To support efficient multi-field queries, add compound indexes in `build-db-spec.js`:

```javascript
// Engine + Quantization (common query pattern)
registryDB.indexes.register({
  name: 'models-by-engine-quantization',
  collection: `@${QVAC_MAIN_REGISTRY}/model`,
  unique: false,
  key: ['engine', 'quantization']
})
```

After adding, rebuild the spec with `npm run build:spec` in `qvac-lib-registry-server`.

**Note**: At ~189 models, collection scan + in-memory filter is equally fast. Compound indexes become valuable at thousands of records.

## Best Practices

1. **Design indexes for query patterns**: Create indexes that match your common queries
2. **Use compound indexes sparingly**: Each index adds storage and write overhead
3. **Query the most selective field first**: Reduces in-memory filtering
4. **Use `limit` when possible**: Avoid loading all results if you only need a few
