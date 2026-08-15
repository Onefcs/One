'use strict';
// A mongoose stand-in that keeps everything in plain JS objects.
//
// Why this exists: the real dev launcher (dev/local.js) starts a private mongod
// through mongodb-memory-server, which downloads the binary from
// fastdl.mongodb.org on first use. Any environment without access to that host
// — a locked-down CI runner, an agent sandbox, an offline machine — cannot run
// the server at all, which means the whole codebase is only ever checked
// statically there. That is not good enough for changes to the economy.
//
// So this implements the subset of the mongoose API server/index.js actually
// uses, and nothing else. It is a TEST DOUBLE, not a database: no indexes, no
// concurrency control, no persistence, no validation beyond defaults. Its only
// contract is that the server boots against it and the flows behave the way
// they do against Mongo.
//
// Supported, because the game path uses them:
//   queries   find findOne findById countDocuments distinct aggregate(subset)
//   writes    create save updateOne updateMany findOneAndUpdate
//             findByIdAndUpdate deleteOne deleteMany
//   chaining  sort limit skip select lean collation exec + thenable
//   filters   $in $nin $ne $gt $gte $lt $lte $or $and $exists $regex $elemMatch
//   updates   $set $inc $push($each) $pull $unset  — all with dotted paths
//             plus AGGREGATION-PIPELINE updates (an array of stages), which
//             are what the daily-attempt counters are written with
//
// Dotted paths matter more than anything else here: _persistSavedFields writes
// `savedData.<field>` precisely so it never replaces the whole nested object,
// and a double that flattened those would hide the exact class of bug that
// call site exists to prevent.

const crypto = require('crypto');

// ── Object ids ──────────────────────────────────────────────────────────────
class ObjectId {
  constructor(id) { this.id = id ? String(id) : crypto.randomBytes(12).toString('hex'); }
  toString() { return this.id; }
  toHexString() { return this.id; }
  equals(other) { return String(other) === this.id; }
  get [Symbol.toStringTag]() { return 'ObjectId'; }
}
const sameId = (a, b) => a != null && b != null && String(a) === String(b);

// ── Dotted path access ──────────────────────────────────────────────────────
function getPath(obj, path) {
  return String(path).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
function setPath(obj, path, value) {
  const parts = String(path).split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    // Mongo refuses to traverse a null parent with a dotted $set, and the
    // server has a migration that exists because of exactly that (savedData
    // null on legacy accounts). Creating the parent here instead would make
    // the double more forgiving than the real thing and hide that bug.
    if (cur[k] == null || typeof cur[k] !== 'object') cur[k] = {};
    cur = cur[k];
  }
  cur[parts[parts.length - 1]] = value;
}
function unsetPath(obj, path) {
  const parts = String(path).split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    cur = cur[parts[i]];
    if (cur == null || typeof cur !== 'object') return;
  }
  delete cur[parts[parts.length - 1]];
}

const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v, (k, x) =>
  (x instanceof ObjectId ? String(x) : x instanceof Date ? { __d: x.getTime() } : x))));
const reviveDates = v => {
  if (v && typeof v === 'object') {
    if (typeof v.__d === 'number') return new Date(v.__d);
    for (const k of Object.keys(v)) v[k] = reviveDates(v[k]);
  }
  return v;
};
const deepCopy = v => reviveDates(clone(v));

// ── Filter matching ─────────────────────────────────────────────────────────
function matchValue(actual, cond) {
  if (cond instanceof RegExp) return cond.test(String(actual ?? ''));
  if (cond instanceof ObjectId) return sameId(actual, cond);
  if (cond instanceof Date) return actual instanceof Date && +actual === +cond;
  if (cond === null) return actual === null || actual === undefined;
  if (typeof cond !== 'object' || Array.isArray(cond)) {
    // An array field matches when ANY element equals the scalar, same as Mongo.
    if (Array.isArray(actual) && !Array.isArray(cond)) return actual.some(x => sameId(x, cond) || x === cond);
    return actual === cond || sameId(actual, cond);
  }
  const ops = Object.keys(cond);
  if (!ops.some(k => k.startsWith('$'))) return JSON.stringify(actual) === JSON.stringify(cond);
  return ops.every(op => {
    const want = cond[op];
    switch (op) {
      case '$in':  return (want || []).some(w => matchValue(actual, w));
      case '$nin': return !(want || []).some(w => matchValue(actual, w));
      case '$ne':  return !matchValue(actual, want);
      case '$gt':  return actual != null && actual > want;
      case '$gte': return actual != null && actual >= want;
      case '$lt':  return actual != null && actual < want;
      case '$lte': return actual != null && actual <= want;
      case '$exists': return (actual !== undefined) === !!want;
      case '$regex': return new RegExp(want, cond.$options || '').test(String(actual ?? ''));
      case '$options': return true;   // consumed by $regex above
      case '$elemMatch': return Array.isArray(actual) && actual.some(el => matchFilter(el, want));
      case '$not': return !matchValue(actual, want);
      default: return false;
    }
  });
}

