import { lstatSync, readFileSync } from "node:fs";
import { createServer as createHttpServer, request as requestHttp } from "node:http";
import { createServer } from "node:https";
import { connect } from "node:net";
import { resolve } from "node:path";

const port = parsePort(process.argv[2]);
const proxyPort = parsePort(process.argv[4]);
const upstream = new URL(process.argv[3] ?? "");
if (upstream.href !== "http://127.0.0.1:4175/") {
  throw new TypeError("Supported browser HTTPS upstream is invalid.");
}
const keyPath = readTlsPath(process.env.HOSTDECK_BROWSER_HTTPS_KEY, "key");
const certificatePath = readTlsPath(
  process.env.HOSTDECK_BROWSER_HTTPS_CERTIFICATE,
  "certificate"
);
const cookieHost = "hostdeck-cookie.fixture-tailnet.ts.net";
const cookieSiblingHost = "hostdeck-cookie-sibling.fixture-tailnet.ts.net";
const cookieCrossSiteHost = "hostdeck-cookie-cross.other-fixture.ts.net";
const expectedHosts = new Set([
  `127.0.0.1:${port}`,
  cookieHost,
  `${cookieHost}:443`,
  cookieSiblingHost,
  `${cookieSiblingHost}:443`,
  cookieCrossSiteHost,
  `${cookieCrossSiteHost}:443`
]);
const expectedTunnels = new Set([
  `${cookieHost}:443`,
  `${cookieSiblingHost}:443`,
  `${cookieCrossSiteHost}:443`
]);
const cookieName = "__Host-hostdeck_device";
const cookieValue = "fixture-only";
const sockets = new Set();

const server = createServer(
  {
    cert: readFileSync(certificatePath),
    key: readFileSync(keyPath),
    minVersion: "TLSv1.2"
  },
  async (request, response) => {
    try {
      const host = request.headers.host;
      if (host === undefined || !expectedHosts.has(host)) {
        send(response, 400, { "content-type": "text/plain; charset=utf-8" }, "Invalid host.\n");
        return;
      }
      const requestUrl = new URL(request.url ?? "", `https://${host}`);
      if (requestUrl.pathname === "/browser-matrix-cookie/claim") {
        if (
          !isCookieHost(host) ||
          requestUrl.search !== "" ||
          request.method !== "POST" ||
          hasRequestBody(request)
        ) {
          send(response, 400, { "content-type": "text/plain; charset=utf-8" }, "Invalid claim.\n");
          return;
        }
        send(response, 204, {
          "cache-control": "no-store",
          "set-cookie": `${cookieName}=${cookieValue}; Path=/; Secure; HttpOnly; SameSite=Strict`
        });
        return;
      }
      if (requestUrl.pathname === "/browser-matrix-cookie/check") {
        if (!isCookieHost(host) || requestUrl.search !== "" || request.method !== "GET") {
          send(response, 400, { "content-type": "text/plain; charset=utf-8" }, "Invalid check.\n");
          return;
        }
        if (!hasExactDeviceCookie(request.headers.cookie)) {
          send(response, 401, { "cache-control": "no-store" });
          return;
        }
        send(response, 204, {
          "cache-control": "no-store",
          "x-hostdeck-cookie-observed": "present"
        });
        return;
      }
      if (requestUrl.pathname === "/browser-matrix-cookie/cross-site-check") {
        if (
          !isCookieHost(host) ||
          requestUrl.search !== "" ||
          request.method !== "GET" ||
          request.headers["sec-fetch-mode"] !== "navigate" ||
          request.headers["sec-fetch-site"] !== "cross-site"
        ) {
          send(response, 400, { "cache-control": "no-store" });
          return;
        }
        if (hasDeviceCookie(request.headers.cookie)) {
          send(response, 409, { "cache-control": "no-store" });
          return;
        }
        send(response, 200, {
          "cache-control": "no-store",
          "content-type": "text/plain; charset=utf-8",
          "x-hostdeck-same-site-cookie-absent": "true"
        }, "SameSite cookie absent.\n");
        return;
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        send(response, 405, {
          allow: "GET, HEAD",
          "content-type": "text/plain; charset=utf-8"
        }, "Method not allowed.\n");
        return;
      }
      const foreignCookieHost =
        host.startsWith(cookieSiblingHost) || host.startsWith(cookieCrossSiteHost);
      if (foreignCookieHost && hasDeviceCookie(request.headers.cookie)) {
        send(response, 409, { "cache-control": "no-store" });
        return;
      }
      await proxyPackage(request, response, requestUrl, foreignCookieHost);
    } catch {
      if (!response.headersSent) {
        send(response, 502, { "content-type": "text/plain; charset=utf-8" }, "Proxy unavailable.\n");
      } else {
        response.destroy();
      }
    }
  }
);

