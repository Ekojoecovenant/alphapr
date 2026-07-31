// src/scratch-test-2.ts — temporary, will be deleted after verification

export async function processFile(path: string): Promise<string> {
  const handle = await openFile(path);
  try {
    const data = await handle.read();
    return data;
  } finally {
    handle.close();
  }
}

async function openFile(path: string): Promise<{ read: () => Promise<string>; close: () => void }> {
  return { read: async () => "stub", close: () => {} };
}