'use strict';

Object.defineProperty(exports, '__esModule', { value: true });

var apolloServerLambda = require('apollo-server-lambda');
var dynamoPlus = require('dynamo-plus');
var assert = require('assert');
var sha1 = require('sha1');
var _ = require('lodash');
var openpgp = require('openpgp');
var currency$1 = require('currency.js');
var serverLog = require('server-log');
var merge = require('@graphql-tools/merge');
var graphqlScalars = require('graphql-scalars');
var graphql = require('graphql');
var language = require('graphql/language');
var apolloServer = require('apollo-server');
var AWS = require('aws-sdk');
var util = require('util');
var fs = require('fs');

function _interopDefaultLegacy (e) { return e && typeof e === 'object' && 'default' in e ? e : { 'default': e }; }

var assert__default = /*#__PURE__*/_interopDefaultLegacy(assert);
var sha1__default = /*#__PURE__*/_interopDefaultLegacy(sha1);
var currency__default = /*#__PURE__*/_interopDefaultLegacy(currency$1);
var AWS__default = /*#__PURE__*/_interopDefaultLegacy(AWS);
var fs__default = /*#__PURE__*/_interopDefaultLegacy(fs);

// reliably sort an objects keys and merge everything into one String
const sortedObjectString = obj => {
  return Object.keys(obj)
    .sort()
    .reduce((arr, key) => {
      arr.push(`${key}:${obj[key]}`);
      return arr
    }, [])
    .join('|')
};
/**
 * Sign with private key. You can pass the already parse privateKey if you have it, otherwise it will be lazy loaded from the armored version.
 */
const Signer = (armoredPrivateKey, privateKey) => {
  const signer = {
    sign: async input => {
      // assert(!_.isEmpty(input), 'Missing input')
      const text = typeof input === 'string' ? input : sortedObjectString(input);
      privateKey = privateKey === undefined ? await openpgp.readPrivateKey({ armoredKey: armoredPrivateKey }) : privateKey; // lazy loaded
      return openpgp.sign({
        message: await openpgp.createMessage({ text }),
        signingKeys: privateKey,
        detached: true
      })
    }
  };
  return signer
};

/**
 * Simplified, asynchronous signature verification that throws Errors when things don't line up. To use:
 *
 * `const fingerprint = await Verifier(key).verify(text, signature)`
 * The Verifier can be reused.
 *
 * @param {string} key - An armored OpenPGP (public) key
 */
const Verifier = (armoredPublicKey, publicKey) => {
  let fingerprint;
  return {
    /**
     * @param {string|object} text - The text or object that was signed
     * @param {string} signature - The armored and detached OpenPGP signature
     * @returns true is the signature matches
     * @throws An error if the input (key or signature) is not in a valid format or if the signature doesn't match.
     */
    verify: async (input, armoredSignature) => {
      const text = typeof input === 'string' ? input : sortedObjectString(input);
      publicKey = publicKey === undefined ? await openpgp.readKey({ armoredKey: armoredPublicKey }) : publicKey; // lazy loaded
      await openpgp.verify({
        message: await openpgp.createMessage({ text }),
        signature: await openpgp.readSignature({ armoredSignature }),
        verificationKeys: publicKey,
        expectSigned: true // automatically throws an error
      });
      return true
    },
    fingerprint: async () => {
      if (!fingerprint) {
        publicKey = publicKey === undefined ? await openpgp.readKey({ armoredKey: armoredPublicKey }) : publicKey; // lazy loaded
        fingerprint = publicKey.getFingerprint();
      }
      return fingerprint
    }
  }
};

const KeyWrapper = (key) => {
  return {
    publicKey: Verifier(key.publicKeyArmored),
    publicKeyArmored: key.publicKeyArmored,
    privateKey: Signer(key.privateKeyArmored),
    privateKeyArmored: key.privateKeyArmored
  }
};

const KeyGenerator = (userId = {}, log = () => {}) => {
  return {
    generate: async () => {
      // simply add 'passphrase' as an option here to protect the key:
      log('Generating keys');
      const key = await openpgp.generateKey({
        userIDs: userId,
        //        type: 'rsa',
        // rsaBits: 4096,
        type: 'ecc',
        format: 'object'
      });
      log('Keys generated');
      return {
        publicKey: Verifier(key.publicKey.armor(), key.publicKey),
        publicKeyArmored: key.publicKey.armor(),
        privateKey: Signer(key.privateKey.armor(), key.privateKey),
        privateKeyArmored: key.privateKey.armor()
      }
    }
  }
};

const wrap = value => {
  if (value instanceof Mani) {
    return value
  } else {
    return new Mani(value)
  }
};

/**
 * Mani currency class. See [Currency.js](https://currency.js.org/).
 */
class Mani {
  constructor (value) {
    this.m = currency__default['default'](value, {
      symbol: 'ɱ',
      decimal: ',',
      separator: '.',
      increment: 0.05,
      errorOnInvalid: true,
      pattern: '# !',
      negativePattern: '-# !'
    });
  }

  get value () {
    return this.m.value
  }

  get intValue () {
    return this.m.intValue
  }

  add (value) {
    return new Mani(this.m.add(wrap(value).m))
  }

  subtract (value) {
    return new Mani(this.m.subtract(wrap(value).m))
  }

  multiply (value) {
    return new Mani(this.m.multiply(value))
  }

  divide (value) {
    return new Mani(this.m.divide(value))
  }

  distribute (value) {
    return new Mani(this.m.distribute(value))
  }

  positive () {
    return this.m.value > 0
  }

  negative () {
    return this.m.value < 0
  }

