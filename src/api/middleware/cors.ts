/**
 * Exact-origin CORS (not `*`). Cheap defense-in-depth given we're also
 * carrying a bearer-style token — see doc §9/§11.
 */
export function withCors(res: Response, allowedOrigin: string): Response {
  const headers = new Headers(res.headers);
  headers.set("Access-Control-Allow-Origin", allowedOrigin);
  headers.set("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type, X-Local-Token");
  headers.set("Vary", "Origin");
  return new Response(res.body, { status: res.status, headers });
}

export function preflightResponse(allowedOrigin: string): Response {
  return withCors(new Response(null, { status: 204 }), allowedOrigin);
}
