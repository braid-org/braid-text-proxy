
const http = require('http');
const https = require('https');
const url = require('url');

let {diff_main} = require('./diff.js')

var braid_text = require("braid-text")

var braid_fetch = require('braid-http').fetch

var known_urls = {}

const port = process.argv[2] || 10000;
const cookie = process.argv[3] || null;
console.log(`cookie = ${cookie}`)

process.on("unhandledRejection", (x) => console.log(`unhandledRejection: ${x.stack}`))
process.on("uncaughtException", (x) => console.log(`uncaughtException: ${x.stack}`))

const server = http.createServer(async (req, res) => {
    console.log(`${req.method} ${req.url}`);

    if (req.url === '/favicon.ico') return;

    // Security check: Allow only localhost access
    const clientIp = req.socket.remoteAddress;
    if (clientIp !== '127.0.0.1' && clientIp !== '::1') {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Access denied: This proxy is only accessible from localhost');
        return;
    }

    // Free the CORS
    free_the_cors(req, res);
    if (req.method === 'OPTIONS') return;

    if (req.url.endsWith("?editor")) {
        res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-cache" })
        require("fs").createReadStream("./editor.html").pipe(res)
        return
    }

    if (req.url === '/pages') {
        var pages = await braid_text.list()
        res.writeHead(200, {
            "Content-Type": "application/json",
            "Access-Control-Expose-Headers": "*"
        })
        res.end(JSON.stringify(pages))
        return
    }

    if (req.url.startsWith('/file-proxy/')) {
        let rest = req.url.slice('/file-proxy/'.length)
        let [target_url, fullpath] = rest.split('?')
        console.log(`file proxy args: ${JSON.stringify({ target_url, fullpath })}`)

        let last_text = ''

        let simpleton = simpleton_client(target_url, {
            apply_remote_update: async ({ state, patches }) => {
                if (state !== undefined) last_text = state;
                else last_text = apply_patches(last_text, patches);

                console.log(`last_text = ${last_text}, ${fullpath}`)

                await require('fs').promises.writeFile(fullpath, last_text)

                return last_text;
            },
            generate_local_diff_update: async (prev_state) => {
                last_text = await require('fs').promises.readFile(fullpath, { encoding: 'utf8' })

                console.log('HI: ' + JSON.stringify({prev_state, last_text}, null, 4))

                var patches = diff(prev_state, last_text);

                console.log('patches: ' + JSON.stringify({patches}, null, 4))

                if (patches.length === 0) return null;
                return { patches, new_state: last_text };
            }
        })

        function diff(before, after) {
            let diff = diff_main(before, after);
            let patches = [];
            let offset = 0;
            for (let d of diff) {
                let p = null;
                if (d[0] == 1) p = { range: [offset, offset], content: d[1] };
                else if (d[0] == -1) {
                    p = { range: [offset, offset + d[1].length], content: "" };
                    offset += d[1].length;
                } else offset += d[1].length;
                if (p) {
                    p.unit = "text";
                    patches.push(p);
                }
            }
            return patches;
        }
        function watchFile(fullpath, callback) {
            const fs = require('fs');
            const path = require('path');
            const directory = path.dirname(fullpath);
            const filename = path.basename(fullpath);
            fs.watch(directory, (eventType, changedFilename) => {
                console.log(`file change!: ${eventType} : ${changedFilename}`)
                if (eventType === 'change' && changedFilename === filename) {
                    callback();
                }
            });
            console.log(`Watching for changes to ${fullpath}`);
        }
        watchFile(fullpath, () => simpleton.changed());

        res.writeHead(200, {})
        res.end(JSON.stringify({ yoo: true, target_url, fullpath }))

        return
    }

    // Create some initial text for new documents
    // if (await braid_text.get(req.url) === undefined) {
    //     console.log('----!')
    //     await braid_text.put(req.url, { body: 'This is a fresh blank document, ready for you to edit.' })
    // }

    if (!known_urls[req.url]) {
        known_urls[req.url] = true

        let target_url = req.url.slice(1)
        let peer = Math.random().toString(36).substr(2)
        let current_version = []

        braid_fetch_wrapper(target_url, {
            headers: {
                "Merge-Type": "dt",
                Accept: 'text/plain'
            },
            subscribe: true,
            retry: true,
            parents: () => current_version.length ? current_version : null,
            peer
        }).then(x => {
            x.subscribe(update => {
                console.log(`update: ${JSON.stringify(update, null, 4)}`)
                if (update.version.length == 0) return;

                braid_text.put(req.url, { ...update, peer })
            })
        })

        braid_text.get(req.url, {
            subscribe: async ({ version, parents, body, patches }) => {
                if (version.length == 0) return;

                console.log(`local got: ${JSON.stringify({ version, parents, body, patches }, null, 4)}`)

                await braid_fetch_wrapper(target_url, {
                    headers: {
                        "Merge-Type": "dt",
                        "Content-Type": 'text/plain',
                        ...(cookie ? { "Cookie": cookie } : {}),
                    },
                    method: "PUT",
                    retry: true,
                    version, parents, body, patches,
                    peer
                })
            },
            merge_type: 'dt',
            peer
        })
    }

    // Now serve the collaborative text!
    braid_text.serve(req, res)

    // // Extract the target URL from the request
    // const targetUrl = req.url.slice(1); // Remove the leading '/'
    // if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
    //     res.writeHead(400, { 'Content-Type': 'text/plain' });
    //     res.end('Invalid URL. Please use format: /http://example.com or /https://example.com');
    //     return;
    // }

    // const parsedUrl = url.parse(targetUrl);
    // const options = {
    //     hostname: parsedUrl.hostname,
    //     port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
    //     path: parsedUrl.path,
    //     method: req.method,
    //     headers: req.headers
    // };

    // // Remove the host header to avoid conflicts
    // delete options.headers.host;

    // const proxyReq = (parsedUrl.protocol === 'https:' ? https : http).request(options, (proxyRes) => {
    //     res.writeHead(proxyRes.statusCode, proxyRes.headers);
    //     proxyRes.pipe(res);
    // });

    // proxyReq.on('error', (error) => {
    //     console.error('Proxy error:', error);
    //     res.writeHead(500, { 'Content-Type': 'text/plain' });
    //     res.end('Proxy error');
    // });

    // req.pipe(proxyReq);
});

