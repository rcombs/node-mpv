'use strict';

var Q = require('q'),
    os = require('os'),
    fs = require('fs'),
    net = require('net'),
    tmp = require('tmp'),
    util = require('util'),
    jsesc = require('jsesc'),
    events = require('events'),
    commands = require('./commands'),
    buffertools = require('buffertools'),
    child_process = require('child_process'),
    LineReader = require('stream-line').LineReader;

function mpv (settings, cb) {
    var self = this;

    this.settings = settings || {};

    if (cb)
        this.once('started', cb);

    this.setSocketPath()
    .then(this.launch.bind(this))
    .done();

    this.on('ipcReady', this.openSocket.bind(this));

    for (var i = 0; i < commands.length; i++) {
        var cmd = commands[i];
        this[cmd] = this.sendCommand.bind(this, cmd);
    }
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
    socket.on('data', this.onSocketData.bind(this));
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
    this.socket.write(JSON.stringify(message) + '\n');
    if (!this.cbQueue)
        this.cbQueue = [];

    if (cb) {
        this.cbQueue.push(cb);
    } else {
        return Q.Promise(function (resolve, reject) {
            this.cbQueue.push(function (data) {
                if (data.error == 'success')
                    resolve(data.data);
                else
                    reject(data);
            });
        }.bind(this));
    }
};

mpv.prototype.sendCommand = function () {
    return this.sendMessage({command: Array.prototype.slice.call(arguments)});
};

mpv.prototype.dequeueMessages = function () {
    if (!this.messageBuffer)
        return;
    while (this.messageBuffer.length)
        this.sendMessage(this.messageBuffer.shift());
};

mpv.prototype.gotConnection = function () {
    this.emit('started');
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
    this.emit('socketMessage', data);
    if (data.event) {
        this.emit('mpv.event', data);
        return this.emit('mpv.' + data.event, data);
    }
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
        '--msg-level=ipc=v',
        '--input-ipc-server', this.settings.socketPath,
        '--idle=yes'
    ].concat(this.settings.mpvArgs || []);
    var proc = this.proc =
        child_process.spawn(this.settings.mpvPath || 'mpv',
                            args, {stdio: ['ignore', 'pipe', 'ignore']});

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

    var lineReader = new LineReader(proc.stdout);

    lineReader.on('readable', function () {
        while (lineReader.readable)
            if (lineReader.readLine() == '[ipc] Starting IPC master')
                self.emit('ipcReady');
    });
};

module.exports = mpv;