function matchFilter(doc, filter) {
  if (!filter || typeof filter !== 'object') return true;
  return Object.entries(filter).every(([key, cond]) => {
    if (key === '$or')  return (cond || []).some(f => matchFilter(doc, f));
    if (key === '$and') return (cond || []).every(f => matchFilter(doc, f));
    if (key === '$nor') return !(cond || []).some(f => matchFilter(doc, f));
    return matchValue(getPath(doc, key), cond);
  });
}

// ── Aggregation-expression evaluation, for pipeline updates ─────────────────
// Mongo lets an update be an ARRAY of aggregation stages instead of a set of
// operators, and the difference matters: a pipeline can read the document it
// is writing, which is the only way to do "bump today's counter, or start a
// new one if the stored date is not today" in a single atomic write. That is
// exactly how the daily attempt counters for Страх, Кровавая Башня and the
// arena are recorded (_lockDailyAttempt, server/index.js).
//
// Without this, `Object.keys([{...}])` gave ['0'], the stage object was folded
// into $set as a field literally named "0", and the counter was never written
// at all. Every read then reported a full set of attempts, so entering an
// event looked free — and no test could see it, because the double was the
// thing making it look free. A double that silently drops a whole class of
// write is worse than one that refuses it, so unknown operators throw here
// rather than evaluate to undefined.
function evalExpr(expr, doc) {
  if (typeof expr === 'string') return expr.startsWith('$') ? getPath(doc, expr.slice(1)) : expr;
  if (expr === null || typeof expr !== 'object') return expr;
  if (Array.isArray(expr)) return expr.map(e => evalExpr(e, doc));

  const keys = Object.keys(expr);
  const op = keys.find(k => k.startsWith('$'));
  if (!op) {
    // A plain object literal — every value is itself an expression.
    const out = {};
    for (const k of keys) out[k] = evalExpr(expr[k], doc);
    return out;
  }
  const a = expr[op];
  const ev = x => evalExpr(x, doc);
  switch (op) {
    case '$literal':  return a;
    case '$ifNull':   { const v = ev(a[0]); return v === undefined || v === null ? ev(a[1]) : v; }
    case '$cond': {
      // Both spellings: [if, then, else] and { if, then, else }.
      const [i, t, e] = Array.isArray(a) ? a : [a.if, a.then, a.else];
      return ev(i) ? ev(t) : ev(e);
    }
    case '$eq':  return ev(a[0]) === ev(a[1]);
    case '$ne':  return ev(a[0]) !== ev(a[1]);
    case '$gt':  return ev(a[0]) >   ev(a[1]);
    case '$gte': return ev(a[0]) >=  ev(a[1]);
    case '$lt':  return ev(a[0]) <   ev(a[1]);
    case '$lte': return ev(a[0]) <=  ev(a[1]);
    case '$not': return !ev(Array.isArray(a) ? a[0] : a);
    case '$and': return a.every(x => ev(x));
    case '$or':  return a.some(x => ev(x));
    case '$in':  { const list = ev(a[1]); return Array.isArray(list) && list.includes(ev(a[0])); }
    case '$add': return a.reduce((n, x) => n + (Number(ev(x)) || 0), 0);
    case '$subtract': return (Number(ev(a[0])) || 0) - (Number(ev(a[1])) || 0);
    case '$multiply': return a.reduce((n, x) => n * (Number(ev(x)) || 0), 1);
    case '$max': return Math.max(...(Array.isArray(a) ? a : [a]).map(x => Number(ev(x)) || 0));
    case '$min': return Math.min(...(Array.isArray(a) ? a : [a]).map(x => Number(ev(x)) || 0));
    case '$concat': return a.map(x => String(ev(x) ?? '')).join('');
    default:
      throw new Error(`mongo-memory: aggregation operator ${op} is not implemented — ` +
        'add it here rather than letting a pipeline update silently do nothing');
  }
}

