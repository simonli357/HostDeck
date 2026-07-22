export const browserSseRouteContract = Object.freeze({
  id: "session_event_stream",
  family: "events",
  method: "GET",
  path: "/api/v1/sessions/:session_id/events/stream",
  transport: "sse",
  request: Object.freeze({
    params: "session_id_params_v1",
    query: "selected_stream_cursor_query_v1",
    body: null
  }),
  response: Object.freeze({
    success: "selected_projection_event_v1",
    error: "selected_api_error_v1"
  }),
  auth: "loopback_or_device_cookie",
  authority: "session_read",
  csrf: "none",
  lock: "not_applicable",
  target: "managed_session",
  operation_kind: null,
  audit: null,
  credential_effect: "none",
  handler: "events.stream",
  owner_task: "IFC-V1-035"
} as const);
