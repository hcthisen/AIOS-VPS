import type { Provider } from "./executor";
import { anthropicAuthDetected, codexAuthDetected } from "./provider-auth";

export interface ProviderAvailability {
  "claude-code": boolean;
  codex: boolean;
}

export async function getProviderAvailability(): Promise<ProviderAvailability> {
  const [claudeCode, codex] = await Promise.all([
    anthropicAuthDetected(),
    codexAuthDetected(),
  ]);
  return { "claude-code": claudeCode, codex };
}

export async function isProviderAuthorized(provider: Provider): Promise<boolean> {
  const providers = await getProviderAvailability();
  return providers[provider];
}

export function displayProvider(provider: Provider): string {
  return provider === "codex" ? "Codex" : "Claude Code";
}

export function parseProvider(value: unknown): Provider | undefined {
  return value === "claude-code" || value === "codex" ? value : undefined;
}
