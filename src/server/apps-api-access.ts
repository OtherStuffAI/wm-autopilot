import type { AccessAction } from "../auth/access-control";

export interface AppAccessActions {
  AppsLifecycle: AccessAction;
  AppsManage: AccessAction;
  AppsRead: AccessAction;
  AppsSelfManage: AccessAction;
}

export function appRouteAccessAction(
  method: string,
  parts: string[],
  actions: AppAccessActions,
): AccessAction {
  if (method === "GET" || method === "HEAD") return actions.AppsRead;
  const operation = parts[4];
  if (
    operation === "domains"
    || operation === "caprover"
    || operation === "deploy-to-caprover"
    || operation === "legacy-custody-migration"
  ) {
    return actions.AppsManage;
  }
  return actions.AppsSelfManage;
}

export function appCommandAccessAction(action: string, actions: AppAccessActions): AccessAction {
  if (action === "review-wapp-tower-broker") return actions.AppsManage;
  if (action === "start" || action === "stop" || action === "restart") return actions.AppsLifecycle;
  return actions.AppsSelfManage;
}
