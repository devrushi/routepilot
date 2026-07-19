// Minimal path-matching router for src/server.js. Still no framework —
// just enough to give routes real `:param` segments and keep server.js
// (and the growing set of src/routes/*.js files) from needing an
// unreadable if/else chain as more resources get their own routes.

export function createRouter() {
  const routes = [];

  function register(method, pattern, handler) {
    const paramNames = [];
    const regexSource = pattern
      .split('/')
      .map((segment) => {
        if (segment.startsWith(':')) {
          paramNames.push(segment.slice(1));
          return '([^/]+)';
        }
        return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      })
      .join('/');
    routes.push({ method, regex: new RegExp(`^${regexSource}$`), paramNames, handler });
  }

  /**
   * Find the handler registered for a method + pathname, decoding any
   * `:param` segments matched along the way.
   * @returns {{handler: Function, params: Record<string,string>} | null}
   */
  function match(method, pathname) {
    for (const route of routes) {
      if (route.method !== method) continue;
      const result = route.regex.exec(pathname);
      if (!result) continue;
      const params = {};
      route.paramNames.forEach((name, i) => {
        params[name] = decodeURIComponent(result[i + 1]);
      });
      return { handler: route.handler, params };
    }
    return null;
  }

  return {
    get: (pattern, handler) => register('GET', pattern, handler),
    post: (pattern, handler) => register('POST', pattern, handler),
    patch: (pattern, handler) => register('PATCH', pattern, handler),
    delete: (pattern, handler) => register('DELETE', pattern, handler),
    match,
  };
}