function applyPipeline(doc, stages) {
  for (const stage of stages) {
    if (!stage || typeof stage !== 'object') continue;
    if (stage.$set || stage.$addFields) {
      const fields = stage.$set || stage.$addFields;
      // Evaluated against a snapshot: within one stage every expression sees
      // the document as it was when the stage began, same as Mongo.
      const before = deepCopy(doc);
      for (const [p, expr] of Object.entries(fields)) setPath(doc, p, evalExpr(expr, before));
      continue;
    }
    if (stage.$unset) {
      const list = Array.isArray(stage.$unset) ? stage.$unset : [stage.$unset];
      list.forEach(p => unsetPath(doc, p));
      continue;
    }
    if (stage.$replaceWith || stage.$replaceRoot) {
      const expr = stage.$replaceWith || stage.$replaceRoot.newRoot;
      const next = evalExpr(expr, deepCopy(doc));
      Object.keys(doc).forEach(k => { if (k !== '_id') delete doc[k]; });
      Object.assign(doc, next);
      continue;
    }
    throw new Error(`mongo-memory: pipeline update stage ${Object.keys(stage)[0]} is not implemented`);
  }
}

// ── Update application ──────────────────────────────────────────────────────
function applyUpdate(doc, update) {
  if (!update) return;
  if (Array.isArray(update)) return applyPipeline(doc, update);
  // Mongoose's castUpdate ("fix up $set sugar") folds every bare top-level key
  // into $set before the driver ever sees it — Model.updateOne({}, { foo: 1 })
  // is a partial update, not a whole-document replace, and that is real
  // Mongoose behaviour (node_modules/mongoose/lib/helpers/query/castUpdate.js),
  // not raw MongoDB driver semantics. Flattening bare keys into $set here
  // matches that: several call sites (findOneAndUpdate with a plain object,
  // e.g. marketBuy's claim, the admin ban toggles) rely on it, and a double
  // that instead nuked the rest of the document made those look broken
  // (fields like item/price/sellerId vanishing) when production is fine.
  const bareKeys = Object.keys(update).filter(k => !k.startsWith('$'));
  const merged = bareKeys.length
    ? { ...update, $set: { ...(update.$set || {}), ...Object.fromEntries(bareKeys.map(k => [k, update[k]])) } }
    : update;
  for (const [path, value] of Object.entries(merged.$set || {})) setPath(doc, path, deepCopy(value));
  for (const [path, by]    of Object.entries(update.$inc || {})) {
    setPath(doc, path, (Number(getPath(doc, path)) || 0) + Number(by));
  }
  for (const [path, spec]  of Object.entries(update.$push || {})) {
    const arr = getPath(doc, path);
    const list = Array.isArray(arr) ? arr : [];
    if (spec && typeof spec === 'object' && Array.isArray(spec.$each)) list.push(...deepCopy(spec.$each));
    else list.push(deepCopy(spec));
    setPath(doc, path, list);
  }
  for (const [path, cond]  of Object.entries(update.$pull || {})) {
    const arr = getPath(doc, path);
    if (Array.isArray(arr)) setPath(doc, path, arr.filter(el => !matchValue(el, cond) && !matchFilter(el, cond)));
  }
  for (const path of Object.keys(update.$unset || {})) unsetPath(doc, path);
}

// ── Documents ───────────────────────────────────────────────────────────────
function makeDoc(model, raw) {
  const doc = deepCopy(raw) || {};
  Object.defineProperty(doc, 'save', { value: async function () { return model._commit(this); }, enumerable: false });
  Object.defineProperty(doc, 'toObject', { value: function () { return deepCopy(this); }, enumerable: false });
  Object.defineProperty(doc, '__model', { value: model, enumerable: false });
  return doc;
}

// ── Query builder ───────────────────────────────────────────────────────────
class Query {
  constructor(run) { this._run = run; this._sort = null; this._limit = 0; this._skip = 0; this._lean = false; this._sel = null; }
  sort(s)  { this._sort = s; return this; }
  limit(n) { this._limit = n; return this; }
  skip(n)  { this._skip = n; return this; }
  lean()   { this._lean = true; return this; }
  select(s){ this._sel = s; return this; }
  collation() { return this; }          // no indexes here, so it is a no-op
  maxTimeMS() { return this; }
  async exec() { return this._run(this); }
  then(res, rej) { return this.exec().then(res, rej); }
  catch(rej) { return this.exec().catch(rej); }
  finally(f) { return this.exec().finally(f); }
}

