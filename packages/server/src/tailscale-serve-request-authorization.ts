import type { FastifyInstance } from "fastify";
import type { HostDeckInternalErrorObserver } from "./fastify-error-policy.js";
import {
  assertHostDeckRequestAuthenticationPolicy,
  createHostDeckRequestAuthenticationIngressPolicy,
  type HostDeckRequestAuthenticationIngressAuthority,
  type HostDeckRequestAuthenticationIngressPolicy,
  type HostDeckRequestAuthenticationPolicy,
  installHostDeckRequestAuthentication
} from "./fastify-request-authentication.js";
import {
  assertHostDeckRemoteIngressRequestAuthorityPolicy,
  type HostDeckRemoteIngressRequestAuthorityPolicy
} from "./remote-ingress-request-authority.js";
import {
  assertTailscaleServeProxyTrustPolicy,
  assertTailscaleServeRequestIngressCurrent,
  installTailscaleServeProxyTrustGate,
  type TailscaleServeProxyTrustPolicy,
  tailscaleServeRequestTrustContext
} from "./tailscale-serve-proxy-trust.js";

export function createTailscaleServeRequestAuthenticationIngressPolicy(
  requestAuthority: HostDeckRemoteIngressRequestAuthorityPolicy
): HostDeckRequestAuthenticationIngressPolicy {
  assertHostDeckRemoteIngressRequestAuthorityPolicy(requestAuthority);
  return createHostDeckRequestAuthenticationIngressPolicy({
    acquireAuthority(request) {
      const provenance = tailscaleServeRequestTrustContext(request).provenance;
      if (provenance.kind === "local_loopback") return null;
      const lease = requestAuthority.acquire({
        external_origin: provenance.origin,
        generation: provenance.remote_generation
      });
      const authority: HostDeckRequestAuthenticationIngressAuthority =
        Object.freeze({
          assertCurrent() {
            requestAuthority.assertActive(lease);
          },
          release() {
            requestAuthority.release(lease);
          },
          signal: lease.signal
        });
      return authority;
    },
    assertCurrent(request) {
      assertTailscaleServeRequestIngressCurrent(request);
    },
    resolve(request) {
      const trust = tailscaleServeRequestTrustContext(request);
      const provenance = trust.provenance;
      if (provenance.kind === "local_loopback") {
        return {
          configured_origin: provenance.origin,
          network_mode: "loopback",
          origin_kind: trust.origin_kind,
          transport: "http",
          source_key: null,
          remote_generation: null
        };
      }
      if (trust.origin_kind === "local_non_browser") {
        throw new TypeError("Admitted remote ingress cannot be local non-browser trust.");
      }
      return {
        configured_origin: provenance.origin,
        network_mode: "remote",
        origin_kind: trust.origin_kind,
        transport: "https",
        source_key: provenance.source_key,
        remote_generation: provenance.remote_generation
      };
    }
  });
}

export function installTailscaleServeRequestAuthorization(
  app: FastifyInstance,
  proxyTrustPolicy: TailscaleServeProxyTrustPolicy,
  requestAuthenticationPolicy: HostDeckRequestAuthenticationPolicy,
  requestAuthority: HostDeckRemoteIngressRequestAuthorityPolicy,
  observeInternalError: HostDeckInternalErrorObserver
): void {
  assertTailscaleServeProxyTrustPolicy(proxyTrustPolicy);
  assertHostDeckRequestAuthenticationPolicy(requestAuthenticationPolicy);
  assertHostDeckRemoteIngressRequestAuthorityPolicy(requestAuthority);
  if (typeof observeInternalError !== "function") {
    throw new TypeError("Tailscale Serve request authorization observer must be a function.");
  }
  const ingressPolicy =
    createTailscaleServeRequestAuthenticationIngressPolicy(requestAuthority);
  installTailscaleServeProxyTrustGate(app, proxyTrustPolicy, observeInternalError);
  installHostDeckRequestAuthentication(
    app,
    requestAuthenticationPolicy,
    ingressPolicy
  );
}