  format () {
    return this.m.format()
  }

  equals (value) {
    return this.intValue === wrap(value).intValue
  }

  clone () {
    return new Mani(this.value)
  }

  toString () {
    return this.m.format()
  }
}

const mani = value => new Mani(value);

/**
 * In many ways, this is the heart of the system. Thread carefully.
 */

function pad (i) {
  return ('000000000000' + i).slice(-12)
}
function other (party) {
  return party === 'ledger' ? 'destination' : 'ledger'
}
function entryPath (entry) {
  return `/${pad(entry.sequence)}/${entry.uid}`
}
function path (entry) {
  return `/${entry.ledger}${entryPath(entry)}`
}
function sortKey (entry) {
  return `/${entry.date.toISOString()}${entryPath(entry)}`
}
function destructurePath (path) {
  const match = new RegExp(
    '/(?<ledger>[a-z0-9]+)/(?<sequence>[0-9]+)/(?<uid>[a-z0-9]+)'
  ).exec(path);
  if (!match) {
    throw new Error('invalid path')
  }
  let { ledger, sequence, uid } = match.groups;
  sequence = parseInt(sequence);
  return { ledger, sequence, uid }
}
function destructure (payload, flip = false) {
  const full =
    '^/(?<date>[^/]+)/from(?<from>.+)(?=/to)/to(?<to>.+)(?=/)/(?<amount>[-0-9,ɱ ]+)';
  let match = new RegExp(full).exec(payload);
  if (match) {
    let { date, from, to, amount } = match.groups;
    date = new Date(date);
    from = destructurePath(from);
    to = destructurePath(to);
    amount = new Mani(amount);
    if (flip) {
      return { date, from: to, to: from, amount: amount.multiply(-1) }
    }
    return { date, from, to, amount }
  }
  throw new Error('invalid payload')
}
function toEntry (pl, flip = false) {
  const { date, from, to, amount } = destructure(pl, flip);
  const { ledger, sequence, uid } = from;
  if (flip) {
    pl = payload({ date, from, to, amount });
  }
  return {
    date,
    ledger,
    entry: 'pending',
    sequence,
    uid,
    destination: to.ledger,
    payload: pl,
    amount
  }
}
function flip (pl) {
  return payload(destructure(pl, true))
}
function payload ({ date, from, to, amount }) {
  let payload = `/${date.toISOString()}/from${path(from)}/to${path(to)}`;
  if (amount) {
    payload = payload + `/${amount.format()}`;
  }
  return payload
}
function shadowEntry (ledger) {
  // this is the "shadow entry" that sits right before the first entry on a ledger
  return {
    ledger,
    entry: 'shadow',
    sequence: -1,
    next: 'init', // there is nothing before this entry
    balance: new Mani(0)
  }
}
function addSignature$1 (entry, ledger, signature) {
  assert__default['default'](_.isString(signature), 'signature');
  const result = { ...entry }; // cheap clone
  if (entry.ledger === ledger) {
    result.next = sha1__default['default'](signature);
    result.signature = signature;
  }
  if (entry.destination === ledger) {
    result.counterSignature = signature;
  }
  if (entry.entry === 'pending' && isSigned(result)) {
    result.entry = '/current';
  }
  return result
}
function toDb (entry) {
  return _.mapValues(entry, value => {
    if (value instanceof Mani) {
      return value.format()
    }
    if (value instanceof Date) {
      return value.toISOString()
    }
    return value
  })
}
function fromDb (entry) {
  if (!entry) {
    return undefined
  }
  if (_.isArray(entry)) {
    return _.map(entry, fromDb)
  }
  return _.mapValues(entry, (value, key) => {
    if (key === 'date') {
      return new Date(value)
    }
    if (
      (key === 'amount' || key === 'balance' || key === 'income') &&
      _.isString(value)
    ) {
      return new Mani(value)
    }
    if (key === 'demurrage' && _.isString(value)) {
      return new Mani(value)
    }
    return value
  })
}
function isSigned (entry) {
  if (_.isString(entry.signature) && entry.ledger === 'system') return true // system entries don't require counterSignatures!
  if (!_.isString(entry.signature) || !_.isString(entry.counterSignature)) {
    return false
  }
  return true
}
function next ({ ledger, sequence, next }) {
  return {
    ledger,
    sequence: sequence + 1,
    uid: next
  }
}
function challenge ({ date, source, target, amount }) {
  return payload({ date, from: next(source), to: next(target), amount })
}

const tools = {
  pad,
  other,
  shadowEntry,
  addSignature: addSignature$1,
  toDb,
  fromDb,
  isSigned,
  next,
  payload,
  destructure,
  destructurePath,
  challenge,
  toEntry,
  sortKey,
  flip
};

const log$7 = serverLog.getLogger('core:util');
/**
 * Note that the 'table' listed below should always be a core/ledgerTable object
 */
async function mapValuesAsync (object, asyncFn) {
  return Object.fromEntries(
    await Promise.all(
      Object.entries(object).map(async ([key, value]) => [
        key,
        await asyncFn(value, key, object)
      ])
    )
  )
}

/**
 * Create context.source:
 * if no /current, return shadow
 *
 * Sample input:
 *  - ledger: '<fingerprint>'
 *  - destination: 'system'
 */
async function getSources (table, input) {
  log$7.debug('Getting sources for %j', input);
  return mapValuesAsync(input, async (ledger, role, input) => {
    const current = await table.current(ledger);
    if (current) return current
    return shadowEntry(ledger)
  })
}

