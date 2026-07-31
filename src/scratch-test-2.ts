// src/scratch-test-2.ts — temporary, will be deleted after verification

export async function processFile(path: string): Promise<string> {
  const handle = await openFile(path);
  const data = await handle.read();
  return data;
}

async function openFile(path: string): Promise<{ read: () => Promise<string>; close: () => void }> {
  return { read: async () => "stub", close: () => {} };
}