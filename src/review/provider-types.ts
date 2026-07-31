/** All providers AlphaPR can route review calls to. Add new providers here ONLY. */
export const PROVIDERS = ["openrouter", "anthropic", "openai"] as const;

export type Provider = (typeof PROVIDERS)[number];

/** Type-safe narrowing from an arbitrary string (e.g. a raw DB column) to a real Provider. */
export function parseProvider(value: string): Provider {
  if ((PROVIDERS as readonly string[]).includes(value)) return value as Provider;
  console.warn(`parseProvider: unrecognized provider "${value}", falling back to openrouter`);
  return "openrouter";
}