function getPayloads (payload) {
  return {
    ledger: { ...destructure(payload), challenge: payload },
    destination: { ...destructure(payload, true), challenge: flip(payload) }
  }
}
// used during regular transaction creation
async function getPayloadSources (table, { payloads }) {
  return mapValuesAsync(
    payloads,
    async ({ from: { ledger } }, role, payloads) => {
      log$7.debug('Getting current on %s %s', role, ledger);
      return table.current(ledger, true)
    }
  )
}

/**
 * Get 'next' target (pending) entries.
 * There should be no pending items in the DB.
 * Used for: system init, create new ledger challenge, create transaction challenge and basic income
 */
async function getNextTargets (table, { sources }) {
  const date = new Date(Date.now());
  return mapValuesAsync(sources, async (source, role, sources) => {
    if (source.ledger !== 'system') {
      // the system ledger never has pending items
      const pending = await table.pending(source.ledger);
      if (pending) { throw new Error(`Ledger ${source.ledger} already has a pending entry: ${JSON.stringify(pending)}`) }
    }
    return {
      ...next(source),
      entry: 'pending',
      sequence: source.sequence + 1,
      uid: source.next,
      date,
      balance: source.balance,
      destination: sources[other(role)].ledger
    }
  })
}
/**
 * Add amount to targets.
 */
function addAmount ({ targets: { ledger, destination } }, amount) {
  ledger.amount = amount;
  ledger.balance = ledger.balance.add(amount);
  ledger.challenge = payload({
    date: ledger.date,
    from: ledger,
    to: destination,
    amount
  });
  if (ledger.ledger !== 'system' && ledger.balance.value < 0) { throw new Error(`Amount not available on ${ledger.ledger}`) }
  const complement = amount.multiply(-1);
  destination.amount = complement;
  destination.balance = destination.balance.add(complement);
  destination.challenge = payload({
    date: ledger.date,
    from: destination,
    to: ledger,
    amount: complement
  });
  if (destination.ledger !== 'system' && destination.balance.value < 0) {
    throw new Error(
      `Amount ${complement.format()} not available on ${destination.ledger}`
    )
  }
  return { ledger, destination }
}
/**
 * Add Demmurage and Income.
 */
function addDI ({ targets: { ledger, destination } }, { demurrage, income }) {
  ledger.demurrage = ledger.balance.multiply(demurrage / 100);
  ledger.income = income;
  ledger.amount = ledger.income.subtract(ledger.demurrage);
  ledger.balance = ledger.balance.subtract(ledger.demurrage).add(ledger.income);
  ledger.challenge = payload({
    date: ledger.date,
    from: ledger,
    to: destination,
    amount: ledger.amount
  });
  destination.demurrage = ledger.demurrage.multiply(-1);
  destination.income = ledger.income.multiply(-1);
  destination.amount = destination.income.subtract(destination.demurrage);
  destination.balance = destination.balance
    .subtract(destination.demurrage)
    .add(destination.income);
  destination.challenge = payload({
    date: ledger.date,
    from: destination,
    to: ledger,
    amount: destination.amount
  });
  return { ledger, destination }
}
/**
 * Construct targets from payloads, double-check if matches with source.
 * Used in: create new ledger, sign transaction (initial)
 */
function getPayloadTargets ({ payloads, sources }) {
  return _.mapValues(payloads, (payload, role, payloads) => {
    const {
      date,
      from: { ledger, sequence, uid },
      to: { ledger: destination },
      challenge,
      amount
    } = payload;
    const { sequence: sourceSequence, next, balance } = sources[role];
    assert__default['default'](sequence === sourceSequence + 1, 'Matching sequence');
    assert__default['default'](uid === next, 'Matching next uid');
    return {
      ledger,
      entry: 'pending',
      date,
      sequence,
      uid,
      destination,
      amount,
      balance: balance.add(amount),
      challenge
    }
  })
}
/**
 * Get pending items from DB, check if it matches the payload.
 */
async function getPendingTargets (table, { payloads }) {
  return mapValuesAsync(payloads, async (payload, role, payloads) => {
    const {
      date,
      from: { ledger, sequence, uid },
      to: { ledger: destination },
      amount
    } = payload;
    if (ledger === 'system') {
      const matching = await table.entry(ledger, `/${date.toISOString()}/${sequence}/${uid}`); // already made permanent
      if (matching) return matching
      const current = await table.current(ledger);
      if (current) {
        assert__default['default'](date.getTime() === current.date.getTime(), 'Matching dates');
        assert__default['default'](amount.equals(current.amount), 'Matching amounts');
        return current
      }
      throw new Error(`Matching system entry not found`)
    } else {
      const pending = await table.pending(ledger, true);
      assert__default['default'](date.getTime() === pending.date.getTime(), 'Matching date');
      assert__default['default'](destination === pending.destination, 'Matching destination');
      assert__default['default'](sequence === pending.sequence, 'Matching sequence');
      assert__default['default'](uid === pending.uid, 'Matching uid');
      assert__default['default'](amount.equals(pending.amount), 'matching amount');
      return pending
    }
  })
}
/**
 * Find the entries preceding the targets.
 */
async function getPendingSources (table, { targets }) {
  return mapValuesAsync(targets, async (target, role, targets) => {
    if (target.ledger !== 'system') {
      const current = await table.current(target.ledger, true);
      assert__default['default'](target.uid === current.next, 'Sequential uid');
      assert__default['default'](target.sequence === current.sequence + 1, 'Sequence');
      return current
    }
    // Note we don't reconstruct sources for system entries as they are necessarily already made permanent
  })
}