function applyProjection(rows, sel) {
  if (!sel) return rows;
  const fields = typeof sel === 'string' ? sel.split(/\s+/).filter(Boolean) : Object.keys(sel);
  if (!fields.length) return rows;
  return rows.map(r => {
    const out = { _id: r._id };
    fields.forEach(f => { const v = getPath(r, f); if (v !== undefined) setPath(out, f, v); });
    return out;
  });
}

function applyView(q, rows) {
  let out = rows;
  if (q._sort) {
    const keys = Object.entries(q._sort);
    out = out.slice().sort((a, b) => {
      for (const [k, dir] of keys) {
        const av = getPath(a, k), bv = getPath(b, k);
        if (av === bv) continue;
        const less = av == null ? true : bv == null ? false : av < bv;
        return (less ? -1 : 1) * (dir < 0 ? -1 : 1);
      }
      return 0;
    });
  }
  if (q._skip)  out = out.slice(q._skip);
  if (q._limit) out = out.slice(0, q._limit);
  out = applyProjection(out, q._sel);
  return out;
}

// ── Models ──────────────────────────────────────────────────────────────────
const _collections = new Map();   // model name -> array of docs

class Model {
  static get _rows() {
    if (!_collections.has(this.modelName)) _collections.set(this.modelName, []);
    return _collections.get(this.modelName);
  }

  static _defaults() {
    const out = {};
    for (const [k, def] of Object.entries(this.schema.obj || {})) {
      if (def && typeof def === 'object' && 'default' in def) {
        out[k] = typeof def.default === 'function' ? def.default() : def.default;
      }
    }
    return out;
  }

  static _commit(doc) {
    const i = this._rows.findIndex(r => sameId(r._id, doc._id));
    const stored = deepCopy(doc);
    if (i >= 0) this._rows[i] = stored; else this._rows.push(stored);
    return doc;
  }

  static async create(data) {
    const list = Array.isArray(data) ? data : [data];
    const made = list.map(d => {
      const doc = makeDoc(this, { _id: new ObjectId().toString(), ...this._defaults(), ...d });
      this._rows.push(deepCopy(doc));
      return doc;
    });
    return Array.isArray(data) ? made : made[0];
  }

  static find(filter = {}, projection = null) {
    const q = new Query(qq => {
      const rows = applyView(qq, this._rows.filter(r => matchFilter(r, filter)));
      return qq._lean ? rows.map(deepCopy) : rows.map(r => makeDoc(this, r));
    });
    if (projection) q.select(projection);
    return q;
  }

  static findOne(filter = {}, projection = null) {
    const q = new Query(qq => {
      const rows = applyView(qq, this._rows.filter(r => matchFilter(r, filter)));
      if (!rows.length) return null;
      return qq._lean ? deepCopy(rows[0]) : makeDoc(this, rows[0]);
    });
    if (projection) q.select(projection);
    return q;
  }

  static findById(id, projection = null) { return this.findOne({ _id: id }, projection); }

  static async updateOne(filter, update) {
    const i = this._rows.findIndex(r => matchFilter(r, filter));
    if (i < 0) return { matchedCount: 0, modifiedCount: 0 };
    applyUpdate(this._rows[i], update);
    return { matchedCount: 1, modifiedCount: 1 };
  }

  static async updateMany(filter, update) {
    let n = 0;
    this._rows.forEach(r => { if (matchFilter(r, filter)) { applyUpdate(r, update); n++; } });
    return { matchedCount: n, modifiedCount: n };
  }

  static findOneAndUpdate(filter, update, opts = {}) {
    return new Query(qq => {
      let i = this._rows.findIndex(r => matchFilter(r, filter));
      if (i < 0) {
        if (!opts.upsert) return null;
        // Seed the new document from the equality parts of the filter, the way
        // an upsert does.
        const seed = { _id: new ObjectId().toString(), ...this._defaults() };
        for (const [k, v] of Object.entries(filter)) {
          if (typeof v !== 'object' || v === null || v instanceof ObjectId) setPath(seed, k, v);
        }
        this._rows.push(seed);
        i = this._rows.length - 1;
      }
      const before = deepCopy(this._rows[i]);
      applyUpdate(this._rows[i], update);
      const row = opts.new ? this._rows[i] : before;
      const view = applyProjection([row], qq._sel || opts.projection)[0];
      return qq._lean ? deepCopy(view) : makeDoc(this, view);
    });
  }

  static findByIdAndUpdate(id, update, opts = {}) { return this.findOneAndUpdate({ _id: id }, update, opts); }

