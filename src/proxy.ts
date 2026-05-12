import { EnvHttpProxyAgent, fetch as undiciFetch, setGlobalDispatcher } from "undici";
import type { CodeCatConfig, ProxyConfig } from "./types.js";

let activeProxyKey: string | undefined;

export function configureHttpProxy(config: CodeCatConfig): boolean {
  if (!hasProxy(config.proxy)) {
    return false;
  }

  const proxyKey = JSON.stringify(config.proxy);
  if (activeProxyKey === proxyKey) {
    return true;
  }

  const dispatcher = new EnvHttpProxyAgent({
    httpProxy: config.proxy.httpProxy,
    httpsProxy: config.proxy.httpsProxy,
    noProxy: config.proxy.noProxy,
  });

  setGlobalDispatcher(dispatcher);
  globalThis.fetch = ((input: unknown, init?: unknown) => {
    const requestInit = init && typeof init === "object" ? init : {};
    return undiciFetch(input as Parameters<typeof undiciFetch>[0], {
      ...requestInit,
      dispatcher,
    } as Parameters<typeof undiciFetch>[1]);
  }) as unknown as typeof globalThis.fetch;

  activeProxyKey = proxyKey;
  return true;
}

export function renderProxySummary(proxy: ProxyConfig): string {
  if (!hasProxy(proxy)) {
    return "disabled";
  }

  const parts = [
    proxy.httpProxy ? `HTTP=${maskProxyUrl(proxy.httpProxy)}` : undefined,
    proxy.httpsProxy ? `HTTPS=${maskProxyUrl(proxy.httpsProxy)}` : undefined,
    proxy.noProxy ? `NO_PROXY=${proxy.noProxy}` : undefined,
  ].filter(Boolean);

  return parts.join(", ");
}

function hasProxy(proxy: ProxyConfig): boolean {
  return Boolean(proxy.httpProxy || proxy.httpsProxy);
}

function maskProxyUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.username || url.password) {
      url.username = "****";
      url.password = "****";
    }
    return url.toString();
  } catch {
    return value.replace(/\/\/[^/@\s]+@/, "//****:****@");
  }
}
