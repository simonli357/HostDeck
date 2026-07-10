import { type ResourceBudget, resourceBudgetSchema } from "@hostdeck/contracts";

export interface FastifyFactoryResourceOptions {
  readonly bodyLimit: number;
  readonly connectionTimeout: number;
  readonly handlerTimeout: number;
  readonly keepAliveTimeout: number;
  readonly maxRequestsPerSocket: number;
  readonly requestTimeout: number;
  readonly routerOptions: {
    readonly maxParamLength: number;
  };
}

export interface NodeHttpResourceOptions {
  readonly headersTimeout: number;
  readonly maxConnections: number;
  readonly maxHeaderSize: number;
  readonly maxHeadersCount: number;
}

export interface FastifyApplicationResourceOptions {
  readonly maxInFlightRequests: number;
  readonly maxRouteParamBytes: number;
  readonly maxUrlBytes: number;
}

export interface FastifyResourceOptions {
  readonly factory: FastifyFactoryResourceOptions;
  readonly node: NodeHttpResourceOptions;
  readonly application: FastifyApplicationResourceOptions;
}

export function fastifyResourceOptionsFromBudget(input: unknown): FastifyResourceOptions {
  const budget: ResourceBudget = resourceBudgetSchema.parse(input);
  return Object.freeze({
    factory: Object.freeze({
      bodyLimit: budget.http_body_max_bytes,
      connectionTimeout: budget.http_connection_idle_timeout_ms,
      handlerTimeout: budget.http_request_deadline_ms,
      keepAliveTimeout: budget.http_keep_alive_timeout_ms,
      maxRequestsPerSocket: budget.http_max_requests_per_socket,
      requestTimeout: budget.http_request_receive_timeout_ms,
      routerOptions: Object.freeze({ maxParamLength: budget.http_route_param_max_bytes })
    }),
    node: Object.freeze({
      headersTimeout: budget.http_headers_timeout_ms,
      maxConnections: budget.http_max_connections,
      maxHeaderSize: budget.http_headers_max_bytes,
      maxHeadersCount: budget.http_headers_max_count
    }),
    application: Object.freeze({
      maxInFlightRequests: budget.http_max_in_flight_requests,
      maxRouteParamBytes: budget.http_route_param_max_bytes,
      maxUrlBytes: budget.http_url_max_bytes
    })
  });
}