function addSignature (
  { ledger, destination },
  { signature, counterSignature }
) {
  ledger.signature = signature;
  ledger.next = sha1__default['default'](signature);
  destination.counterSignature = counterSignature;
  return { ledger, destination }
}

async function addSystemSignatures (table, { sources, targets }, keys) {
  // autosigning system side
  // happens during system init, UBI and creation of new ledger
  log$7.info(`Autosigning system (only during init)`);
  assert__default['default'](
    targets.destination.ledger === 'system' &&
      targets.ledger.destination === 'system',
    'System destination'
  );
  if (!keys) {
    keys = KeyWrapper(
      await table.keys('system', true)
    );
  }
  log$7.debug('Signing targets %j', targets);
  log$7.debug('with keys %j', keys);
  // log(JSON.stringify(targets, null, 2))
  targets.destination.signature = await keys.privateKey.sign(
    targets.destination.challenge
  );
  const next = sha1__default['default'](targets.destination.signature);
  targets.destination.next = next;
  if (targets.ledger.ledger === 'system') {
    // system init
    assert__default['default'](
      targets.destination.challenge === targets.ledger.challenge,
      'Oroborous system init'
    );
    const signature = targets.destination.signature;
    targets.ledger.signature = signature;
    targets.ledger.counterSignature = signature;
    targets.ledger.next = next;
    targets.destination.counterSignature = signature;
  } else {
    targets.ledger.counterSignature = await keys.privateKey.sign(
      targets.ledger.challenge
    );
  }
  return targets
}
/**
 * Add signatures, autosigning system entries.
 * This automatically saves entries.
 */
async function addSignatures (
  table,
  { targets },
  { ledger, signature, counterSignature, publicKeyArmored }
) {
  if (ledger) {
    assert__default['default'](ledger === targets.ledger.ledger, 'Target ledger');
    if (!publicKeyArmored) {
({ publicKeyArmored } = await table.keys(ledger, true));
      if (!publicKeyArmored) throw new Error(`Missing PK:  ${ledger}`)
    }
    const verifier = Verifier(publicKeyArmored);
    await verifier.verify(targets.ledger.challenge, signature); // throws error if wrong
    await verifier.verify(targets.destination.challenge, counterSignature); // throws error if wrong
    targets = addSignature(targets, { signature, counterSignature });
  }
  return targets
}
/**
 * Transition entries, adding/updating/deleting DB entries where necessarywhere necessary
 */
function transition (table, { source, target }) {
  if (target.entry === 'pending' && isSigned(target)) {
    target.entry = '/current';
    table.putEntry(target);
    if (target.ledger !== 'system') {
      table.deletePending(target.ledger);
    }
    if (source && source.entry === '/current') {
      // bump to a permanent state
      source.entry = sortKey(source);
      table.putEntry(source);
    }
  } else {
    // no state transition, we just save the target
    table.putEntry(target);
  }
}
/**
 * Save the targets, transitioning entry states where relevant.
 */
function saveResults (table, { sources, targets }) {
  if (sources.ledger.ledger !== 'system') {
    // only happens during system init
    transition(table, { source: sources.ledger, target: targets.ledger });
  } else {
    assert__default['default'](
      targets.destination.challenge === targets.ledger.challenge,
      'Oroborous system init'
    );
  }
  transition(table, {
    source: sources.destination,
    target: targets.destination
  });
}

/**
 * This is the way.
 *
 * (table is actually a core/ledgers object)
 */
const StateMachine = (table) => {
  const context = {};
  return {
    getPayloads (payload) {
      context.payloads = getPayloads(payload);
      return Sourcing(context)
    },
    async getSources (ledgers) {
      return Sourcing(context).getSources(ledgers)
    }
  }
  function Sourcing (context) {
    return {
      async getSources (ledgers) {
        context.sources = await getSources(table, ledgers);
        return Targets(context)
      },
      async getPayloadSources () {
        context.sources = await getPayloadSources(table, context);
        return Targets(context)
      },
      async continuePending () {
        context.targets = await getPendingTargets(table, context);
        context.sources = await getPendingSources(table, context);
        // log(JSON.stringify(context, null, 2))
        return Continue(context)
      }
    }
  }
  async function Targets (context) {
    if (context.payloads) {
      return {
        continuePayload () {
          context.targets = getPayloadTargets(context);
          return Continue(context)
        }
      }
    } else {
      context.targets = await getNextTargets(table, context);
      return {
        addAmount (amount) {
          context.targets = addAmount(context, amount);
          return Continue(context)
        },
        addDI (DI) {
          context.targets = addDI(context, DI);
          return Continue(context)
        }
      }
    }
  }
  function Continue (context) {
    return {
      getPrimaryEntry () {
        return context.targets.ledger
      },
      async addSystemSignatures (keys) {
        context.targets = await addSystemSignatures(table, context, keys);
        return Continue(context)
      },
      async addSignatures (signatures) {
        context.targets = await addSignatures(table, context, signatures);
        return Continue(context)
      },
      async save () {
        saveResults(table, context);
      }
    }
  }
};

/**
 * Specialized functions to strictly work with ledgers. Continues building on table.
 */

