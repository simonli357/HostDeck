import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { connect, createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { connect as connectTls } from "node:tls";

const repositoryRoot = resolve(import.meta.dirname, "..");
const cookieHost = "hostdeck-cookie.fixture-tailnet.ts.net";

test("CONNECT resets cannot terminate the supported-browser HTTPS proxy", { timeout: 30_000 }, async () => {
  const temporaryRoot = mkdtempSync(
    join(tmpdir(), "hostdeck-browser-matrix-run-proxy-test-")
  );
  const keyPath = join(temporaryRoot, "key.pem");
  const certificatePath = join(temporaryRoot, "certificate.pem");
  const reservedPorts = new Set([4175]);
  const httpsPort = await reservePort(reservedPorts);
  reservedPorts.add(httpsPort);
  const proxyPort = await reservePort(reservedPorts);
  const upstream = createHttpServer((_request, response) => {
    const body = "Supported browser proxy test.\n";
    response.writeHead(200, {
      "content-length": Buffer.byteLength(body),
      "content-type": "text/plain; charset=utf-8"
    });
    response.end(body);
  });
  let child = null;

  try {
    await listen(upstream, 4175);
    createCertificate(keyPath, certificatePath);
    child = spawn(
      process.execPath,
      [
        "scripts/run-supported-browser-https-proxy.mjs",
        String(httpsPort),
        "http://127.0.0.1:4175",
        String(proxyPort)
      ],
      {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          HOSTDECK_BROWSER_HTTPS_CERTIFICATE: certificatePath,
          HOSTDECK_BROWSER_HTTPS_KEY: keyPath
        },
        stdio: ["ignore", "pipe", "pipe"]
      }
    );
    const output = collectChildOutput(child);
    await waitFor(
      () => output.stdout().includes("HostDeck browser HTTPS fixture ready"),
      () => childExited(child),
      () => `Proxy exited before readiness. ${output.stderr()}`
    );

    for (let attempt = 0; attempt < 12; attempt += 1) {
      await resetConnectTunnel(proxyPort);
    }
    await delay(100);
    assert.equal(child.exitCode, null, output.stderr());

    const response = await requestThroughTunnel(proxyPort);
    assert.match(response, /^HTTP\/1\.1 200 /u);
    assert.match(response, /Supported browser proxy test\./u);
    assert.equal(child.exitCode, null, output.stderr());
  } finally {
    if (child !== null && !childExited(child)) {
      child.kill("SIGTERM");
      await waitFor(() => childExited(child), () => false, () => "Proxy did not stop.");
    }
    await close(upstream);
    rmSync(temporaryRoot, { force: true, recursive: true });
  }
});

function createCertificate(keyPath, certificatePath) {
  const result = spawnSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-sha256",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=127.0.0.1",
      "-addext",
      `subjectAltName=IP:127.0.0.1,DNS:${cookieHost}`,
      "-keyout",
      keyPath,
      "-out",
      certificatePath
    ],
    { stdio: "ignore" }
  );
  assert.equal(result.status, 0, "Proxy test certificate generation failed.");
}

function collectChildOutput(child) {
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout = boundedAppend(stdout, chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr = boundedAppend(stderr, chunk);
  });
  return Object.freeze({
    stderr: () => stderr,
    stdout: () => stdout
  });
}

function boundedAppend(current, chunk) {
  const next = `${current}${chunk}`;
  return next.length <= 16_384 ? next : next.slice(-16_384);
}

function resetConnectTunnel(proxyPort) {
  return new Promise((resolveReset, rejectReset) => {
    const socket = connect({ host: "127.0.0.1", port: proxyPort });
    let response = "";
    let settled = false;
    const timeout = setTimeout(
      () => finish(new Error("CONNECT reset test timed out.")),
      2_000
    );
    const finish = (error = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error === null) resolveReset();
      else rejectReset(error);
    };
    socket.on("error", (error) => finish(error));
    socket.once("connect", () => {
      socket.write(
        `CONNECT ${cookieHost}:443 HTTP/1.1\r\nHost: ${cookieHost}:443\r\n\r\n`
      );
    });
    socket.on("data", (chunk) => {
      response = boundedAppend(response, chunk.toString("utf8"));
      if (!response.includes("\r\n\r\n")) return;
      try {
        assert.match(response, /^HTTP\/1\.1 200 Connection Established/u);
        if (typeof socket.resetAndDestroy === "function") socket.resetAndDestroy();
        else socket.destroy();
        finish();
      } catch (error) {
        finish(error);
      }
    });
  });
}

function requestThroughTunnel(proxyPort) {
  return new Promise((resolveRequest, rejectRequest) => {
    const socket = connect({ host: "127.0.0.1", port: proxyPort });
    let connectResponse = "";
    let settled = false;
    const timeout = setTimeout(
      () => finish(new Error("Tunneled HTTPS request timed out.")),
      5_000
    );
    const finish = (error, response = "") => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      if (error === null) resolveRequest(response);
      else rejectRequest(error);
    };
    socket.once("error", (error) => finish(error));
    socket.once("connect", () => {
      socket.write(
        `CONNECT ${cookieHost}:443 HTTP/1.1\r\nHost: ${cookieHost}:443\r\n\r\n`
      );
    });
    const readConnectResponse = (chunk) => {
      connectResponse = boundedAppend(connectResponse, chunk.toString("utf8"));
      if (!connectResponse.includes("\r\n\r\n")) return;
      socket.off("data", readConnectResponse);
      try {
        assert.match(connectResponse, /^HTTP\/1\.1 200 Connection Established/u);
      } catch (error) {
        finish(error);
        return;
      }
      const tls = connectTls({
        rejectUnauthorized: false,
        servername: cookieHost,
        socket
      });
      let response = "";
      tls.once("error", (error) => finish(error));
      tls.once("secureConnect", () => {
        tls.write(
          `GET / HTTP/1.1\r\nHost: ${cookieHost}\r\nConnection: close\r\n\r\n`
        );
      });
      tls.on("data", (part) => {
        response = boundedAppend(response, part.toString("utf8"));
      });
      tls.once("end", () => finish(null, response));
    };
    socket.on("data", readConnectResponse);
  });
}

function reservePort(excluded) {
  const server = createNetServer();
  return listen(server, 0).then(() => {
    const address = server.address();
    assert.notEqual(address, null);
    assert.equal(typeof address, "object");
    const port = address.port;
    return close(server).then(() =>
      excluded.has(port) ? reservePort(excluded) : port
    );
  });
}

function listen(server, port) {
  return new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
}

function close(server) {
  return new Promise((resolveClose, rejectClose) => {
    if (!server.listening) {
      resolveClose();
      return;
    }
    server.close((error) => {
      if (error === undefined) resolveClose();
      else rejectClose(error);
    });
  });
}

async function waitFor(done, failed, message) {
  const deadline = Date.now() + 5_000;
  while (!done()) {
    if (failed()) throw new Error(message());
    if (Date.now() >= deadline) throw new Error(message());
    await delay(20);
  }
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function childExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}
