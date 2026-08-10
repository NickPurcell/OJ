/**
 * The contract between a worker and OJO: one JSON file at a known path.
 *
 * A worker is a language model with a filesystem, so this module assumes the
 * report is *approximately* right rather than exactly right. It tolerates the
 * things models actually do — fencing the JSON in a code block, adding fields
 * nobody asked for, writing "BLOCKING" where the schema says "blocking" — and
 * refuses the things that would make a review meaningless, like a finding with
 * no text in it.
 *
 * It also re-checks the survival rule. The kickoff prompt tells the worker that
 * a finding lives only if at least two of its three adversarial verifiers
 * failed to refute it, and the worker is expected to have already dropped the
 * rest. Enforcing it again here is not distrust of the worker so much as
 * distrust of the situation: this is the one rule standing between "the model
 * noticed something" and "a human is asked to change their code", and it costs
 * ten lines to make it structural instead of aspirational.
 */

export const REPORT_SCHEMA_VERSION = 1;

export type Severity = 'blocking' | 'non-blocking';

/** The three angles a finding must survive. See OJ.md for what each one asks. */
export type Lens = 'correctness' | 'security' | 'reproduction';

export type VerifierVerdict = {
  lens: Lens;
  /** True when this verifier believes the finding is wrong. Uncertainty refutes. */
  refuted: boolean;
  note: string;
};

export type Finding = {
  id: string;
  title: string;
  severity: Severity;
  /** Free text: "correctness", "security", "test coverage", … Used for grouping. */
  category: string;
  /** Repo-relative path, or null when the finding is about the change as a whole. */
  file: string | null;
  /** Line in the *head* revision, or null. Drives inline comment placement. */
  line: number | null;
  confidence: 'high' | 'medium' | 'low';
  /** The finding itself, in markdown. What is wrong, why it matters, what to do. */
  body: string;
  verifiers: VerifierVerdict[];
};

export type Report = {
  schemaVersion: number;
  /** Two or three sentences a human can read instead of the findings. */
  summary: string;
  findings: Finding[];
  /** Anything the worker wants to say that is not a finding. Often "what I could not check". */
  notes: string;
  /** The head SHA the worker believes it reviewed. Cross-checked against ours. */
  reviewedHeadSha: string | null;
  /** The review dimensions the finders were fanned out across, for the footer. */
  dimensions: string[];
};

export type ParseResult =
  | { ok: true; report: Report; dropped: DroppedFinding[] }
  | { ok: false; error: string };

export type DroppedFinding = { title: string; reason: string };

function asString(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return fallback;
}

function asNullableString(value: unknown): string | null {
  const text = asString(value).trim();
  return text.length > 0 ? text : null;
}

function asLine(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n < 1) return null;
  return Math.floor(n);
}

function asSeverity(value: unknown): Severity {
  const text = asString(value).toLowerCase().replace(/[\s_]+/g, '-');
  // Anything unrecognised is non-blocking on purpose. The failure mode of
  // guessing wrong in this direction is a comment nobody had to act on; the
  // other direction blocks a merge on a typo in a field name.
  return text === 'blocking' ? 'blocking' : 'non-blocking';
}

function asConfidence(value: unknown): Finding['confidence'] {
  const text = asString(value).toLowerCase();
  return text === 'high' || text === 'medium' || text === 'low' ? text : 'medium';
}

function asLens(value: unknown): Lens | null {
  const text = asString(value).toLowerCase();
  if (text === 'correctness') return 'correctness';
  if (text === 'security') return 'security';
  if (text === 'reproduction' || text === 'reproducibility' || text === 'repro') {
    return 'reproduction';
  }
  return null;
}