function ledgers (table, prefix = '') {
  const skip = prefix.length;
  async function entry (fingerprint, entry, required = false) {
    const item = await table.getItem(
      { ledger: prefix + fingerprint, entry },
      required ? `Entry ${entry} not found for ledger ${fingerprint}` : undefined
    );
    if (item) {
      item.ledger = item.ledger.substring(skip); // strip the prefix
    }
    return item
  }
  return {
    async current (fingerprint, required = false) {
      return entry(fingerprint, '/current', required)
    },
    async pending (fingerprint, required = false) {
      return entry(fingerprint, 'pending', required)
    },
    entry,
    async putEntry (entry) {
      assert__default['default'](entry instanceof Object);
      entry.ledger = prefix + entry.ledger;
      return table.putItem(entry)
    },
    async deletePending (fingerprint) {
      return table.deleteItem({ ledger: prefix + fingerprint, entry: 'pending' })
    },
    async keys (fingerprint, required = false) {
      return table.getItem(
        { ledger: fingerprint, entry: 'pk' },
        required ? `Key(s) not found for ledger ${fingerprint}` : undefined
      )
    },
    async recent (fingerprint) {
      // log.debug('ledger = %s AND begins_with(entry,/)', ledger)
      return table.queryItems({
        KeyConditionExpression:
          'ledger = :ledger AND begins_with(entry, :slash)',
        ExpressionAttributeValues: {
          ':ledger': fingerprint,
          ':slash': '/'
        }
      })
    },
    short () {
      // to reduce the size of the results, we can limit the attributes requested (omitting the signatures, which are fairly large text fields).
      return ledgers(table.attributes([
        'ledger',
        'destination',
        'amount',
        'balance',
        'date',
        'payload',
        'next',
        'sequence',
        'uid',
        'income',
        'demurrage',
        'challenge'
      ]), prefix)
    },
    transaction () {
      return ledgers(table.transaction(), prefix)
    },
    async execute () {
      return table.execute()
    }
  }
}

const PARAMS_KEY = { ledger: 'system', entry: 'parameters' };
const PK_KEY = { ledger: 'system', entry: 'pk' };

const log$6 = serverLog.getLogger('core:system');

function System (table, userpool) {
  return {
    async parameters () {
      return table.getItem(PARAMS_KEY)
    },
    async findkey (fingerprint) {
      return table.attributes(['ledger', 'publicKeyArmored', 'alias']).getItem({ ledger: fingerprint, entry: 'pk' })
    },
    async init () {
      log$6.info('System init requested');
      let keys = await table.getItem(PK_KEY);
      log$6.info('Checking keys');
      if (keys) {
        log$6.info('System already initialized');
        return // idempotency
      }
      log$6.info('Generating system keys');
      // initializing fresh system:
      keys = await KeyGenerator({}, log$6.info).generate();
      log$6.info('System keys generated');
      const { publicKeyArmored, privateKeyArmored } = keys;
      const trans = table.transaction();
      trans.putItem({ ...PK_KEY, publicKeyArmored, privateKeyArmored });
      trans.putItem({ ...PARAMS_KEY, income: mani(100), demurrage: 5.0 }); // TODO: replace hardcoded values
      const ledgers$1 = ledgers(trans, '');
      await StateMachine(ledgers$1)
        .getSources({ ledger: 'system', destination: 'system' })
        .then(t => t.addAmount(mani(0)))
        .then(t => t.addSystemSignatures(keys))
        .then(t => t.save())
        .catch(err => log$6.error('System initialization failed\n%j', err));
      log$6.debug('Database update: %j', trans.items());
      log$6.info('System keys and parameters stored');
      await trans.execute();
      return `SuMsy initialized with ${mani(
        100
      ).format()} income and 5% demurrage.`
    },
    async challenge () {
      // provides the payload of the first transaction on a new ledger
      // clients have to replace '<fingerprint>'
      const ledgers$1 = ledgers(table, '');
      return StateMachine(ledgers$1)
        .getSources({ ledger: '<fingerprint>', destination: 'system' })
        .then(t => t.addAmount(mani(0)))
        .then(t => t.getPrimaryEntry().challenge)
    },
    async register (registration) {
      const { publicKeyArmored, payload, alias } = registration;
      const ledger = await Verifier(publicKeyArmored).fingerprint();
      const existing = await table.getItem({ ledger, entry: '/current' });
      if (existing) {
        log$6.info('Ledger was already registered: %s', ledger);
        return ledger // idempotency!
      }
      const transaction = table.transaction();
      const ledgers$1 = ledgers(transaction, '');
      // TODO: assert amount = 0
      await StateMachine(ledgers$1)
        .getPayloads(payload)
        .getSources({ ledger, destination: 'system' })
        .then(t => t.continuePayload())
        .then(t => t.addSystemSignatures())
        .then(t => t.addSignatures({ ledger, ...registration }))
        .then(t => t.save());
      transaction.putItem({
        ledger,
        entry: 'pk',
        publicKeyArmored,
        alias,
        challenge: payload
      });
      await transaction.execute();
      log$6.info('Registered ledger %s', ledger);
      return ledger
    },
    async jubilee (ledger) {
      const results = {
        ledgers: 0,
        demurrage: mani(0),
        income: mani(0)
      };
      const parameters = await table.getItem(
        PARAMS_KEY,
        'Missing system parameters'
      );
      async function applyJubilee (ledger) {
        log$6.debug('Applying jubilee to ledger %s', ledger);
        const transaction = table.transaction();
        const ledgers$1 = ledgers(transaction, '');
        await StateMachine(ledgers$1)
          .getSources({ ledger, destination: 'system' })
          .then(t => t.addDI(parameters))
          .then(t => {
            const entry = t.getPrimaryEntry();
            results.income = results.income.add(entry.income);
            results.demurrage = results.demurrage.add(entry.demurrage);
            results.ledgers++;
            return t
          })
          .then(t => t.addSystemSignatures())
          .then(t => t.save())
          .catch(log$6.error);
        await transaction.execute();
        log$6.debug('Jubilee succesfully applied to ledger %s', ledger);
      }
      if (ledger) {
        await applyJubilee(ledger);
      } else {
        const users = await userpool.listJubileeUsers();
        for (let { ledger } of users) {
          // these for loops allow await!
          await applyJubilee(ledger);
        }
      }
      return results
    }
  }
}

