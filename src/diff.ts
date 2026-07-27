export interface ParsedDiff {
  /** path → set of new-file line numbers that can be anchored */
  validLines: Map<string, Set<number>>;
  /** the diff with every right-side line prefixed by its line number */
  annotated: string;
}

export function parseDiff(diff: string): ParsedDiff {
  const validLines = new Map<string, Set<number>>();
  const out: string[] = [];
  let currentPath: string | null = null;
  let newLine = 0;

  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git")) {
      currentPath = null;
      out.push(line);
      continue;
    }
    if (line.startsWith("+++ ")) {
      // "+++ b/src/foo.ts" → "src/foo.ts"; "+++ /dev/null" → deleted file, skip
      currentPath = line.startsWith("+++ b/") ? line.slice(6) : null;
      if (currentPath && !validLines.has(currentPath)) {
        validLines.set(currentPath, new Set());
      }
      out.push(line);
      continue;
    }
    if (line.startsWith("@@")) {
      const m = /\+(\d+)/.exec(line);
      newLine = m ? parseInt(m[1], 10) : 0;
      out.push(line);
      continue;
    }
    if (!currentPath) {
      out.push(line);
      continue;
    }
    if (line.startsWith("+")) {
      validLines.get(currentPath)!.add(newLine);
      out.push(`${newLine}: ${line}`);
      newLine++;
    } else if (line.startsWith("-")) {
      out.push(line); // removed lines have no new-file number
    } else {
      // context line — anchorable and numbered
      validLines.get(currentPath)!.add(newLine);
      out.push(`${newLine}: ${line}`);
      newLine++;
    }
  }

  return { validLines, annotated: out.join("\n") };
}