function asVerifiers(value: unknown): VerifierVerdict[] {
  if (!Array.isArray(value)) return [];
  const verdicts: VerifierVerdict[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const lens = asLens(record['lens']);
    if (lens === null) continue;
    verdicts.push({
      lens,
      // Only an explicit `false` clears a finding. A verifier that omitted the
      // field, or wrote prose into it, has not said "this holds up" — and the
      // whole design of the verify step is that silence means refuted.
      refuted: record['refuted'] !== false,
      note: asString(record['note'] ?? record['reasoning']).slice(0, 2000),
    });
  }
  return verdicts;
}

/**
 * Pull a JSON object out of whatever the worker wrote.
 *
 * Workers are told to write bare JSON and mostly do. The two failures seen in
 * practice are a ```json fence and a sentence before the object; both are
 * recoverable and neither is worth losing a review over. Brace-matching rather
 * than a regex because finding bodies contain braces.
 */
function extractJson(raw: string): string | null {
  const text = raw.trim();
  if (text.startsWith('{')) return text;

  const fenced = /```(?:json)?\s*\n([\s\S]*?)\n?```/.exec(text);
  if (fenced?.[1]) return fenced[1].trim();

  const start = text.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

export function parseReport(raw: string): ParseResult {
  const json = extractJson(raw);
  if (json === null) {
    return { ok: false, error: 'no JSON object found in the report file' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    return {
      ok: false,
      error: `report is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: 'report must be a JSON object' };
  }

  const record = parsed as Record<string, unknown>;
  const rawFindings = record['findings'];
  if (rawFindings !== undefined && !Array.isArray(rawFindings)) {
    return { ok: false, error: '`findings` must be an array' };
  }

  const findings: Finding[] = [];
  const dropped: DroppedFinding[] = [];

  for (const [index, entry] of (rawFindings ?? []).entries()) {
    if (typeof entry !== 'object' || entry === null) {
      dropped.push({ title: `finding ${index}`, reason: 'not an object' });
      continue;
    }
    const item = entry as Record<string, unknown>;
    const title = asString(item['title']).trim();
    const body = asString(item['body'] ?? item['description']).trim();

    // A finding with neither a title nor a body is not a finding. Posting it
    // would put an empty bullet in front of a human and waste their attention,
    // which is the resource this whole service exists to spend carefully.
    if (!title && !body) {
      dropped.push({ title: `finding ${index}`, reason: 'no title and no body' });
      continue;
    }

    const verifiers = asVerifiers(item['verifiers']);
    const survived = verifiers.filter((verdict) => !verdict.refuted).length;

    // The 2-of-3 rule, enforced rather than trusted. A worker that reported no
    // verifiers at all did not run the workflow it was asked to run, so its
    // findings have not earned a human's time either.
    if (verifiers.length === 0) {
      dropped.push({ title: title || `finding ${index}`, reason: 'no verifier verdicts recorded' });
      continue;
    }
    if (survived < 2) {
      dropped.push({
        title: title || `finding ${index}`,
        reason: `only ${survived}/${verifiers.length} verifiers failed to refute it`,
      });
      continue;
    }

    findings.push({
      id: asString(item['id'], `f${index + 1}`),
      title: title || body.slice(0, 80),
      severity: asSeverity(item['severity']),
      category: asString(item['category'], 'general'),
      file: asNullableString(item['file'] ?? item['path']),
      line: asLine(item['line']),
      confidence: asConfidence(item['confidence']),
      body: body || title,
      verifiers,
    });
  }

  const dimensions = Array.isArray(record['dimensions'])
    ? record['dimensions'].map((value) => asString(value)).filter(Boolean)
    : [];

  return {
    ok: true,
    dropped,
    report: {
      schemaVersion: Number(record['schemaVersion']) || REPORT_SCHEMA_VERSION,
      summary: asString(record['summary']).trim(),
      findings,
      notes: asString(record['notes']).trim(),
      reviewedHeadSha: asNullableString(record['reviewedHeadSha'] ?? record['headSha']),
      dimensions,
    },
  };
}

export function blockingFindings(report: Report): Finding[] {
  return report.findings.filter((finding) => finding.severity === 'blocking');
}

const SEVERITY_LABEL: Record<Severity, string> = {
  blocking: '🔴 Blocking',
  'non-blocking': '🟡 Non-blocking',
};

/**
 * Render the review body.
 *
 * `locateInBody` is true when the inline comments could not be posted — the
 * file and line then have to appear in the prose, or a finding about line 340
 * of a 900-line file becomes a scavenger hunt.
 */
export function renderReviewBody(
  report: Report,
  context: {
    headSha: string;
    round: number;
    verdictMode: string;
    downgraded: boolean;
    locateInBody: boolean;
    dropped: DroppedFinding[];
  },
): string {
  const blocking = report.findings.filter((f) => f.severity === 'blocking');
  const nonBlocking = report.findings.filter((f) => f.severity !== 'blocking');
  const lines: string[] = [];

  lines.push('## OJ review');
  lines.push('');
  lines.push(report.summary || '_No summary was produced._');
  lines.push('');

  if (report.findings.length === 0) {
    lines.push('**No findings survived verification.**');
    lines.push('');
    lines.push(
      'Every candidate issue was put to three adversarial verifiers and none of them ' +
        'held up. That is a statement about this sweep, not a guarantee about the code.',
    );
  } else {
    lines.push(
      `**${blocking.length} blocking**, **${nonBlocking.length} non-blocking** ` +
        `finding${report.findings.length === 1 ? '' : 's'} survived verification.`,
    );
  }
  lines.push('');

  for (const group of [blocking, nonBlocking]) {
    for (const finding of group) {
      const location =
        context.locateInBody && finding.file
          ? ` — \`${finding.file}${finding.line ? `:${finding.line}` : ''}\``
          : '';
      lines.push(`### ${SEVERITY_LABEL[finding.severity]} · ${finding.title}${location}`);
      lines.push('');
      lines.push(finding.body);
      lines.push('');
      const survived = finding.verifiers.filter((v) => !v.refuted);
      lines.push(
        `<sub>${finding.category} · ${finding.confidence} confidence · survived ` +
          `${survived.length}/${finding.verifiers.length} verifiers ` +
          `(${survived.map((v) => v.lens).join(', ') || 'none'})</sub>`,
      );
      lines.push('');
    }
  }

  if (report.notes) {
    lines.push('---');
    lines.push('');
    lines.push('**Notes**');
    lines.push('');
    lines.push(report.notes);
    lines.push('');
  }

  const footer: string[] = [];
  footer.push(`round ${context.round} · head \`${context.headSha.slice(0, 8)}\``);
  if (report.dimensions.length > 0) footer.push(`dimensions: ${report.dimensions.join(', ')}`);
  if (context.dropped.length > 0) {
    footer.push(`${context.dropped.length} candidate finding(s) dropped before posting`);
  }
  if (context.downgraded) {
    // Say so out loud. A reader who sees COMMENT on a review full of blocking
    // findings should know the verdict was capped by config rather than that
    // OJ thought the blockers were fine.
    footer.push(
      `verdict capped to COMMENT by \`verdictMode: ${context.verdictMode}\` — ` +
        'blocking findings did not block',
    );
  }
  footer.push('OJ read only the base branch for its instructions');

  lines.push('---');
  lines.push(`<sub>${footer.join(' · ')}</sub>`);

  return lines.join('\n');
}

/**
 * Findings that can be attached to a specific line of the diff.
 *
 * Deliberately conservative: only findings that named both a file and a line
 * become inline comments, because GitHub rejects the entire review if one
 * location is off the diff and a half-remembered path is not worth that risk.
 */
export function inlineCommentsFor(report: Report): Array<{ path: string; line: number; body: string }> {
  return report.findings
    .filter((finding): finding is Finding & { file: string; line: number } =>
      Boolean(finding.file && finding.line))
    .map((finding) => ({
      path: finding.file,
      line: finding.line,
      body: `**${SEVERITY_LABEL[finding.severity]} · ${finding.title}**\n\n${finding.body}`,
    }));
}
