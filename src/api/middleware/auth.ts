import { tokensMatch } from "../../core/auth";

/**
 * Returns a 401 Response if the request's X-Local-Token header doesn't match,
 * or null to let the request continue. /health is intentionally exempt
 * (it's the UI's connection probe, before it necessarily has a token yet).
 */
export function checkAuth(req: Request, localToken: string): Response | null {
  const url = new URL(req.url);
  if (url.pathname === "/health" || url.pathname === "/pair") return null;

  const provided = req.headers.get("x-local-token");
  if (!tokensMatch(provided, localToken)) {
    return Response.json({ error: { code: "unauthorized", message: "Missing or invalid X-Local-Token" } }, { status: 401 });
  }
  return null;
}
