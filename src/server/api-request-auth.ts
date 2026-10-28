import { isAdminApiPath } from "../signing/admin-signing-policy";
import { runWithRequestContext, type RequestAuthContext } from "../auth/request-context";

type AuthResolver = (request: Request, url: URL, auth: RequestAuthContext) => Promise<RequestAuthContext>;

/** One verification per dispatch, not a reusable authorization or replay cache. */
export function createApiRequestAuth(resolve: AuthResolver) {
  const pending = new WeakMap<Request, Promise<RequestAuthContext>>();
  const resolveOnce: AuthResolver = (request, url, auth) => {
    let result = pending.get(request);
    if (!result) {
      result = resolve(request, url, auth);
      pending.set(request, result);
    }
    return result;
  };
  return {
    resolveOnce,
    async run<T>(request: Request, url: URL, auth: RequestAuthContext,
      handle: (effective: RequestAuthContext) => Promise<T>): Promise<T> {
      try {
        const effective = isAdminApiPath(url.pathname) ? await resolveOnce(request, url, auth) : auth;
        return await runWithRequestContext(effective, () => handle(effective));
      } finally { pending.delete(request); }
    },
  };
}
