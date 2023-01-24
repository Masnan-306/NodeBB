// 'use strict';

import express from 'express';

/*
 * Logger module: ability to dynamically turn on/off logging for http requests & socket.io events
 */

import fs = require('fs');
import path = require('path');
import winston = require('winston');
import util = require('util');
import morgan = require('morgan');

import file = require ('./file');
import meta = require ('./meta');
import { Express } from 'express-serve-static-core';


const opts = {
    /*
     * state used by Logger
     */
    express: {
        app: express(),
        set: 0 as number,
        ofn: null,
    },
    streams: {
        log: { f: process.stdout },
    },
};

/* -- Logger -- */
export const Logger = {
    init: function (app: Express) {
        opts.express.app = app;
        /* Open log file stream & initialize express logging if meta.config.logger* variables are set */
        Logger.setup();
    },
    setup: function () {
        Logger.setup_one('loggerPath', meta.config.loggerPath);
    },
    setup_one: function (key : string, value: any) {
        /*
         * 1. Open the logger stream: stdout or file
         * 2. Re-initialize the express logger hijack
         */
        if (key === 'loggerPath') {
            Logger.setup_one_log(value);
            Logger.express_open();
        }
    },
    setup_one_log: function (value) {
        /*
         * If logging is currently enabled, create a stream.
         * Otherwise, close the current stream
         */
        if (meta.config.loggerStatus > 0 || meta.config.loggerIOStatus) {
            const stream = Logger.open(value);
            if (stream) {
                opts.streams.log.f = stream;
            } else {
                opts.streams.log.f = process.stdout;
            }
        } else {
            Logger.close(opts.streams.log);
        }
    },
    open: function (value) {
        /* Open the streams to log to: either a path or stdout */
        let stream;
        if (value) {
            if (file.existsSync(value)) {
                const stats = fs.statSync(value);
                if (stats) {
                    if (stats.isDirectory()) {
                        stream = fs.createWriteStream(path.join(value, 'nodebb.log'), { flags: 'a' });
                    } else {
                        stream = fs.createWriteStream(value, { flags: 'a' });
                    }
                }
            } else {
                stream = fs.createWriteStream(value, { flags: 'a' });
            }
            if (stream) {
                stream.on('error', (err) => {
                    winston.error(err.stack);
                });
            }
        } else {
            stream = process.stdout;
        }
        return stream;
    },
    close: function (stream) {
        if (stream.f !== process.stdout && stream.f) {
            stream.end();
        }
        stream.f = null;
    },
    monitorConfig: function (socket: any, data: { key: string; value: any; }) {
        /*
         * This monitor's when a user clicks "save" in the Logger section of the admin panel
         */
        Logger.setup_one(data.key, data.value);
        Logger.io_close(socket);
        Logger.io(socket);
    },
    express_open: function () {
        if (opts.express.set !== 1) {
            opts.express.set = 1;
            opts.express.app.use(Logger.expressLogger);
        }
        /*
         * Always initialize "ofn" (original function) with the original logger function
         */
        opts.express.ofn = morgan('combined', { stream: opts.streams.log.f });
    },
    expressLogger: function (req, res, next) {
        /*
         * The new express.logger
         *
         * This hijack allows us to turn logger on/off dynamically within express
         */
        if (meta.config.loggerStatus > 0) {
            return opts.express.ofn(req, res, next);
        }
        return next();
    },
    prepare_io_string: function (_type : string, _uid : string, _args : any[]) {
        /*
         * This prepares the output string for intercepted socket.io events
         *
         * The format is: io: <uid> <event> <args>
         */
        try {
            return `io: ${_uid} ${_type} ${util.inspect(Array.prototype.slice.call(_args), { depth: 3 })}\n`;
        } catch (err) {
            winston.info('Logger.prepare_io_string: Failed', err);
            return 'error';
        }
    },
    io_close: function (socket) {
        /*
         * Restore all hijacked sockets to their original emit/on functions
         */
        if (!socket || !socket.io || !socket.io.sockets || !socket.io.sockets.sockets) {
            return;
        }
        const clientsMap = socket.io.sockets.sockets;
        for (const [, client] of clientsMap) {
            if (client.oEmit && client.oEmit !== client.emit) {
                client.emit = client.oEmit;
            }
            if (client.$onevent && client.$onevent !== client.onevent) {
                client.onevent = client.$onevent;
            }
        }
    },
    io: function (socket) {
        /*
         * Go through all of the currently established sockets & hook their .emit/.on
         */
        if (!socket || !socket.io || !socket.io.sockets || !socket.io.sockets.sockets) {
            return;
        }
        const clientsMap = socket.io.sockets.sockets;
        for (const [, socketObj] of clientsMap) {
            Logger.io_one(socketObj, socketObj.uid);
        }
    },
    io_one: function (socket, uid) {
        /*
         * This function replaces a socket's .emit/.on functions in order to intercept events
         */
        function override(method, name: string, errorMsg: string) {
            return (...args) => {
                if (opts.streams.log.f) {
                    opts.streams.log.f.write(Logger.prepare_io_string(name, uid, args));
                }
                try {
                    method.apply(socket, args);
                } catch (err) {
                    winston.info(errorMsg, err);
                }
            };
        }
        if (socket && meta.config.loggerIOStatus > 0) {
            // courtesy of: http://stackoverflow.com/a/9674248
            socket.oEmit = socket.emit;
            const { emit } = socket;
            socket.emit = override(emit, 'emit', 'Logger.io_one: emit.apply: Failed');
            socket.$onvent = socket.onevent;
            const $onevent = socket.onevent;
            socket.onevent = override($onevent, 'on', 'Logger.io_one: $emit.apply: Failed');
        }
    },
};
