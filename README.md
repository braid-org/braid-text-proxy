# braid-text-proxy
A proxy exposing and caching web and file resources over a convenient protocol.

### To Run Locally..

Clone the repo..

```
    git clone https://github.com/braid-org/braid-text-proxy.git
```

And in that directory, run:

```
    node index.js 60000
```

This will run a server on port 60000, but only permits local connections.

Note that it will create a directory called `braid-text-db`, and store the local cached information there.

### To Use..

`/pages`: shows all the proxied urls

`/file-proxy/AAA?BBB`: proxies the url AAA into the file BBB

`/AAA`: proxies the url AAA as braid text

### Known Issues:

- doesn't resubscribe to anything when you restart the server (though it should keep trying to re-establish a broken connection for as long as the server is still running)

