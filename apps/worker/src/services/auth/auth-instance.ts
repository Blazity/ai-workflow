import type { Auth } from "better-auth";

/** Runtime binding installed by the app-tier auth instance. */
export let auth: Auth<any>;

export function installAuthInstance(instance: Auth<any>): void {
  auth = instance;
}
