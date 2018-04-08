'use strict'

const WebSocket = require('uws')
const nodeReconnectWs = require('node-reconnect-ws') // https://www.npmjs.com/package/node-reconnect-ws
const util = require('util')
const winston = require('winston')
const path = require('path')
const Convert = require('ansi-to-html')
const protobuf = require('protobufjs')
const root = protobuf.loadSync(path.join(__dirname, '/log.proto'))
const LogMessage = root.lookupType('log.set')

// https://getuikit.com/assets/uikit/tests/text.html
const _colorClass = {
  error: 'uk-text-danger',
  warn: 'uk-text-warning',
  info: 'uk-text-success',
  verbose: 'uk-text-primary',
  debug: 'uk-text-muted',
  silly: 'uk-text-muted'
}

let convert
let ws
let _ws = {
  ready: false
}

const jsonPrettyPrint = { // http://blog.centerkey.com/2013/05/javascript-colorized-pretty-print-json.html
  replacer: function (match, pIndent, pKey, pVal, pEnd, error) {
    const key = '<span class=uk-text-primary>'
    const val = '<span class=uk-text-warning>'
    const str = '<span class=uk-text-success>'
    let r = pIndent || ''
    if (pKey) {
      r = r + key + pKey.replace(/[": ]/g, '') + '</span>: '
    }
    if (pVal) {
      r = r + (pVal[0] === '"' ? str : val) + pVal + '</span>'
    }
    return r + (pEnd || '')
  },
  toHtml: function (obj, error) {
    const jsonLine = /^( *)("[\w]+": )?("[^"]*"|[\w.+-]*)?([,[{])?$/mg
    return JSON.stringify(obj, null, 2)
      .replace(/&/g, '&amp;').replace(/\\"/g, '&quot;')
      .replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(jsonLine, jsonPrettyPrint.replacer)
  }
}

const wsconnect = function (url) {
  ws = new nodeReconnectWs({
    url: url,
    protocol: [],
    webSocket: WebSocket,
    reconnectInterval: 4000,
    autoConnect: true,
    maxRetries: Infinity
  })
  ws.on('open', function (user) {
    _ws.ready = true
  })
  ws.on('error', function (error) {
    console.warn('ws socket error', error.code)
    _ws.ready = false
  })
  ws.on('close', function (user) {
    // console.log('ws socket close')
    _ws.ready = false
  })
}

const LogeinWebsocket = winston.transports.LogeinWebsocket = function (options) {
  if (!options.url) throw new Error('Need Server url e.g. ws://localhost:30001')
  else wsconnect(options.url)

  this.name = options.name || path.basename(__filename) + ' ' + process.pid
  this.level = options.level || 'info'

  this.regex = options.regex || false
  this.colorize = options.colorize || false
  this.ConvertAnsi = options.ConvertAnsi || false

  this.colors = options.colors || {}
  convert = new Convert(options.ansiToHtml || {})

  this.MetaJsonMarkup = options.MetaJsonMarkup || false

  this.utilInspect = Object.assign({ // https://nodejs.org/api/util.html#util_util_inspect_object_options
    showHidden: false,
    depth: null,
    colors: this.colorize,
    breakLength: 1
  }, options.utilInspect)
}

util.inherits(LogeinWebsocket, winston.Transport)

const httpRegEx = /(\b(https?|ftp|file):\/\/[-A-Z0-9+&@#/%?=~_|!:,.;]*[-A-Z0-9+&@#/%=~_|])/igm
LogeinWebsocket.prototype.log = function (level, msg, meta, callback) {
  // Level
  if (this.colorize) {
    level = '<span class="' + _colorClass[level] + '">' + level + '</span>'
  }

  // Message
  if (meta instanceof Error) { // Error handle // https://github.com/jsumners/error-to-html
    msg += '<ul class="uk-list uk-list-divider" style="white-space:pre;">'
    msg += '<li class="uk-text-danger"><span class="uk-text-capitalize">message</span>: ' + meta.message + '</li>'
    msg += '<li class="uk-text-danger"><span class="uk-text-capitalize">stack</span>: ' + meta.stack + '</li>'

    for (let prop of Object.getOwnPropertyNames(meta)) {
      if (typeof meta === 'function') {
        continue
      }
      if (prop === 'message' || prop === 'stack') {
        continue
      }
      msg += '<li><span class="uk-text-capitalize">' + prop + '</span> ' + meta[prop] + '</li>'
    }
    msg += '</ul>'
  } else {
    if (this.regex) { // Parse text links into <a href> Links
      msg = msg.replace(httpRegEx, "<a target='_blank' href='$1'>$1</a>")
    }

    if (Object.keys(meta).length === 0) { // remove empty objects
      meta = false
    }

    if (meta) {
      if (typeof meta !== 'object') {
        if (msg.length !== 0) { msg += ' ' }
        msg += meta
      } else {
        if (msg.length !== 0) { msg += '<br>' }
        if (this.MetaJsonMarkup) { // Pretty JSON
          // msg += '<span style="white-space:pre;">' + util.inspect(meta, this.utilInspect) + '</span>'
          // msg += '<span style="white-space:pre;">' + JSON.stringify(meta, null, 2) + '</span>'
          msg += '<span style="white-space:pre;">' + jsonPrettyPrint.toHtml(meta) + '</span>'
        } else {
          msg += util.inspect(meta, this.utilInspect)
        }
      }
    }
  }

  let message = ''
  if (this.ConvertAnsi) {
    message += convert.toHtml(msg)
  } else {
    message += msg
  }

  let err = null
  if (_ws.ready) {
    const payload = { data: [{timestamp: Date.now(), app: this.name, lvl: level, msg: message}] }
    const errMsg = LogMessage.verify(payload)
    if (errMsg) {
      throw Error(errMsg)
    }
    ws.send(LogMessage.encode(LogMessage.create(payload)).finish())
  } else {
    err = 'ws disconnect'
  }
  callback(err, true)
}

module.exports = LogeinWebsocket