/**
 * Specialized view on a single ledger.
 */

function ledger (ledgers, fingerprint) {
  return {
    fingerprint,
    async current (required = false) {
      return ledgers.current(fingerprint, required)
    },
    async pending (required = false) {
      return ledgers.pending(fingerprint, required)
    },
    async recent () {
      return ledgers.recent(fingerprint)
    },
    async entry (entry, required = false) {
      return ledgers.entry(fingerprint, entry, required)
    },
    short () {
      return ledger(ledgers.short(), fingerprint)
    }
  }
}

const log$5 = serverLog.getLogger('core:transactions');

/**
 * Operations on a single ledger.
 */
var Transactions = (T, fingerprint, prefix = '') => {
  const ledgers$1 = ledgers(T, prefix);
  const ledger$1 = ledger(ledgers$1, fingerprint);
  // assert(isObject(verification), 'Verification')
  log$5.trace('Transactions dynamo');
  const { current, pending, recent, short } = ledger$1;
  return {
    fingerprint,
    current,
    pending,
    recent,
    short,
    async challenge (destination, amount) {
      return StateMachine(ledgers$1)
        .getSources({ ledger: fingerprint, destination })
        .then(t => t.addAmount(amount))
        .then(t => t.getPrimaryEntry().challenge)
    },
    async create (proof) {
      const existing = await ledger$1.pending();
      if (existing && existing.challenge === proof.payload) {
        log$5.info(`Transaction ${proof.payload} was already created`);
        return existing.next // idempotency
      }
      let next;
      const transaction = ledgers$1.transaction();
      await StateMachine(transaction)
        .getPayloads(proof.payload)
        .getPayloadSources()
        .then(t => t.continuePayload())
        .then(t => t.addSignatures({ ledger: fingerprint, ...proof }))
        .then(t => {
          next = t.getPrimaryEntry().next;
          return t
        })
        .then(t => t.save());
      await transaction.execute();
      return next
    },
    async confirm (proof) {
      // proof contains signature, counterSignature, payload
      const existing = await ledger$1.current();
      if (existing && existing.challenge === proof.payload) {
        log$5.info(`Transaction ${proof.payload} was already confirmed`);
        return existing.next // idempotency
      }
      let next;
      const transaction = ledgers$1.transaction();
      await StateMachine(transaction)
        .getPayloads(proof.payload)
        .continuePending()
        .then(t => t.addSignatures({ ledger: fingerprint, ...proof }))
        .then(t => {
          next = t.getPrimaryEntry().next;
          log$5.debug('Primary entry: %j', t.getPrimaryEntry());
          return t
        })
        .then(t => t.save());
      await transaction.execute();
      return next
    },
    async cancel (challenge) {
      const pending = await ledger$1.pending();
      if (pending && pending.challenge === challenge) {
        if (pending.destination === 'system') {
          throw new Error('System transactions cannot be cancelled.')
        }
        const destination = await ledgers$1.pendingEntry(pending.destination);
        if (!destination) {
          throw new Error(
            'No matching transaction found on destination ledger, please contact system administrators.'
          )
        }
        const transaction = ledgers$1.transaction();
        transaction.deletePending(fingerprint);
        transaction.deletePending(pending.destination);
        await transaction.execute();
        return 'Pending transaction successfully cancelled.'
      } else {
        return 'No matching pending transaction found, it may have already been cancelled or confirmed.'
      }
    }
  }
};

const log$4 = serverLog.getLogger('dynamodb:table');
const methods = ['get', 'put', 'query', 'update'];

/**
 * This helps significantly reduce the amount of DynamoDB code duplication. Essentially, it reuses the TableName and automatically constructs typical DynamoDB commands from input parameters and regular methods.
 *
 * By using `transaction()`, a similar set of functions is available, except the entire transaction (set of commands) needs to be executed at the end.
 */

const table = function (db, TableName, options = {}) {
  const t = _.reduce(
    methods,
    (table, method) => {
      table[method] = async param => {
        const arg = {
          TableName,
          ...param,
          ...options
        };
        return db[method](arg)
      };
      return table
    },
    {}
  );
  async function getItem (Key, errorMsg) {
    log$4.debug('Getting item: \n%j', Key);
    try {
      const result = await t.get({ Key });
      if (errorMsg && !result.Item) {
        throw errorMsg
      }
      log$4.debug('Found item: %o', result.Item);
      return tools.fromDb(result.Item)
    } catch (err) {
      log$4.error(err);
      throw err
    }
  }
  async function queryItems (query) {
    const items = (await t.query(query)).Items;
    return tools.fromDb(items)
  }
  return {
    getItem,
    queryItems,
    async putItem (input) {
      const Item = tools.toDb(input);
      return t.put({ Item })
    },
    attributes (attributes) {
      return table(db, TableName, { AttributesToGet: attributes, ...options })
    },
    transaction () {
      const TransactItems = [];
      return {
        getItem,
        putItem (input) {
          TransactItems.push({
            Put: {
              TableName,
              Item: tools.toDb(input),
              ...options
            }
          });
        },
        updateItem (Key, args) {
          TransactItems.push({
            Update: {
              TableName,
              Key,
              ...tools.toDb(args)
            }
          });
        },
        deleteItem (Key, args) {
          TransactItems.push({
            Delete: {
              TableName,
              Key,
              ...tools.toDb(args)
            }
          });
        },
        attributes () {}, // we ignore this as we don't expect transactional gets
        items () {
          return TransactItems
        },
        async execute () {
          const result = await db.transactWrite({ TransactItems });
          if (result.err) {
            log$4.error('Error executing transaction: %j', result.err);
            throw result.err
          }
          log$4.debug('Database updated:\n%j', TransactItems);
          return TransactItems.length
        },
        transaction () {
          throw new Error(`Already in a transaction`)
        }
      }
    }
  }
};