server.listen(port, () => {
    console.log(`Proxy server started on port ${port}`);
    console.log('This proxy is only accessible from localhost');
});

// Free the CORS!
function free_the_cors(req, res) {
    res.setHeader('Range-Request-Allow-Methods', 'PATCH, PUT');
    res.setHeader('Range-Request-Allow-Units', 'json');
    res.setHeader("Patches", "OK");
    var free_the_cors = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "OPTIONS, HEAD, GET, PUT, UNSUBSCRIBE",
        "Access-Control-Allow-Headers": "subscribe, client, version, parents, merge-type, content-type, content-range, patches, cache-control, peer"
    };
    Object.entries(free_the_cors).forEach(x => res.setHeader(x[0], x[1]));
    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
    }
}

async function braid_fetch_wrapper(url, params) {
    if (!params.retry) throw "wtf"
    var waitTime = 10
    if (params.subscribe) {
        var subscribe_handler = null
        connect()
        async function connect() {
            if (params.signal?.aborted) return
            try {
                console.log('URL: ' + url)
                var c = await braid_fetch(url, { ...params, parents: params.parents?.() })
                c.subscribe((...args) => subscribe_handler?.(...args), on_error)
                waitTime = 10
            } catch (e) {
                on_error(e)
            }
        }
        function on_error(e) {
            console.log('eee = ' + e.stack)
            setTimeout(connect, waitTime)
            waitTime = Math.min(waitTime * 2, 3000)
        }
        return { subscribe: handler => { subscribe_handler = handler } }
    } else {
        return new Promise((done) => {
            send()
            async function send() {
                try {
                    var res = await braid_fetch(url, params)
                    if (res.status !== 200) throw "status not 200: " + res.status
                    done(res)
                } catch (e) {
                    setTimeout(send, waitTime)
                    waitTime = Math.min(waitTime * 2, 3000)
                }
            }
        })
    }
}

function apply_patches(originalString, patches) {
    let offset = 0;
    for (let p of patches) {
        p.range[0] += offset;
        p.range[1] += offset;
        offset -= p.range[1] - p.range[0];
        offset += p.content.length;
    }

    let result = originalString;

    for (let p of patches) {
        let range = p.range;
        result =
            result.substring(0, range[0]) +
            p.content +
            result.substring(range[1]);
    }

    return result;
}

