'use strict';

// Koa整个流程可以分成三步:
// 【1.初始化阶段】
// new初始化一个实例，use添加中间件到middleware数组，listen 合成中间件fnMiddleware，返回一个callback函数给http.createServer，开启服务器，等待http请求。
// 【2.请求阶段】
// 每次请求，createContext生成一个新的ctx，传给fnMiddleware，触发中间件的整个流程。
// 【3.响应阶段】
// 整个中间件完成后，调用respond方法，对请求做最后的处理，返回响应给客户端。

// application.js是koa的主入口，也是核心部分，主要干了以下几件事情：
// 1. 启动框架
// 2. 实现洋葱模型中间件机制
// 3. 封装高内聚的context
// 4. 实现异步函数的统一错误处理机制

const isGeneratorFunction = require('is-generator-function');
const debug = require('debug')('koa:application');
const onFinished = require('on-finished');
const response = require('./response');
const compose = require('koa-compose');
const context = require('./context');
const request = require('./request');
const statuses = require('statuses');
const Emitter = require('events');
const util = require('util');
const Stream = require('stream');
const http = require('http');
const only = require('only');
const convert = require('koa-convert');
const deprecate = require('depd')('koa');
const {
    HttpError
} = require('http-errors');

// 当实例化koa的时候，koa做了以下2件事：
// 继承Emitter，具备处理异步事件的能力。然而koa是如何处理，现在还不得而知，这里打个问号。
// 在创建实例过程中，有三个对象作为实例的属性被初始化，分别是context、request、response。还有我们熟悉的存放中间件的数组mddleware。这里需要注意，是使用Object.create(xxx)对this.xxx进行赋值。

