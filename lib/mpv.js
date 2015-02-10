"use strict";

var Q = require('q'),
    os = require('os'),
    fs = require('fs'),
    net = require('net'),
    tmp = require('tmp'),
    util = require('util'),
    jsesc = require('jsesc'),
    events = require('events'),
    buffertools = require('buffertools'),
    child_process = require('child_process');

function mpv (settings, cb) {
    var self = this;

    this.settings = settings || {};

    if (cb)
        this.once('started', cb);

    this.setSocketPath()
    .then(this.launch.bind(this))
    .done();

    this.on('ipcReady', this.openSocket.bind(this));
}

util.inherits(mpv, events.EventEmitter);

mpv.prototype.setSocketPath = function () {
    var self = this;

    if (this.settings.socketPath)
        return Q(true);

    return Q.ninvoke(tmp, 'tmpName').then(function(path){
        self.settings.socketPath = path;
    });
};

mpv.prototype.openSocket = function () {
    var self = this;
    var socket = this.socket = new net.Socket();
    socket.on("data", this.onSocketData.bind(this));
    return Q.ninvoke(socket, 'connect', this.settings.socketPath).then(this.gotConnection.bind(this));
};

mpv.prototype.bufferMessage = function (message) {
    if (!this.messageBuffer)
        this.messageBuffer = [];
    this.messageBuffer.push(message);
};

mpv.prototype.sendMessage = function (message, cb) {
    if (!this.socket)
        return this.bufferMessage(message);
    this.socket.write(JSON.stringify(message) + "\n");
    if (!this.cbQueue)
        this.cbQueue = [];
    this.cbQueue.push(cb);
};

mpv.prototype.dequeueMessages = function () {
    if (!this.messageBuffer)
        return;
    while (this.messageBuffer.length)
        this.sendMessage(this.messageBuffer.shift());
};

mpv.prototype.gotConnection = function () {
    this.emit("started");
    this.dequeueMessages();
};

mpv.prototype.onSocketData = function (data) {
    if (!this.socketBuffer)
        this.socketBuffer = data;
    else
        this.socketBuffer = Buffer.concat([this.socketBuffer, data]);

    var pos;
    var startPos = 0;
    while (startPos != -1 && (pos = buffertools.indexOf(this.socketBuffer, '\n', startPos)) != -1)
    {
        try {
            var str = this.socketBuffer.toString('utf8', startPos, pos);
            str = jsesc(str, {quotes: false});
            this.onSocketMessage(JSON.parse(str));
        } catch (e) {
            this.emit('error', e);
        }

        startPos = buffertools.indexOf(this.socketBuffer, '{', pos);
    }

    if (startPos > 0)
        this.socketBuffer = this.socketBuffer.slice(startPos);
    else if (startPos == -1)
        this.socketBuffer = undefined;
};

mpv.prototype.onSocketMessage = function (data) {
    this.emit("socketMessage", data);
    if (data.event)
        return this.emit('mpv.' + data.event, data);
    if (!this.cbQueue)
        return; //wat
    var cb = this.cbQueue.shift();
    if (cb)
        cb(data);
};

mpv.prototype.launch = function () {
    var self = this;
    var args = [
        '--no-config',
        '--input-unix-socket', this.settings.socketPath,
        '--idle'
    ].concat(this.settings.mpvArgs || []);
    var proc = this.proc =
        child_process.spawn(this.settings.mpvPath || 'mpv',
                            args, {stdio: 'pipe'});

    var killListener = function () {
        proc.kill();
    };

    process.on('exit', killListener);

    proc.on('exit', function () {
        self.emit('processExited');
        if (!self.terminated && self.respawn) {
            self.launch();
            self.reconfigure();
        }
        process.removeListener('exit', killListener);
    });

    proc.stdout.on("data", function (data) {
        if (data.toString() == "[ipc] Starting IPC master\n")
            self.emit("ipcReady");
    });
};

module.exports = mpv;
