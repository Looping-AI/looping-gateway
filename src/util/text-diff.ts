// Word-level diffing for Slack message edits. A remote agent already holds the
// full prior message in its session, so an edit feed turn should carry only what
// changed — the diff plus a little surrounding context — not both full bodies.
// Edits can touch several separate spots in one message, so this produces one
// hunk per changed region (merging regions that sit close together).

/** Collapse runs of whitespace to a single space and trim the ends. */
export function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

// Ceiling on the rendered diff. Past this the message was largely rewritten and
// a per-word diff would be bigger than resending both bodies (self-defeating), so
// we fall back to a head…tail peek of the *old* text plus the *new* text in full.
// The agent still holds the prior message in session, so the old side can be a
// peek — but it has never seen the edited result, so the new side must go whole.
const MAX_DIFF_CHARS = 800;

type Op =
  | { kind: "equal"; text: string }
  | { kind: "del"; text: string }
  | { kind: "add"; text: string };

/** A coalesced run: either unchanged text or a replace/insert/delete. */
type Segment = { equal: string } | { removed: string; added: string };

/** Split into word + whitespace tokens, preserving whitespace as its own tokens. */
function tokenize(s: string): string[] {
  return s.split(/(\s+)/).filter((t) => t.length > 0);
}

/** LCS-based token diff (O(n·m) DP — Slack messages are short). */
function diffTokens(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  // dp[i][j] = length of the LCS of a[i:] and b[j:].
  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0)
  );
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] =
        a[i] === b[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: "equal", text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ kind: "del", text: a[i] });
      i++;
    } else {
      ops.push({ kind: "add", text: b[j] });
      j++;
    }
  }
  while (i < n) ops.push({ kind: "del", text: a[i++] });
  while (j < m) ops.push({ kind: "add", text: b[j++] });
  return ops;
}

/**
 * Coalesce ops into strictly-alternating segments: an `equal` run, then a
 * `{removed, added}` change run, then `equal`, and so on.
 */
function toSegments(ops: Op[]): Segment[] {
  const segments: Segment[] = [];
  let equalBuf = "";
  let removedBuf = "";
  let addedBuf = "";
  const flushEqual = () => {
    if (equalBuf) {
      segments.push({ equal: equalBuf });
      equalBuf = "";
    }
  };
  const flushChange = () => {
    if (removedBuf || addedBuf) {
      segments.push({ removed: removedBuf, added: addedBuf });
      removedBuf = "";
      addedBuf = "";
    }
  };
  for (const op of ops) {
    if (op.kind === "equal") {
      flushChange();
      equalBuf += op.text;
    } else if (op.kind === "del") {
      flushEqual();
      removedBuf += op.text;
    } else {
      flushEqual();
      addedBuf += op.text;
    }
  }
  flushEqual();
  flushChange();
  return segments;
}

function isChange(s: Segment): s is { removed: string; added: string } {
  return "removed" in s;
}

/** wdiff-style inline marker for one change segment. */
function renderChange(seg: { removed: string; added: string }): string {
  let out = "";
  if (seg.removed) out += `[-${seg.removed}-]`;
  if (seg.added) out += `[+${seg.added}+]`;
  return out;
}

/**
 * Render the edit between `prevText` and `nextText` as a compact set of hunks.
 * Each hunk is a changed region marked wdiff-style (`[-old-][+new+]`) with up to
 * `contextChars` of unchanged text on each side (an `…` marks a truncated edge).
 * Changed regions separated by ≤ `2·contextChars` of unchanged text are merged
 * into one hunk, with the connecting text shown in full. Hunks are newline-joined.
 *
 * Callers must have already filtered no-op edits via {@link normalizeWhitespace}.
 */
export function renderEditDiff(
  prevText: string,
  nextText: string,
  contextChars = 25
): string {
  const segments = toSegments(
    diffTokens(tokenize(prevText), tokenize(nextText))
  );

  // Indices of the change segments, grouped so that changes close together
  // (separated by a short equal run) share one hunk.
  const groups: number[][] = [];
  for (let idx = 0; idx < segments.length; idx++) {
    if (!isChange(segments[idx])) continue;
    const lastGroup = groups[groups.length - 1];
    if (lastGroup) {
      const prevIdx = lastGroup[lastGroup.length - 1];
      // Segments strictly alternate, so the gap between two changes is the single
      // equal segment at prevIdx + 1.
      const between = segments[prevIdx + 1];
      const gap = between && !isChange(between) ? between.equal.length : 0;
      if (gap <= 2 * contextChars) {
        lastGroup.push(idx);
        continue;
      }
    }
    groups.push([idx]);
  }

  if (groups.length === 0) return ""; // token-identical — shouldn't reach here; caller filters no-ops

  const hunks = groups.map((group) => {
    const parts: string[] = [];

    // Left context: trailing contextChars of the equal segment before the group.
    const leftSeg = segments[group[0] - 1];
    const leftFull = leftSeg && !isChange(leftSeg) ? leftSeg.equal : "";
    parts.push(
      (leftFull.length > contextChars ? "…" : "") +
        leftFull.slice(-contextChars)
    );

    // The change segments, with any (short) connecting equal text shown in full.
    for (let gi = 0; gi < group.length; gi++) {
      parts.push(
        renderChange(segments[group[gi]] as { removed: string; added: string })
      );
      if (gi < group.length - 1) {
        const between = segments[group[gi] + 1];
        if (between && !isChange(between)) parts.push(between.equal);
      }
    }

    // Right context: leading contextChars of the equal segment after the group.
    const rightSeg = segments[group[group.length - 1] + 1];
    const rightFull = rightSeg && !isChange(rightSeg) ? rightSeg.equal : "";
    parts.push(
      rightFull.slice(0, contextChars) +
        (rightFull.length > contextChars ? "…" : "")
    );

    return parts.join("");
  });

  const rendered = hunks.join("\n");
  if (rendered.length <= MAX_DIFF_CHARS) return rendered;

  // Wholesale rewrite — the per-word diff isn't buying anything. Peek the old
  // side (the agent already has it in session) but send the new side in full,
  // since that's the only place the agent learns the edited content.
  const prevPeek =
    prevText.length > 2 * contextChars + 1
      ? `${prevText.slice(0, contextChars)}…${prevText.slice(-contextChars)}`
      : prevText;
  return `[-${prevPeek}-][+${nextText}+]`;
}