module.exports = class Application extends Emitter {
    constructor(options) {
        super();
        options = options || {};
        this.proxy = options.proxy || false;
        this.subdomainOffset = options.subdomainOffset || 2;
        this.proxyIpHeader = options.proxyIpHeader || 'X-Forwarded-For';
        this.maxIpsCount = options.maxIpsCount || 0;
        this.env = options.env || process.env.NODE_ENV || 'development';
        if (options.keys) this.keys = options.keys;

        this.middleware = []; //中间件数组
        // 通过context.js、request.js、response.js创建对应的context、request、response
        // Object.create(xxx)作用：根据xxx创建一个新对象，并且将xxx的属性和方法作为新的对象的proto。
        this.context = Object.create(context);
        this.request = Object.create(request);
        this.response = Object.create(response);
        // 以context为例，其实是创建一个新对象，使用context对象来提供新创建对象的proto，并且将这个对象赋值给this.context，实现了类继承的作用。为什么不直接用this.context=context呢？这样会导致两者指向同一片内存，而不是实现继承的目的。

        if (util.inspect.custom) {
            this[util.inspect.custom] = this.inspect;
        }
    }

    // 创建服务器
    // 这里使用了node原生http.createServer创建服务器，并把this.callback()作为参数传递进去。可以知道，this.callback()返回的一定是这种形式：(req, res) => {}。
    listen(...args) {
        debug('listen');
        const server = http.createServer(this.callback()); //this.callback()是需要重点关注的部分，其实对应了http.createServer的参数(req, res)=> {}
        return server.listen(...args);
    }

    toJSON() {
        return only(this, [
            'subdomainOffset',
            'proxy',
            'env'
        ]);
    }

    inspect() {
        return this.toJSON();
    }

    // 通过调用koa应用实例的use函数
    // 当我们执行app.use的时候，koa做了这2件事情：
    // 1. 判断是否是generator函数，如果是，使用koa-convert做转换（koa3将不再支持generator）。
    // 2. 所有传入use的方法，会被push到middleware中。
    use(fn) {
        if (typeof fn !== 'function') throw new TypeError('middleware must be a function!');
        // koa2处于对koa1版本的兼容，中间件函数如果是generator函数的话，会使用koa-convert进行转换为“类async函数”。
        if (isGeneratorFunction(fn)) {
            // 如何将generator函数转为类async函数?
            // generator和async有什么区别？唯一的区别就是async会自动执行，而generator每次都要调用next函数。
            // 如何让generator自动执行next函数？我们只要找到一个合适的方法让g.next()一直持续下去就可以自动执行了。
            // 所以问题的关键在于yield的value必须是一个Promise。那么我们来看看co是如何把这些都东西都转化为Promise的：
            // 【co的思想】
            // 把一个generator封装在一个Promise对象中，然后再这个Promise对象中再次把它的gen.next()也封装出Promise对象，相当于这个子Promise对象完成的时候也重复调用gen.next()。当所有迭代完成时，把父Promise对象resolve掉。这就成了一个类async函数了。
            deprecate('Support for generators will be removed in v3. ' +
                'See the documentation for examples of how to convert old middleware ' +
                'https://github.com/koajs/koa/blob/master/docs/migration.md');
            fn = convert(fn);
        }
        debug('use %s', fn._name || fn.name || '-');
        this.middleware.push(fn);
        return this;
    }

    // 返回一个类似(req, res) => {}的函数，该函数会作为参数传递给上文的listen函数中的http.createServer函数，作为请求处理的函数

    // 1. compose(this.middleware)做了什么事情（使用了koa-compose包）
    // 2. 如何实现洋葱式调用的？
    // 3. context是如何处理的？createContext的作用是什么？
    // 4. koa的统一错误处理机制是如何实现的？
    callback() {
        const fn = compose(this.middleware); // 将所有传入use的函数通过koa-compose组合一下
        // Koa使用了koa-compose实现了中间件机制，源码如下：

        function compose(middleware) {
            return function(context, next) {
                let index = -1
                return dispatch(0)

                function dispatch(i) {
                    if (i <= index) return Promise.reject(new Error('next() called multiple times'))
                    index = i
                    let fn = middleware[i]
                    if (i === middleware.length) fn = next
                    if (!fn) return Promise.resolve()
                    try {
                        return Promise.resolve(fn(context, dispatch.bind(null, i + 1)));
                    } catch (err) {
                        return Promise.reject(err)
                    }
                }
            }
        }

        // compose函数接收middleware数组作为参数，middleware中每个对象都是async函数，返回一个以context和next作为入参的函数，我们跟源码一样，称其为fnMiddleware
        // 在外部调用this.handleRequest的最后一行，运行了中间件：fnMiddleware(ctx).then(handleResponse).catch(onerror);

        // 【next到底是啥？洋葱模型是怎么实现的？】
        // next就是一个包裹了dispatch的函数
        // 在第n个中间件中执行next，就是执行dispatch(n+1)，也就是进入第n+1个中间件
        // 因为dispatch返回的都是Promise，所以在第n个中间件await next(); 进入第n+1个中间件。
        // 当第n+1个中间件执行完成后，可以返回第n个中间件
        // 如果在某个中间件中不再调用next，那么它之后的所有中间件都不会再调用了


        // 中间件执行顺序原理：
        // 0：fnMiddleware(ctx)运行；
        // 0： 执行dispatch(0)；
        // 0： 进入dispatch函数，此时，fn就是第一个中间件，它是一个async函数，async函数会返回一个Promise对象，Promise.resolve()中若传入一个Promise对象的话，那么Promise.resolve将原封不动地返回这个Promise对象。
        // 0：进入到第一个中间件代码内部，先执行“console.log(“1-start”)”
        // 0：然后执行“await next()”，并开始等待next执行返回
        // 1：进入到next函数后，执行的是dispatch(1)，于是老的dispatch(0)压栈，开始从头执行dispatch(1)，即把第二个中间件函数交给fn，然后开始执行，这就完成了程序的控制权从第一个中间件到第二个中间件的转移。下图是执行dispatch(1)时函数内变量的值：
        // 1：进入到第二个中间件代码内部，先执行“console.log(“2-start”)”。然后执行“await next()”并等待next执行返回
        // 2：进入next函数后，主要执行dispatch(2)，于是老的dispatch(1)压栈，从头开始执行dispatch(2)。返回Promise.resolve()， 此时第二个中间件的next函数返回了。
        // 2： 所以接下来执行“ console.log(“2 - end”)”
        // 1： 由此第二个中间件执行完成， 把程序控制权交给第一个中间件。 第一个中间件执行“ console.log(“1 - end”)”
        // 0： 终于完成了所有中间件的执行， 如果中间没有异常， 则返回Promise.resolve()， 执行handleResponse回调； 如有异常， 则返回Promies.reject(err)， 执行onerror回调。

        if (!this.listenerCount('error')) this.on('error', this.onerror);

        const handleRequest = (req, res) => {
            const ctx = this.createContext(req, res); //  基于req、res封装出更强大的ctx
            return this.handleRequest(ctx, fn);
        };

        return handleRequest;
    }


    handleRequest(ctx, fnMiddleware) {
        const res = ctx.res;
        res.statusCode = 404;

        // application.js也有onerror函数，但这里使用了context的onerror，
        // 出错执行的回调函数是context.js的onerror函数，因为使用了this.app.emit('error', err, this)，因此在app上监听onerror事件，就能处理所有中间件的错误
        const onerror = err => ctx.onerror(err);
        const handleResponse = () => respond(ctx);
        onFinished(res, onerror);

        // 这里是中间件如果执行出错的话，都能执行到onerror的关键！！！

        // Koa异常捕获的两种方式：
        // 1. 中间件捕获(Promise catch)，如以下代码 fnMiddleware(ctx).then(handleResponse).catch(onerror)
        // 捕获全局异常的中间件
        // app.use(async(ctx, next) => {
        //         try {
        //             await next()
        //         } catch (error) {
        //             return ctx.body = 'error'
        //         }
        //     })
        // 2. 框架捕获(Emitter error)，Application继承原生的Emitter，从而实现error监听
        // 事件监听
        // app.on('error', err => {
        //     console.log('error happends: ', err.stack);
        // });

        // koa为什么能实现异步函数的统一错误处理？
        // 1. sync函数返回一个Promise对象
        // 2. async函数内部抛出错误，会导致Promise对象变为reject状态。抛出的错误会被catch的回调函数(上面为onerror)捕获到。
        // 3. await命令后面的Promise对象如果变为reject状态，reject的参数也可以被catch的回调函数(上面为onerror)捕获到。
        return fnMiddleware(ctx).then(handleResponse).catch(onerror);
    }

    // context使用node原生的http监听回调函数中的req、res来进一步封装，意味着对于每一个http请求，koa都会创建一个context并共享给所有的全局中间件使用，当所有的中间件执行完后，会将所有的数据统一交给res进行返回。所以，在每个中间件中我们才能取得req的数据进行处理，最后ctx再把要返回的body给res进行返回。
    // 请记住句话：每一个请求都有唯一一个context对象，所有的关于请求和响应的东西都放在其里面。

    createContext(req, res) {
        // context必须作为一个临时对象存在，所有的东西都必须放进一个对象
        // 使用了Object.create的方法创建一个全新的对象，通过原型链继承原来的属性。这样可以有效的防止污染原来的对象。
        const context = Object.create(this.context);
        const request = context.request = Object.create(this.request);
        const response = context.response = Object.create(this.response);

        // 为什么app、req、res、ctx也存放在了request、和response对象中呢？
        // 使它们同时共享一个app、req、res、ctx，是为了将处理职责进行转移，当用户访问时，只需要ctx就可以获取koa提供的所有数据和方法，而koa会继续将这些职责进行划分，比如request是进一步封装req的，response是进一步封装res的，这样职责得到了分散，降低了耦合度，同时共享所有资源使context具有高内聚的性质，内部元素互相能访问到。
        context.app = request.app = response.app = this;
        context.req = request.req = response.req = req;
        context.res = request.res = response.res = res;
        request.ctx = response.ctx = context;
        request.response = response;
        response.request = request;
        context.originalUrl = request.originalUrl = req.url;
        context.state = {}; //这里的state是专门负责保存单个请求状态的空对象，可以根据需要来管理内部内容。
        return context;
    }

    onerror(err) {
        const isNativeError =
            Object.prototype.toString.call(err) === '[object Error]' ||
            err instanceof Error;
        if (!isNativeError) throw new TypeError(util.format('non-error thrown: %j', err));

        if (404 === err.status || err.expose) return;
        if (this.silent) return;

        const msg = err.stack || err.toString();
        console.error(`\n${msg.replace(/^/gm, '  ')}\n`);
    }
};

