'use strict';

// context.js主要干了两件事情：
// 1. 错误事件处理
// 2. 代理response对象和request对象的部分属性和方法

const util = require('util');
const createError = require('http-errors');
const httpAssert = require('http-assert');
const delegate = require('delegates');
const statuses = require('statuses');
const Cookies = require('cookies');
const context = require('./2 req-res-application封装/context');

const COOKIES = Symbol('context#cookies');


const proto = module.exports = {
    // context自身的方法
    inspect() {
        if (this === proto) return this;
        return this.toJSON();
    },

    toJSON() {
        return {
            request: this.request.toJSON(),
            response: this.response.toJSON(),
            app: this.app.toJSON(),
            originalUrl: this.originalUrl,
            req: '<original node req>',
            res: '<original node res>',
            socket: '<original node socket>'
        };
    },

    assert: httpAssert,
    throw (...args) {
        throw createError(...args);
    },

    onerror(err) {
        if (null == err) return;
        const isNativeError =
            Object.prototype.toString.call(err) === '[object Error]' ||
            err instanceof Error;
        if (!isNativeError) err = new Error(util.format('non-error thrown: %j', err));

        let headerSent = false;
        if (this.headerSent || !this.writable) {
            headerSent = err.headerSent = true;
        }
        // 这里的this.app是对application的引用，当context.js调用onerror时，其实是触发application实例的error事件 。该事件是基于“Application类继承自EventEmitter”这一事实。
        this.app.emit('error', err, this);
        if (headerSent) {
            return;
        }

        const {
            res
        } = this;
        if (typeof res.getHeaderNames === 'function') {
            res.getHeaderNames().forEach(name => res.removeHeader(name));
        } else {
            res._headers = {}; // Node < 7.7
        }

        // then set those specified
        this.set(err.headers);

        // force text/plain
        this.type = 'text';

        let statusCode = err.status || err.statusCode;

        // ENOENT support
        if ('ENOENT' === err.code) statusCode = 404;

        // default to 500
        if ('number' !== typeof statusCode || !statuses[statusCode]) statusCode = 500;

        // respond
        const code = statuses[statusCode];
        const msg = err.expose ? err.message : code;
        this.status = err.status = statusCode;
        this.length = Buffer.byteLength(msg);
        res.end(msg);
    },

    get cookies() {
        if (!this[COOKIES]) {
            this[COOKIES] = new Cookies(this.req, this.res, {
                keys: this.app.keys,
                secure: this.request.secure
            });
        }
        return this[COOKIES];
    },

    set cookies(_cookies) {
        this[COOKIES] = _cookies;
    }
};


if (util.inspect.custom) {
    module.exports[util.inspect.custom] = module.exports.inspect;
}

// 委托模式

// delegates库由大名鼎鼎的 TJ 所写，可以帮我们方便快捷地使用设计模式当中的委托模式（Delegation Pattern），即外层暴露的对象将请求委托给内部的其他对象进行处理

// delegates 基本用法就是将内部对象的变量或者函数绑定在暴露在外层的变量上，直接通过 delegates 方法进行如下委托，基本的委托方式包含：
// getter：外部对象可以直接访问内部对象的值
// setter：外部对象可以直接修改内部对象的值
// access：包含 getter 与 setter 的功能
// method：外部对象可以直接调用内部对象的函数

// delegates 原理就是__defineGetter__和__defineSetter__
// method是委托方法，getter委托getter,access委托getter和setter。

// 在application.createContext函数中，
// 被创建的context对象会挂载基于request.js实现的request对象和基于response.js实现的response对象。
// 下面2个delegate的作用是让context对象代理request和response的部分属性和方法

// context.request的许多属性都被委托在context上了
// context.response的许多方法都被委托在context上了

// 为什么response.js和request.js使用get set代理，而context.js使用delegate代理?
// 原因主要是: set和get方法里面还可以加入一些自己的逻辑处理。而delegate就比较纯粹了，只代理属性。

delegate(proto, 'response')
    .method('attachment')
    .method('redirect')
    .method('remove')
    .method('vary')
    .method('has')
    .method('set')
    // ......

delegate(proto, 'request')
    .method('acceptsLanguages')
    .method('acceptsEncodings')
    .method('acceptsCharsets')
    .method('accepts')
    .method('get')
    .method('is')
    // ......