function Core (db, userpool) {
  const tableName = process.env.DYN_TABLE;
  const table$1 = table(db, tableName);
  return {
    system: () => System(table$1, userpool),
    mani: (fingerprint) => Transactions(table$1, fingerprint, '')
  }
}

const SystemSchema = apolloServerLambda.gql`
  type SystemParameters {
    "The (monthly) (basic) income"
    income: Currency!
    "(monthly) demurrage in percentage (so 5.0 would be a 5% demurrage)"
    demurrage: NonNegativeFloat!
  }
  
  type Ledger {
    "The unique id of the ledger, the fingerprint of its public key."
    ledger: String!
    "The (armored) public key of this ledger"
    publicKeyArmored: String
    "A user readable alias for this ledger."
    alias: String
  }

  input LedgerRegistration {
    "The public key used to create the ledger."
    publicKeyArmored: String!
    "Payload that was signed as a challenge"
    payload: String!
    "Signature of the payload by the private key corresponding to this public key"
    signature: String!
    "Signature of the 'flipped' payload (the transaction opposite to the payload)"
    counterSignature: String! 
    "A publically available alias of this ledger."
    alias: String
  }

  type Jubilee {
    ledgers: Int
    demurrage: Currency!
    income: Currency!
  }
  
  type System {
    "The current income and demurrage settings, returns nothing when system hasn't been initialized yet"
    parameters: SystemParameters
    "Text to be signed by client to verify key ownership"
    challenge: String!
    "Find the public key corresponding to this (fingerprint) id"
    findkey(id: String!): Ledger
    "Register a new ledger, returns the id (fingerprint)"
    register(registration: LedgerRegistration!): String
  }

  type Admin {
    # apply demurrage and (basic) income to all accounts
    jubilee(ledger: String): Jubilee!
    # initialize the system
    init: String
  }

  type Query {
    # access to system internals
    system: System!
  }

  type Mutation {
    admin: Admin
  }
`;

var transactions$1 = apolloServerLambda.gql`
  type Transaction {
    "ID of the origin ledger (should be user account)"
    ledger: String!
    "ID of destination ledger"
    destination: String
    "The amount to transfer. Note that a negative amount means it will be decrease the balance on this ledger ('outgoing'), a positive amount is 'incoming'"
    amount: Currency!
    "The ledger balance after the transfer"
    balance: Currency!
    "The date when this transfer was initiated"
    date: DateTime!
    "If the transaction was based on a jubilee, this show the proportion due to income."
    income: Currency
    "If the transaction was based on a jubilee, this show the proportion due to demurrage."
    demurrage: Currency
    "A unique representation of transaction used to create signatures"
    challenge: String
    "An (optional) message that was added to the transaction"
    message: String
    "Set to true if the ledger still needs to sign. (The destination may or may not have already provided a counter-signature.)"
    toSign: Boolean
  }
  
  type LedgerQuery {
    transactions: TransactionQuery
    # to add: notifications, issuedBuffers, standingOrders, contacts, demurageHistory
  }
  
  input Proof {
    payload: String!
    "Signature of the payload by the private key corresponding to this public key"
    signature: String!
    "Signature of the 'flipped' payload (the transaction opposite to the payload)"
    counterSignature: String! 
  }

  type TransactionQuery {
    "Current transaction aka the current balance of the ledger"
    current: Transaction
    "Pending transaction (note: use the signing interface to sign, not this informative entry)"
    pending: Transaction
    "Most recent transactions"
    recent: [Transaction]
    "Provide transaction challenge with supplied destination and amount"
    challenge(destination: String, amount: Currency): String
    "Create (pending) transaction"
    create(proof: Proof!): String
    "Confirm pending transaction"
    confirm(proof: Proof!): String
    "Cancel the currently pending transaction, matching this challenge."
    cancel(challenge: String!): String!
  }

  type Query {
    "All ledger related queries"
    ledger(id: String!): LedgerQuery
  }
`;

const schema = apolloServerLambda.gql`
  scalar DateTime
  scalar NonNegativeFloat
  scalar Currency
  
  type Query {
    time: DateTime!
  }
`;

var typeDefs = merge.mergeTypeDefs([schema, SystemSchema, transactions$1]);

const currency = new graphql.GraphQLScalarType({
  name: 'Currency',
  description: 'Custom scalar type for working consistently with currency-style fractions',
  // value sent to the client
  serialize (value) {
    if (value instanceof Mani) {
      return value.format()
    } else {
      // note that this is quite permissive and will even allow something like "MANI 10 00,5" as input
      return mani(value).format()
    }
  },
  // value from the client
  parseValue (value) {
    return mani(value)
  },
  // value from client in AST representation
  parseLiteral (ast) {
    if (ast.kind !== language.Kind.STRING || ast.kind !== language.Kind.INT || ast.kind !== language.Kind.FLOAT) {
      throw new TypeError(
        `Unknown representation of currency ${'value' in ast && ast.value}`
      )
    }
    return mani(ast.value)
  }
});