function respond(ctx) {
    if (false === ctx.respond) return;

    if (!ctx.writable) return;

    const res = ctx.res;
    let body = ctx.body;
    const code = ctx.status;

    if (statuses.empty[code]) {
        // strip headers
        ctx.body = null;
        return res.end();
    }

    if ('HEAD' === ctx.method) {
        if (!res.headersSent && !ctx.response.has('Content-Length')) {
            const {
                length
            } = ctx.response;
            if (Number.isInteger(length)) ctx.length = length;
        }
        return res.end();
    }

    if (null == body) {
        if (ctx.response._explicitNullBody) {
            ctx.response.remove('Content-Type');
            ctx.response.remove('Transfer-Encoding');
            return res.end();
        }
        if (ctx.req.httpVersionMajor >= 2) {
            body = String(code);
        } else {
            body = ctx.message || String(code);
        }
        if (!res.headersSent) {
            ctx.type = 'text';
            ctx.length = Buffer.byteLength(body);
        }
        return res.end(body);
    }

    if (Buffer.isBuffer(body)) return res.end(body);
    if ('string' === typeof body) return res.end(body);
    if (body instanceof Stream) return body.pipe(res);

    body = JSON.stringify(body);
    if (!res.headersSent) {
        ctx.length = Buffer.byteLength(body);
    }
    res.end(body);
}

module.exports.HttpError = HttpError;