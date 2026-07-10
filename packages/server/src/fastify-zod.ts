import type { FastifyInstance, FastifyTypeProvider } from "fastify";
import { z } from "zod";

export interface HostDeckZodTypeProvider extends FastifyTypeProvider {
  validator: this["schema"] extends z.ZodType ? z.output<this["schema"]> : unknown;
  serializer: this["schema"] extends z.ZodType ? z.input<this["schema"]> : unknown;
}

export const hostDeckRequestValidationErrorCode = "HOSTDECK_INVALID_REQUEST";

export class HostDeckRequestValidationError extends Error {
  readonly code = hostDeckRequestValidationErrorCode;
  readonly statusCode = 400;
  readonly field: string;

  constructor(field: string, cause: z.ZodError) {
    super("Request failed validation.", { cause });
    this.name = "HostDeckRequestValidationError";
    this.field = field;
  }
}

export function installHostDeckZodCompilers(app: FastifyInstance): void {
  app.setValidatorCompiler(({ schema, httpPart }) => {
    const zodSchema = requireZodSchema(schema);
    const field = normalizeValidationField(httpPart);

    return (data) => {
      const result = zodSchema.safeParse(data);
      return result.success
        ? { value: result.data }
        : { error: new HostDeckRequestValidationError(field, result.error) };
    };
  });

  app.setSerializerCompiler(({ schema }) => {
    const zodSchema = requireZodSchema(schema);
    return (data) => JSON.stringify(zodSchema.parse(data));
  });
}

export function assertHostDeckRouteSchemas(schema: unknown): void {
  if (schema === undefined) return;
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) {
    throw new TypeError("HostDeck Fastify route schema must be an object.");
  }
  const routeSchema = schema as Record<string, unknown>;
  const allowedKeys = new Set(["body", "headers", "hide", "params", "querystring", "response"]);
  for (const key of Object.keys(routeSchema)) {
    if (!allowedKeys.has(key)) throw new TypeError(`HostDeck Fastify route schema field "${key}" is not supported.`);
  }
  for (const key of ["body", "headers", "params", "querystring"] as const) {
    if (routeSchema[key] !== undefined) requireZodSchema(routeSchema[key]);
  }
  if (routeSchema.hide !== undefined && typeof routeSchema.hide !== "boolean") {
    throw new TypeError("HostDeck Fastify route schema hide field must be boolean.");
  }
  if (routeSchema.response === undefined) return;
  if (routeSchema.response === null || typeof routeSchema.response !== "object" || Array.isArray(routeSchema.response)) {
    throw new TypeError("HostDeck Fastify response schema map must be an object.");
  }
  for (const responseSchema of Object.values(routeSchema.response)) requireZodSchema(responseSchema);
}

export function assertHostDeckApiResponseSchemas(schema: unknown): void {
  assertHostDeckRouteSchemas(schema);
  const response = (schema as { readonly response?: unknown } | undefined)?.response;
  if (response === null || typeof response !== "object" || Array.isArray(response) || Object.keys(response).length === 0) {
    throw new TypeError("HostDeck API routes must declare at least one Zod response schema.");
  }
}

function requireZodSchema(schema: unknown): z.ZodType {
  if (!(schema instanceof z.ZodType)) {
    throw new TypeError("HostDeck Fastify route schemas must be Zod schemas.");
  }
  return schema;
}

function normalizeValidationField(httpPart: string | undefined): string {
  switch (httpPart) {
    case "body":
    case "headers":
    case "params":
      return httpPart;
    case "querystring":
      return "query";
    default:
      return "request";
  }
}