// requires braid-http@0.3.14
// 
// url: resource endpoint
//
// apply_remote_update: ({patches, state}) => {...}
//     this is for incoming changes;
//     one of these will be non-null,
//     and can be applied to the current state.
//
// generate_local_diff_update: (prev_state) => {...}
//     this is to generate outgoing changes,
//     and if there are changes, returns { patches, new_state }
//
// content_type: used for Accept and Content-Type headers
//
// returns { changed(): (diff_function) => {...} }
//     this is for outgoing changes;
//     diff_function = () => ({patches, new_version}).
//
function simpleton_client(url, { apply_remote_update, generate_local_diff_update, content_type }) {
    var peer = Math.random().toString(36).substr(2)
    var current_version = []
    var prev_state = ""
    var char_counter = -1
    var outstanding_changes = 0
    var max_outstanding_changes = 10
    var ac = new AbortController()

    // Create a promise chain to serialize apply_remote_update calls
    let updateChain = Promise.resolve()

    braid_fetch_wrapper(url, {
        headers: {
            "Merge-Type": "simpleton",
            ...(content_type ? { Accept: content_type } : {})
        },
        subscribe: true,
        retry: true,
        parents: () => current_version.length ? current_version : null,
        peer,
        signal: ac.signal
    }).then(res =>
        res.subscribe(update => {
            // Add this update to the chain
            updateChain = updateChain.then(async () => {
                // Only accept the update if its parents == our current version
                update.parents.sort()
                if (current_version.length === update.parents.length
                    && current_version.every((v, i) => v === update.parents[i])) {
                    current_version = update.version.sort()
                    update.state = update.body

                    if (update.patches) {
                        for (let p of update.patches) p.range = p.range.match(/\d+/g).map((x) => 1 * x)
                        update.patches.sort((a, b) => a.range[0] - b.range[0])

                        // convert from code-points to js-indicies
                        let c = 0
                        let i = 0
                        for (let p of update.patches) {
                            while (c < p.range[0]) {
                                i += get_char_size(prev_state, i)
                                c++
                            }
                            p.range[0] = i

                            while (c < p.range[1]) {
                                i += get_char_size(prev_state, i)
                                c++
                            }
                            p.range[1] = i
                        }
                    }

                    prev_state = await apply_remote_update(update)
                }
            })
        })
    )

    return {
        stop: async () => {
            ac.abort()
        },
        changed: async () => {
            if (outstanding_changes >= max_outstanding_changes) return
            while (true) {
                var update = await generate_local_diff_update(prev_state)
                if (!update) return   // Stop if there wasn't a change!
                var { patches, new_state } = update

                // convert from js-indicies to code-points
                let c = 0
                let i = 0
                for (let p of patches) {
                    while (i < p.range[0]) {
                        i += get_char_size(prev_state, i)
                        c++
                    }
                    p.range[0] = c

                    while (i < p.range[1]) {
                        i += get_char_size(prev_state, i)
                        c++
                    }
                    p.range[1] = c

                    char_counter += p.range[1] - p.range[0]
                    char_counter += count_code_points(p.content)

                    p.unit = "text"
                    p.range = `[${p.range[0]}:${p.range[1]}]`
                }

                var version = [peer + "-" + char_counter]

                var parents = current_version
                current_version = version
                prev_state = new_state

                outstanding_changes++
                await braid_fetch_wrapper(url, {
                    headers: {
                        "Merge-Type": "simpleton",
                        ...(cookie ? { "Cookie": cookie } : {}),
                        ...(content_type ? { "Content-Type": content_type } : {})
                    },
                    method: "PUT",
                    retry: true,
                    version, parents, patches,
                    peer
                })
                outstanding_changes--
            }
        }
    }
}

function get_char_size(s, i) {
    const charCode = s.charCodeAt(i)
    return (charCode >= 0xd800 && charCode <= 0xdbff) ? 2 : 1
}

function count_code_points(str) {
    let code_points = 0
    for (let i = 0; i < str.length; i++) {
        if (str.charCodeAt(i) >= 0xd800 && str.charCodeAt(i) <= 0xdbff) i++
        code_points++
    }
    return code_points
}

async function braid_fetch_wrapper(url, params) {
    if (!params.retry) throw "wtf"
    var waitTime = 10
    if (params.subscribe) {
        var subscribe_handler = null
        connect()
        async function connect() {
            if (params.signal?.aborted) return
            try {
                var c = await braid_fetch(url, { ...params, parents: params.parents?.() })
                c.subscribe((...args) => subscribe_handler?.(...args), on_error)
                waitTime = 10
            } catch (e) {
                on_error(e)
            }
        }
        function on_error(e) {
            console.log('eee = ' + e.stack)
            setTimeout(connect, waitTime)
            waitTime = Math.min(waitTime * 2, 3000)
        }
        return { subscribe: handler => { subscribe_handler = handler } }
    } else {
        return new Promise((done) => {
            send()
            async function send() {
                try {
                    var res = await braid_fetch(url, params)
                    if (res.status !== 200) throw "status not 200: " + res.status
                    done(res)
                } catch (e) {
                    setTimeout(send, waitTime)
                    waitTime = Math.min(waitTime * 2, 3000)
                }
            }
        })
    }
}