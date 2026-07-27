// Temporary file for line-anchoring verification — will be reverted.

export function divideValues(a: number, b: number): number {
  return a / b; // no zero check
}

export function getUserEmail(users: { email: string }[], index: number): string {
  return users[index].email; // no bounds check
}

export function parseConfig(raw: string): object {
  const config = JSON.parse(raw); // unhandled throw on invalid JSON
  const apiKey = "sk-live-hardcoded-secret-12345"; // planted secret
  return { config, apiKey };
}