const tunnelServer = createHttpServer((_request, response) => {
  send(response, 405, {
    allow: "CONNECT",
    "content-type": "text/plain; charset=utf-8"
  }, "CONNECT required.\n");
});
tunnelServer.headersTimeout = 5_000;
tunnelServer.requestTimeout = 10_000;
tunnelServer.keepAliveTimeout = 1_000;
tunnelServer.maxHeadersCount = 32;
tunnelServer.on("connect", (request, clientSocket, head) => {
  if (!expectedTunnels.has(request.url ?? "")) {
    clientSocket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    return;
  }
  const upstreamSocket = trackSocket(connect({ host: "127.0.0.1", port }));
  clientSocket.once("close", () => upstreamSocket.destroy());
  upstreamSocket.once("close", () => clientSocket.destroy());
  upstreamSocket.once("connect", () => {
    if (clientSocket.destroyed) {
      upstreamSocket.destroy();
      return;
    }
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.byteLength > 0) upstreamSocket.write(head);
    clientSocket.pipe(upstreamSocket);
    upstreamSocket.pipe(clientSocket);
  });
  upstreamSocket.on("error", () => {
    if (!clientSocket.destroyed && !clientSocket.writableEnded) {
      clientSocket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
    }
  });
});
tunnelServer.on("clientError", (_error, socket) => socket.destroy());

server.headersTimeout = 5_000;
server.requestTimeout = 10_000;
server.keepAliveTimeout = 1_000;
server.maxHeadersCount = 64;
server.on("connection", (socket) => {
  trackSocket(socket);
});
server.on("clientError", (_error, socket) => socket.destroy());
tunnelServer.on("connection", (socket) => {
  trackSocket(socket);
});

await Promise.all([
  listen(server, port),
  listen(tunnelServer, proxyPort)
]);
process.stdout.write(
  `HostDeck browser HTTPS fixture ready on ${port} through tunnel ${proxyPort}.\n`
);
await waitForTerminationSignal();
await closeServer();

function proxyPackage(incoming, outgoing, requestUrl, siblingRequest) {
  return new Promise((resolveProxy, rejectProxy) => {
    const upstreamRequest = requestHttp({
      hostname: upstream.hostname,
      method: incoming.method,
      path: `${requestUrl.pathname}${requestUrl.search}`,
      port: Number(upstream.port),
      headers: {
        accept: incoming.headers.accept ?? "*/*",
        "accept-encoding": "identity",
        "user-agent": "HostDeck supported-browser HTTPS fixture"
      }
    }, (upstreamResponse) => {
      const headers = { ...upstreamResponse.headers };
      delete headers.connection;
      delete headers["keep-alive"];
      delete headers["transfer-encoding"];
      delete headers["set-cookie"];
      if (siblingRequest) {
        headers["x-hostdeck-host-only-cookie-absent"] = "true";
      }
      outgoing.writeHead(upstreamResponse.statusCode ?? 502, headers);
      upstreamResponse.pipe(outgoing);
      upstreamResponse.once("end", resolveProxy);
      upstreamResponse.once("error", rejectProxy);
    });
    upstreamRequest.once("error", rejectProxy);
    upstreamRequest.end();
  });
}

function send(response, status, headers, body = "") {
  response.writeHead(status, {
    "content-length": Buffer.byteLength(body),
    ...headers
  });
  response.end(body);
}

function trackSocket(socket) {
  sockets.add(socket);
  socket.on("error", () => socket.destroy());
  socket.once("close", () => sockets.delete(socket));
  return socket;
}

function hasRequestBody(request) {
  return (
    request.headers["transfer-encoding"] !== undefined ||
    (request.headers["content-length"] !== undefined &&
      request.headers["content-length"] !== "0")
  );
}

function hasExactDeviceCookie(value) {
  return value === `${cookieName}=${cookieValue}`;
}

function hasDeviceCookie(value) {
  if (value === undefined) return false;
  return value.split(";").some((part) => part.trim().startsWith(`${cookieName}=`));
}

function isCookieHost(host) {
  return host === cookieHost || host === `${cookieHost}:443`;
}

function parsePort(candidate) {
  const value = Number(candidate);
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) {
    throw new TypeError("Supported browser HTTPS port is invalid.");
  }
  return value;
}

function readTlsPath(candidate, label) {
  if (
    typeof candidate !== "string" ||
    !candidate.startsWith("/tmp/hostdeck-browser-matrix-run-")
  ) {
    throw new TypeError(`Supported browser HTTPS ${label} path is invalid.`);
  }
  const path = resolve(candidate);
  const stats = lstatSync(path);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size < 1 || stats.size > 32_768) {
    throw new TypeError(`Supported browser HTTPS ${label} file is invalid.`);
  }
  return path;
}

function waitForTerminationSignal() {
  return new Promise((resolveSignal) => {
    const finish = () => resolveSignal();
    process.once("SIGINT", finish);
    process.once("SIGTERM", finish);
  });
}

function listen(target, listenPort) {
  return new Promise((resolveListen, rejectListen) => {
    target.once("error", rejectListen);
    target.listen(listenPort, "127.0.0.1", () => {
      target.off("error", rejectListen);
      resolveListen();
    });
  });
}

function closeServer() {
  return new Promise((resolveClose) => {
    let pending = 2;
    const closed = () => {
      pending -= 1;
      if (pending === 0) resolveClose();
    };
    server.close(closed);
    tunnelServer.close(closed);
    server.closeIdleConnections();
    tunnelServer.closeIdleConnections();
    const deadline = setTimeout(() => {
      for (const socket of sockets) socket.destroy();
    }, 2_000);
    deadline.unref();
  });
}
