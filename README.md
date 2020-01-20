# Shop-Status in Workers

## Workers

At most general level, a Worker refers to a script that runs on a different thread than the main one. This is unlike scripts loaded with a `<script />` tag in a browser.

Web Workers are an isolated environment that is insulated from the `window` object, the `document` object, direct internet access and is best suited for long-running or demanding computational tasks.

Service workers are a type of Worker that specifically used to as a proxy between the browser and the network and/or cache.

### How Web Workers work

To create a service worker you run use the `Worker` constructor.

```ts
// somewhere from main thread, ie: index.html
const worker = new Worker("./path/to/worker.js");
```

We can then communicate this Worker from the main thread by using the `postMessage` interface.

```ts
// main thread
worker.postMessage("Hey worker!");
```

We can receive this event in the worker using `onmessage`.

```ts
// worker script
onmessage = function(event) {
  console.log(event.data); // "Hey worker!"
  postMessage("Hey main thread!");
};

// back in main thread
worker.onmessage = function(event) {
  console.log(event.data); // "Hey main thread!"
};
```

Workers can import modules using `importScripts()` which does not return until all the scripts have been loaded and executed.

Data passed between the main page and workers is copied, not shared. Objects are serialized as they're handed to the worker, and subsequently, de-serialized on the other end.

#### Web Workers @Shopify

At Shopify, we provide tooling to make it easier to work with the Web Worker API. There are three parts that must be used together, all exported from [`@shopify/web-worker`](https://github.com/Shopify/quilt/tree/master/packages/web-worker).

1. The public API of the package provided by `@shopify/web-worker`
2. A webpack plugin provided by `@shopify/web-worker/webpack`
3. A babel plugin provided by `@shopify/web-worker/babel`

When @shopify/web-worker, you can create workers with the `createWorkerFactory` function.

```ts
import { createWorkerFactory } from "@shopify/web-worker";

const createWorker = createWorkerFactory(() => import("./worker"));

const worker = createWorker();

// Assuming `./worker.ts` was:
// export default function hello(name) {
//   return `Hello, ${name}`;
// }
//
// export function getName(user) {
//   return user.getDisplayName();
// }

const result = await worker.default(
  await worker.getName({
    getDisplayName: () => "Tobi"
  })
); // 'Hello, Tobi'
```

You can also supply the `createMessenger` option to the function provided by `createWorkerFactory`. This option should be a function that accepts a URL object for the location of the worker script, and return a `MessageEndpoint` compatible with being passed to [`@shopify/rpc`](https://github.com/Shopify/quilt/tree/master/packages/rpc)’s `createEndpoint` API.

The power of the createWorkerFactory library is that it automatically wraps the Worker in an Endpoint from `@shopify/rpc`. This allows the seamless calling of module methods from the main thread to the worker, and the ability to pass non-serializable constructs, like functions.

#### Webpack

For long-term caching, it is better to provide a static name for the worker file. This can be done by supplying the webpackChunkName comment before your import:

```ts
import {createWorkerFactory, terminate} from '@shopify/web-worker';

const createWorker = createWorkerFactory(() =>
import(/_ webpackChunkName: 'myWorker' _/ './worker'),
);

// Something like `new URL(__webpack_public_path__ + 'myWorker.worker.js')`
console.log(createWorker.url);
```

The exported functions from your module form its public API, which the main thread code will call into as shown above.

Note: https://github.com/Shopify/quilt/tree/master/packages/rpc#memory

To support this library we need to use webpack and configure it using the `WebWorkerPlugin` from `@shopify/web-worker/webpack`.

```
import {WebWorkerPlugin} from '@shopify/web-worker/webpack';

const webpackConfig = {
  // rest of webpack config...
  plugins: [new WebWorkerPlugin()],
  module: {
    rules: [
      {
        test: /\.js/,
        exclude: /node_modules/,
        use: [
          {
            loader: 'babel-loader',
            options: {
              babelrc: false,
              plugins: [require.resolve('@shopify/web-worker/babel')],
            },
          },
        ],
      },
    ],
  },
};
```

The @shopify/web-worker/babel Babel plugin looks for any instances of calling createWorkerFactory. For each one, it looks for the nested import() call, and then for the imported path (e.g., ./worker). It then replaces the first argument to createWorkerFactory with an import for the worker module that references a custom Webpack loader:

```
import {createWorkerFactory} from '@shopify/web-worker';
createWorkerFactory(() => import('./worker'));

// becomes something like:
import {createWorkerFactory} from '@shopify/web-worker';
import workerStuff from '@shopify/web-worker/webpack-loader!./worker';
createWorkerFactory(workerStuff);
```

That syntax creates a new module that wraps the exported module in `expose`

// This is the imaginary module the loader creates and compiles
import {expose} from '@shopify/web-worker';
import \* as api from './worker';
expose(api);

This module is compiled in a child webpack compiler and makes that the exported data from the original `./worker` module.  Finally, createWorkerFactory() takes this metadata (which includes the main script tag that should be loaded in the worker) and, when called, creates a new Worker instance using a Blob that simply importScripts the main script for the worker.

## Workers on Cloudflare

Cloudflare Workers are written in JavaScript, executed using the V8 JavaScript engine (used by Chromium and Node.js) on the Cloudflare edge network. The V8 JavaScript engine is very secure and well sandboxed because it is built by smart Chrome developers and Google Pay has a huge bounty for security vulnerabilities.

A Service Worker implements an endpoint: it registers one event handler which receives requests and responds to those requests. That handler, though, is asynchronous, meaning it can do other I/O before producing a response. Among other things, it can make its own HTTP requests (which we call "subrequests"). So, a simple service worker can modify the original request, forward it to the origin as a subrequest, receive a response, modify that, and then return it: everything the hooks model can do.
But a Service Worker is much more powerful. It can make multiple subrequests, in series or in parallel, and combine the results. It can respond directly without making a subrequest at all. It can even make an asynchronous subrequest after it has already responded to the original request. A Service Worker can also directly manipulate the cache through the Cache API. So, there's no need for "pre cache" and "post cache" hooks. You just stick the cache lookup into your code where you want it.
To add icing to the cake, the Service Worker API, and related modern web APIs like Fetch and Streams, have been designed very carefully by some incredibly smart people. It uses modern JavaScript idioms like Promises, and it is well-documented by MDN and others. Had we designed our own API, it would surely have been worse on all counts.
It quickly became obvious to us that the Service Worker API was the correct API for our use case.

### KV

- Local key value storage
- Best in write relatively infrequently, but read quickly and frequently. Very infrequently read values are stored centrally, while more popular values are maintained in all of our data centers around the world.
