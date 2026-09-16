import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
} from "aws-lambda";
import { ApiError, errorBody } from "./errors.js";

const MAX_BODY_BYTES = 32 * 1024; // plan: 32 KB body maximum for app JSON

export function json(
  statusCode: number,
  body: unknown,
  headers: Record<string, string> = {},
): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode,
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  };
}

export function toErrorResponse(err: unknown): APIGatewayProxyStructuredResultV2 {
  if (err instanceof ApiError) {
    return json(err.status, errorBody(err));
  }
  console.error("unhandled error", err);
  return json(500, {
    error: { class: "PROVIDER_UNAVAILABLE", message: "Internal error" },
  });
}

/** JWT subject from the HTTP API v2 JWT authorizer. Client-supplied owner ids are ignored. */
export function getSub(event: APIGatewayProxyEventV2): string | null {
  const claims = (
    event.requestContext as {
      authorizer?: { jwt?: { claims?: Record<string, unknown> } };
    }
  ).authorizer?.jwt?.claims;
  const sub = claims?.["sub"];
  return typeof sub === "string" && sub.length > 0 ? sub : null;
}

export function requireSub(event: APIGatewayProxyEventV2): string {
  const sub = getSub(event);
  if (!sub) {
    throw new ApiError("POLICY_BLOCKED", "Missing or invalid authorization", undefined, 401);
  }
  return sub;
}

/** Parse JSON body with the 32KB limit enforced. */
export function parseJsonBody(event: APIGatewayProxyEventV2): unknown {
  const body = event.body ?? "";
  if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) {
    throw new ApiError("INVALID_PREFERENCES", "Request body exceeds 32 KB", undefined, 413);
  }
  if (!body) return {};
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new ApiError("INVALID_PREFERENCES", "Request body must be valid JSON");
  }
}

export function header(event: APIGatewayProxyEventV2, name: string): string | null {
  const headers = event.headers ?? {};
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === name.toLowerCase()) return v ?? null;
  }
  return null;
}

export function queryParam(event: APIGatewayProxyEventV2, name: string): string | null {
  return event.queryStringParameters?.[name] ?? null;
}
