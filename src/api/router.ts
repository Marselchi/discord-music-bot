export interface RouteContext {
  req: Request;
  params: Record<string, string>;
  query: URLSearchParams;
}

export type RouteHandler = (ctx: RouteContext) => Promise<Response> | Response;

type Method = "GET" | "POST" | "PATCH" | "DELETE";

interface Route {
  method: Method;
  segments: string[]; // e.g. ["api", "queue", ":guildId"]
  handler: RouteHandler;
}

/**
 * Deliberately not a framework: method + path segment matching with
 * `:param` captures, nothing else. Covers 100% of what this app's REST
 * surface needs (see doc §3) without pulling in Express/Hono.
 */
export class Router {
  private routes: Route[] = [];

  get(path: string, handler: RouteHandler) {
    this.add("GET", path, handler);
  }
  post(path: string, handler: RouteHandler) {
    this.add("POST", path, handler);
  }
  patch(path: string, handler: RouteHandler) {
    this.add("PATCH", path, handler);
  }
  delete(path: string, handler: RouteHandler) {
    this.add("DELETE", path, handler);
  }

  private add(method: Method, path: string, handler: RouteHandler) {
    const segments = path.split("/").filter(Boolean);
    this.routes.push({ method, segments, handler });
  }

  private match(method: Method, pathname: string): { handler: RouteHandler; params: Record<string, string> } | null {
    const pathSegments = pathname.split("/").filter(Boolean);

    for (const route of this.routes) {
      if (route.method !== method) continue;
      if (route.segments.length !== pathSegments.length) continue;

      const params: Record<string, string> = {};
      let matched = true;

      for (let i = 0; i < route.segments.length; i++) {
        const routeSeg = route.segments[i];
        const pathSeg = pathSegments[i];
        if (routeSeg.startsWith(":")) {
          params[routeSeg.slice(1)] = decodeURIComponent(pathSeg);
        } else if (routeSeg !== pathSeg) {
          matched = false;
          break;
        }
      }

      if (matched) return { handler: route.handler, params };
    }
    return null;
  }

  async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const method = req.method as Method;

    const found = this.match(method, url.pathname);
    if (!found) {
      return Response.json({ error: { code: "not_found", message: `No route for ${method} ${url.pathname}` } }, { status: 404 });
    }

    try {
      return await found.handler({ req, params: found.params, query: url.searchParams });
    } catch (err) {
      // Every route is wrapped this way so thrown errors become a
      // consistent JSON error shape (see doc §12), logged by the caller.
      console.error(`[router] ${method} ${url.pathname} threw:`, err);
      const message = err instanceof Error ? err.message : "Internal error";
      return Response.json({ error: { code: "internal_error", message } }, { status: 500 });
    }
  }
}

/** Small helper for routes that expect a JSON body. */
export async function jsonBody<T>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new Error("Invalid JSON body");
  }
}