const log$3 = serverLog.getLogger('graphql:system');

var system = {
  Query: {
    'system': (_, args, { core }) => {
      return core.system()
    }
  },
  'Mutation': {
    'admin': (_, args, { core, admin, ledger }) => {
      if (!admin) {
        log$3.error(`Illegal system access attempt by ${ledger}`);
        throw new apolloServer.ForbiddenError('Access denied')
      }
      return core.system()
    }
  },
  'System': {
    'register': async (system, { registration }) => {
      return system.register(registration)
    },
    'parameters': async (system) => {
      return system.parameters()
    },
    'challenge': async (system) => {
      return system.challenge()
    },
    'findkey': async (system, { id }) => {
      return system.findkey(id)
    }
  },
  'Admin': {
    'init': async (system) => {
      return system.init()
    },
    'jubilee': async (system, { ledger }) => {
      return system.jubilee(ledger)
    }
  }
};

const log$2 = serverLog.getLogger('graphql:transactions');

var transactions = {
  Query: {
    ledger: (_, { id }) => {
      return id // optional: check if this even exists?
    }
  },
  LedgerQuery: {
    transactions: (id, arg, { core, ledger }) => {
      if (id !== ledger) {
        const err = `Illegal access attempt detected from ${ledger} on ${id}`;
        log$2.error(err);
        throw new apolloServer.ForbiddenError(err)
      }
      return core.mani(id)
    }
  },
  TransactionQuery: {
    current: async transactions => {
      return transactions.short().current()
    },
    pending: async transactions => {
      const pending = await transactions.pending();
      if (pending) {
        return {
          ...pending,
          message: 'Pending',
          toSign: _.isEmpty(pending.signature)
        }
      }
    },
    recent: async transactions => {
      log$2.debug(
        'recent transactions requested for %s',
        transactions.fingerprint
      );
      return transactions.short().recent()
    },
    challenge: async (transactions, { destination, amount }) => {
      return transactions.challenge(destination, amount)
    },
    create: async (transactions, { proof }) => {
      return transactions.create(proof)
    },
    confirm: async (transactions, { proof }) => {
      return transactions.confirm(proof)
    },
    cancel: async (transactions, { challenge }) => {
      return transactions.cancel(challenge)
    }
  }
};

var resolvers = _.merge(
  {
    DateTime: graphqlScalars.DateTimeResolver,
    NonNegativeFloat: graphqlScalars.NonNegativeFloatResolver
  },
  { Currency: currency },
  {
    Query: {
      time: () => new Date(Date.now())
    }
  },
  system,
  transactions
);

// TODO: continue the pagination token
const CognitoUserPool = (UserPoolId) => {
  return {
    listJubileeUsers: async (PaginationToken) => {
      const provider = new AWS__default['default'].CognitoIdentityServiceProvider();
      provider.listUsersPromise = util.promisify(provider.listUsers);
      const params = {
        UserPoolId,
        PaginationToken,
        AttributesToGet: [ 'sub', 'username', 'cognito:user_status', 'status', 'ledger' ] // TODO: add extra verification/filters?
      };
      const cognitoUsers = await provider.listUsersPromise(params);
      if (cognitoUsers.err) {
        throw cognitoUsers.err
      }
      return cognitoUsers.data.Users.map(({ Username, Attributes }) => {
        return {
          username: Username,
          ..._.reduce(Attributes, (acc, att) => {
            acc[att.Name] = att.Value;
            return acc
          }, {})
        }
      })
    }
  }
};

const log$1 = serverLog.getLogger('lambda:offlineuserpool');

/**
 * For offline development only!
 *
 * Expected format of user records:
 *
 * { ledger: '<fingerprint>'}
 */
const OfflineUserPool = (path = '.jubilee.users.json') => {
  const contents = fs__default['default'].readFileSync(path, { encoding: 'utf-8' });
  if (!contents) log$1.error(`Please make sure ${path} is present`);
  const jubilee = JSON.parse(contents);
  log$1.info(`Loaded jubilee users from ${path}`);
  return {
    // Users that have been added to the "jubilee" group
    async listJubileeUsers () {
      return jubilee
    }
  }
};

const log = serverLog.getLogger('lambda:handler');

function contextProcessor (event) {
  const { headers } = event;
  // fake the cognito interface if offline
  let claims = process.env.IS_OFFLINE
    ? JSON.parse(headers['x-claims'])
    : event.requestContext.authorizer.claims;
  log.debug('User claims: %j', claims);
  return {
    ledger: claims.sub,
    verified: claims.verified,
    admin: claims.admin
  }
}

log.info(`Starting ApolloServer with DEBUG = ${process.env.DEBUG}`);
const server = new apolloServerLambda.ApolloServer({
  debug: process.env.DEBUG === 'true',
  introspection: process.env.DEBUG === 'true',
  typeDefs,
  resolvers,
  formatError: err => {
    log.error(err, err.stack);
    return err
  },
  context: async ({ event, context }) => {
    return {
      core: Core(
        dynamoPlus.DynamoPlus({
          region: process.env.DYN_REGION,
          endpoint: process.env.DYN_ENDPOINT
        }),
        process.env.IS_OFFLINE
          ? OfflineUserPool()
          : CognitoUserPool(process.env.USER_POOL)
      ),
      ...contextProcessor(event)
    }
  }
});

function graphqlHandler (event, context, callback) {
  server.createHandler({
    cors: {
      origin: '*',
      credentials: true
    }
  })(event, context, callback);
}

exports.graphqlHandler = graphqlHandler;
