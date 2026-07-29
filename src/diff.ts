export interface ParsedDiff {
  /** path → set of new-file line numbers that can be anchored */
  validLines: Map<string, Set<number>>;
  /** the diff with every right-side line prefixed by its line number */
  annotated: string;
}

/** Simple glob match: supports leading dir prefixes ("dist/") and "*.ext" suffixes. */
function matchesIgnore(path: string, patterns: string[]): boolean {
  for (const raw of patterns) {
    const p = raw.trim();
    if (!p) continue;
    if (p.endsWith("/") && path.startsWith(p)) return true;
    if (p.startsWith("*.") && path.endsWith(p.slice(1))) return true;
    if (path === p) return true;
  }
  return false;
}

export function parseDiff(diff: string, ignorePaths: string[] = []): ParsedDiff {
  const validLines = new Map<string, Set<number>>();
  const out: string[] = [];
  let currentPath: string | null = null;
  let ignoring = false;
  let newLine = 0;
  let inHunk = false; // true once we've seen "@@" for the current file

  let pendingFileHeaders: string[] = [];

  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git")) {
      currentPath = null;
      ignoring = false;
      inHunk = false;
      pendingFileHeaders = [line];
      continue;
    }

    // Still in the pre-body header zone for this file: buffer everything
    // until +++ confirms the path (or another diff --git starts a new file).
    if (pendingFileHeaders.length > 0 && !inHunk && !line.startsWith("+++ ")) {
      pendingFileHeaders.push(line);
      continue;
    }

    if (line.startsWith("+++ ")) {
      currentPath = line.startsWith("+++ b/") ? line.slice(6) : null;
      ignoring = currentPath ? matchesIgnore(currentPath, ignorePaths) : false;
      if (currentPath && !ignoring && !validLines.has(currentPath)) {
        validLines.set(currentPath, new Set());
      }
      if (!ignoring) {
        out.push(...pendingFileHeaders);
        out.push(line);
      }
      pendingFileHeaders = [];
      continue;
    }

    if (ignoring) continue;

    if (line.startsWith("@@")) {
      inHunk = true; // from here on, "--- " means content, not a header
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
      out.push(line);
    } else if (line.startsWith("\\")) {
      out.push(line);
    } else if (line === "") {
      out.push(line);
    } else {
      validLines.get(currentPath)!.add(newLine);
      out.push(`${newLine}: ${line}`);
      newLine++;
    }
  }

  return { validLines, annotated: out.join("\n") };
}