  static async deleteOne(filter) {
    const i = this._rows.findIndex(r => matchFilter(r, filter));
    if (i < 0) return { deletedCount: 0 };
    this._rows.splice(i, 1);
    return { deletedCount: 1 };
  }

  static async deleteMany(filter = {}) {
    const before = this._rows.length;
    const keep = this._rows.filter(r => !matchFilter(r, filter));
    _collections.set(this.modelName, keep);
    return { deletedCount: before - keep.length };
  }

  static countDocuments(filter = {}) {
    return new Query(() => this._rows.filter(r => matchFilter(r, filter)).length);
  }

  static distinct(field, filter = {}) {
    return new Query(() => [...new Set(this._rows.filter(r => matchFilter(r, filter)).map(r => getPath(r, field)))]);
  }

  // Only the stages the admin endpoints use: $match, $group (with $sum/$push),
  // $sort, $limit. Anything else throws rather than returning a quiet lie.
  static aggregate(pipeline = []) {
    return new Query(() => {
      let rows = this._rows.map(deepCopy);
      for (const stage of pipeline) {
        const [op] = Object.keys(stage);
        const spec = stage[op];
        if (op === '$match') rows = rows.filter(r => matchFilter(r, spec));
        else if (op === '$sort') rows = rows.slice().sort((a, b) => {
          for (const [k, dir] of Object.entries(spec)) {
            if (a[k] === b[k]) continue;
            return (a[k] < b[k] ? -1 : 1) * (dir < 0 ? -1 : 1);
          }
          return 0;
        });
        else if (op === '$limit') rows = rows.slice(0, spec);
        else if (op === '$group') {
          const groups = new Map();
          const keyOf = r => (spec._id == null ? null
            : String(spec._id).startsWith('$') ? getPath(r, String(spec._id).slice(1)) : spec._id);
          for (const r of rows) {
            const k = keyOf(r);
            if (!groups.has(k)) groups.set(k, { _id: k, __rows: [] });
            groups.get(k).__rows.push(r);
          }
          rows = [...groups.values()].map(g => {
            const out = { _id: g._id };
            for (const [field, acc] of Object.entries(spec)) {
              if (field === '_id') continue;
              const [fn] = Object.keys(acc);
              const arg = acc[fn];
              const val = r => (typeof arg === 'string' && arg.startsWith('$') ? getPath(r, arg.slice(1)) : arg);
              if (fn === '$sum')  out[field] = g.__rows.reduce((s, r) => s + (Number(val(r)) || 0), 0);
              else if (fn === '$push') out[field] = g.__rows.map(val);
              else if (fn === '$first') out[field] = val(g.__rows[0]);
              else if (fn === '$max') out[field] = Math.max(...g.__rows.map(r => Number(val(r)) || 0));
              else throw new Error('mongo-memory: unsupported $group accumulator ' + fn);
            }
            return out;
          });
        } else throw new Error('mongo-memory: unsupported aggregate stage ' + op);
      }
      return rows;
    });
  }

  static async syncIndexes() { return []; }
  static async createIndexes() { return []; }
}

// ── mongoose surface ────────────────────────────────────────────────────────
class Schema {
  constructor(obj, options) { this.obj = obj || {}; this.options = options || {}; }
  index() { return this; }
  pre() { return this; }
  post() { return this; }
  set() { return this; }
  virtual() { return { get() { return this; }, set() { return this; } }; }
}
Schema.Types = { Mixed: 'Mixed', ObjectId, String, Number, Boolean, Date, Array };

const connection = {
  readyState: 0,
  async close() { connection.readyState = 0; },
  on() {}, once() {},
  collections: {},
  db: { admin: () => ({ ping: async () => ({ ok: 1 }) }) },
};

const mongoose = {
  Schema,
  Types: { ObjectId },
  connection,
  models: {},
  set() {},
  async connect() { connection.readyState = 1; return mongoose; },
  async disconnect() { connection.readyState = 0; },
  model(name, schema) {
    if (mongoose.models[name]) return mongoose.models[name];
    const M = class extends Model {};
    Object.defineProperty(M, 'name', { value: name });
    M.modelName = name;
    M.schema = schema || new Schema({});
    mongoose.models[name] = M;
    return M;
  },
  // Test-side helpers, not part of the mongoose API.
  __reset() { _collections.clear(); },
  __dump(name) { return (_collections.get(name) || []).map(deepCopy); },
  __count(name) { return (_collections.get(name) || []).length; },
};

module.exports = mongoose;
module.exports.default = mongoose;
