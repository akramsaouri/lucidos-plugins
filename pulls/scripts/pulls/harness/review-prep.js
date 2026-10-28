export const meta = {
  name: 'review-prep',
  description:
    'Max-level multi-agent READ-ONLY code review of one pull request at one exact commit. Scope -> parallel finders -> one adversarial verifier per distinct (file,line) -> CI/completeness sweep -> verify2 -> synthesize. Returns the FULL verified set with evidence and pre-existing verdicts, never a 15-item display slice. Everything PR-specific arrives in args; this file is the reusable machinery for the Lucidos review-prep rail.',
  phases: [
    { title: 'Scope', detail: 'Map the diff into review surfaces' },
    { title: 'Find', detail: 'Correctness angles + one cleanup finder, in parallel' },
    { title: 'Verify', detail: 'One adversarial verifier per distinct (file,line)' },
    { title: 'Sweep', detail: 'Run the repo CI toolchain, then criticise the review itself' },
    { title: 'Verify2', detail: 'Verify sweep candidates at locations round 1 never reached' },
    { title: 'Synthesize', detail: 'Rank, fold restatements, choose the display slice' },
  ],
}

// ---------------------------------------------------------------------------
// args contract (all supplied by the calling review-prep session)
//
//   pr        { org, repo, number, title, author, head_sha, base_ref,
//               files_changed, additions, deletions }
//   spec      the diff spec, ALWAYS origin/<base>...<head_sha>
//   toolchain free text: which checks are runnable here and which are not
//   notes     free text appended to every agent prompt (repo conventions, traps)
//   finders   [ { key, prompt } ]  per-PR correctness angles + a cleanup angle
//   sweeps    [ { key, prompt } ]  CI / completeness passes
//   verify_cap optional integer, default 88
// ---------------------------------------------------------------------------

const A = (typeof args === 'object' && args) || {}
const PR = A.pr || {}
const SPEC = A.spec
const VERIFY_CAP = A.verify_cap || 88

if (!SPEC) throw Error('review-prep: args.spec is required (origin/<base>...<head_sha>)')
if (!PR.head_sha) throw Error('review-prep: args.pr.head_sha is required')
if (!Array.isArray(A.finders) || A.finders.length === 0) throw Error('review-prep: args.finders must be a non-empty array')

const SLUG = PR.org + '/' + PR.repo + '#' + PR.number
const BASE = 'origin/' + (PR.base_ref || 'main')

const COMMON = [
  'You are reviewing pull request ' + SLUG + ', titled "' + (PR.title || '') + '", authored by ' + (PR.author || 'unknown') + '.',
  'The working directory IS the PR head (' + PR.head_sha + '); the session branch was reset onto it. Do not check out anything else, and do not reset or rebase anything.',
  'The diff under review is exactly: git diff ' + SPEC + '   -> ' + PR.files_changed + ' files, +' + PR.additions + ' -' + PR.deletions + '. Nothing outside that range is in scope.',
  'READ-ONLY, HARD: never edit, create or delete a tracked file in the repo; never commit, never push, never touch GitHub in any way (no gh pr comment, no gh pr review, no labels, no approvals). Running builds and tests IS allowed and encouraged.',
  'Scratch files go in /tmp, NEVER inside the repository — an untracked file in the worktree breaks the rail\'s clean-exit invariant.',
  A.toolchain ? 'TOOLCHAIN: ' + A.toolchain : '',
  'EXIT CODES: capture rc BEFORE any pipe (cmd > /tmp/x.log 2>&1; rc=$?) and `test -x` / `command -v` the binary before believing a zero. A missing binary reporting 0 through a pipe is a FALSE CLEAN, which is worse than no check at all.',
  'DATABASE_URL: this session has one injected by the host. Any check that touches a connection string must be run with it explicitly removed (env -u DATABASE_URL) or replaced, or the result describes the host environment rather than the PR.',
  'Report every path REPO-RELATIVE (e.g. lib/config.ts), never absolute, never with a worktree prefix.',
  'Line numbers refer to the file AS IT IS AT THE PR HEAD (the working tree you are in).',
  A.notes || '',
].filter(Boolean).join('\n')

const CAND_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['candidates'],
  properties: {
    candidates: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['file', 'line', 'category', 'summary', 'failure_scenario'],
        properties: {
          file: { type: 'string', description: 'repo-relative path' },
          line: { type: 'integer' },
          category: {
            type: 'string',
            enum: ['correctness', 'security', 'performance', 'test-coverage', 'convention', 'cleanup'],
          },
          summary: { type: 'string' },
          failure_scenario: {
            type: 'string',
            description: 'concrete inputs/state -> wrong output, wrong render, data loss, or crash',
          },
          evidence: { type: 'string', description: 'quoted source lines or literal command output' },
        },
      },
    },
  },
}

const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdicts'],
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'candidate_index', 'file', 'line', 'verdict', 'category',
          'summary', 'failure_scenario', 'evidence', 'reproduced',
          'is_test', 'pre_existing', 'severity',
        ],
        properties: {
          candidate_index: { type: 'integer' },
          file: { type: 'string' },
          line: { type: 'integer' },
          verdict: { type: 'string', enum: ['CONFIRMED', 'PLAUSIBLE', 'REFUTED'] },
          category: {
            type: 'string',
            enum: ['correctness', 'security', 'performance', 'test-coverage', 'convention', 'cleanup'],
          },
          severity: { type: 'string', enum: ['blocking', 'should-fix', 'nit'] },
          summary: { type: 'string' },
          failure_scenario: { type: 'string' },
          evidence: { type: 'string', description: 'MANDATORY quoted source lines or literal command output' },
          reproduced: { type: 'boolean', description: 'true ONLY if something you executed demonstrated it' },
          is_test: { type: 'boolean' },
          pre_existing: {
            type: 'string',
            enum: ['yes', 'no', 'not-checked'],
            description: 'yes = the same defect is already present at the base; not-checked = you did not run the comparison',
          },
          pre_existing_evidence: { type: 'string', description: 'the command you ran against the base and what it showed' },
        },
      },
    },
  },
}

// ---------------------------------------------------------------------------

phase('Scope')
log('Scoping ' + SLUG + ' at ' + String(PR.head_sha).slice(0, 7) + ' — ' + PR.files_changed + ' files, +' + PR.additions + ' -' + PR.deletions)

const scope = await agent(
  COMMON + '\n\n' + [
    'TASK — SCOPE. Produce the map the finders will work from.',
    'Run: git diff --stat ' + SPEC + '   and then read the full diff (git diff ' + SPEC + ').',
    'For every changed file, give: repo-relative path, kind (source | test | config | script | i18n | docs | qa-spec | lockfile), a one-line summary of what changed, and the sharpest risk you can name for a reviewer to chase.',
    'Then list the cross-cutting themes — the things that span files and that a per-file reader would miss.',
    'Do not report findings. This is a map, not a review.',
  ].join('\n'),
  {
    label: 'scope',
    phase: 'Scope',
    effort: 'high',
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['files', 'themes'],
      properties: {
        files: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['path', 'kind', 'summary', 'risk'],
            properties: {
              path: { type: 'string' },
              kind: { type: 'string' },
              summary: { type: 'string' },
              risk: { type: 'string' },
            },
          },
        },
        themes: { type: 'array', items: { type: 'string' } },
      },
    },
  }
)

const scopeBrief = scope
  ? 'SCOPE MAP (from the scope agent — a starting point, not a boundary):\n' +
    scope.files.map(f => '- ' + f.path + ' [' + f.kind + '] ' + f.summary + ' | risk: ' + f.risk).join('\n') +
    '\nCross-cutting themes:\n' + scope.themes.map(t => '- ' + t).join('\n')
  : 'SCOPE MAP: unavailable (the scope agent failed) — derive the file list yourself from git diff --stat ' + SPEC + '.'

const FINDER_OUTPUT_RULES = [
  '',
  'OUTPUT RULES:',
  '- Report CANDIDATES, not verdicts. A later adversarial pass will try to refute each one, so recall matters more than precision here — but every candidate must name a concrete failure, not a vague worry.',
  '- Anchor each candidate to the (file, line) where a reader would FIX it, using the line numbers at this head.',
  '- Prefer proving something by running it over arguing it.',
  '- If you find nothing in your angle, return an empty list. An empty list is a real answer.',
].join('\n')

phase('Find')
log('Running ' + A.finders.length + ' finders in parallel')

const finderResults = await parallel(
  A.finders.map(f => () =>
    agent(
      COMMON + '\n\n' + scopeBrief + '\n\n' + f.prompt + '\n\n' + FINDER_OUTPUT_RULES,
      { label: 'find:' + f.key, phase: 'Find', schema: CAND_SCHEMA, effort: 'high' }
    )
  )
)

const round1 = finderResults.filter(Boolean).flatMap(r => r.candidates || [])
log('Finders returned ' + round1.length + ' candidates')

function byLocation(cands) {
  const map = new Map()
  for (const c of cands) {
    const key = c.file + ':' + c.line
    if (!map.has(key)) map.set(key, [])
    map.get(key).push(c)
  }
  return map
}

function verifyPrompt(loc, cands) {
  return COMMON + '\n\n' + [
    'TASK — ADVERSARIAL VERIFICATION at ' + loc + '.',
    'Parallel finders raised ' + cands.length + ' candidate(s) at this exact location. Your job is to TRY TO REFUTE each one, and to return one verdict PER CANDIDATE with its candidate_index — do NOT merge them. A differently-argued restatement is still its own row.',
    '',
    'CANDIDATES:',
    ...cands.map((c, i) => '[' + i + '] (' + c.category + ') ' + c.summary + '\n    failure scenario: ' + c.failure_scenario),
    '',
    'THE LADDER, and it is recall-biased on purpose:',
    '- CONFIRMED — you can construct the failure from the code, or better, you executed something that demonstrated it.',
    '- PLAUSIBLE — the argument holds but you could not close it (a path you could not fully trace, a runtime behaviour you could not exercise). THIS IS THE DEFAULT when you are unsure.',
    '- REFUTED — you can point at code that makes the failure impossible. Only refute when the counter-evidence is constructible from the source, never merely because the claim feels overstated.',
    '',
    'SEVERITY, on every verdict:',
    '- blocking — breaks the build, data, or customer-visible behaviour, introduced by this PR.',
    '- should-fix — a real correctness or behaviour risk worth raising with the author.',
    '- nit — convention, comment/docs wording, style, cleanup, or a missing test for an existing guard.',
    'CONFIRMED means the claim is true, severity means whether it matters; judge them independently. A true comment-wording issue is CONFIRMED + nit.',
    '',
    'EVIDENCE IS MANDATORY on every verdict and must contain a real quote — source lines with their file and line, or literal command output. A REFUTED verdict with no quoted counter-evidence is worthless; it is an unreviewable assertion.',
    'Prefer execution over argument. Run the type-check, run the specific test, write a scratch probe in /tmp if you need one. Set reproduced: true ONLY when something you ran actually demonstrated the defect.',
    '',
    'PRE-EXISTING CHECK — load-bearing on this rail, do not skip it and do not guess it.',
    'Some of these findings get posted to the PR as comments on the author. Nobody may be told they broke something that was already broken.',
    'For each candidate, establish whether the SAME defect already exists on the base branch:',
    '    git show ' + BASE + ':<path>        # the base file as it is on the remote base',
    'Use ' + BASE + ', NEVER the local branch of that name — this clone drifts from origin.',
    '  pre_existing: "yes"  -> the defect is already present at the base; this PR did not introduce it.',
    '  pre_existing: "no"   -> you ran the comparison and it genuinely is new (the line is new, or the base code lacks the flaw).',
    '  pre_existing: "not-checked" -> you did not run the check, or the comparison is not meaningful (a brand-new file).',
    'A guessed "no" is worse than "not-checked", because downstream treats "no" as "this PR introduced it". When you set yes or no, fill pre_existing_evidence with the command you ran and what it showed.',
    '',
    'is_test: true when the file is a test file (*.test.*, *_test.*, __tests__/, qa/spec/, supabase/tests/).',
  ].join('\n')
}

phase('Verify')
const locations1 = Array.from(byLocation(round1).entries()).slice(0, VERIFY_CAP)
log('Verifying ' + locations1.length + ' distinct locations')

const verified1 = await parallel(
  locations1.map(([loc, cands]) => () =>
    agent(verifyPrompt(loc, cands), {
      label: 'verify:' + loc,
      phase: 'Verify',
      schema: VERDICT_SCHEMA,
      effort: 'high',
    }).then(v => ({ loc, verifier: 'verify:' + loc, verdicts: (v && v.verdicts) || [] }))
  )
)

const kept1 = []
const refuted1 = []
for (const r of verified1.filter(Boolean)) {
  for (const v of r.verdicts) {
    const row = Object.assign({}, v, { verifier_agent: r.verifier })
    if (v.verdict === 'REFUTED') refuted1.push(row)
    else kept1.push(row)
  }
}
log('Round 1: ' + kept1.length + ' kept, ' + refuted1.length + ' refuted')

phase('Sweep')

const keptDigest = kept1.length
  ? kept1.map(f => '- [' + f.verdict + '] ' + f.file + ':' + f.line + ' — ' + f.summary).join('\n')
  : '(round 1 kept nothing)'

const sweeps = (A.sweeps || []).map(s => ({
  key: s.key,
  prompt: s.prompt.split('{{KEPT}}').join(keptDigest),
}))

const sweepResults = sweeps.length
  ? await parallel(
      sweeps.map(s => () =>
        agent(
          COMMON + '\n\n' + scopeBrief + '\n\n' + s.prompt + '\n\n' +
            'OUTPUT: candidates only, same rules as the finders — concrete failure, repo-relative path, line number at this head. An empty list is a real answer.',
          { label: 'sweep:' + s.key, phase: 'Sweep', schema: CAND_SCHEMA, effort: 'high' }
        )
      )
    )
  : []

const round2raw = sweepResults.filter(Boolean).flatMap(r => r.candidates || [])
const seenLocs = new Set(locations1.map(([loc]) => loc))
const round2 = round2raw.filter(c => !seenLocs.has(c.file + ':' + c.line))
log('Sweep returned ' + round2raw.length + ' candidates, ' + round2.length + ' at new locations')

phase('Verify2')
const locations2 = Array.from(byLocation(round2).entries()).slice(0, VERIFY_CAP)

const verified2 = locations2.length
  ? await parallel(
      locations2.map(([loc, cands]) => () =>
        agent(verifyPrompt(loc, cands), {
          label: 'verify2:' + loc,
          phase: 'Verify2',
          schema: VERDICT_SCHEMA,
          effort: 'high',
        }).then(v => ({ loc, verifier: 'verify2:' + loc, verdicts: (v && v.verdicts) || [] }))
      )
    )
  : []

const kept = kept1.slice()
const refuted = refuted1.slice()
for (const r of verified2.filter(Boolean)) {
  for (const v of r.verdicts) {
    const row = Object.assign({}, v, { verifier_agent: r.verifier })
    if (v.verdict === 'REFUTED') refuted.push(row)
    else kept.push(row)
  }
}

const confirmed = kept.filter(f => f.verdict === 'CONFIRMED')
const plausible = kept.filter(f => f.verdict === 'PLAUSIBLE')
log('Total: ' + kept.length + ' kept (' + confirmed.length + ' CONFIRMED, ' + plausible.length + ' PLAUSIBLE), ' + refuted.length + ' refuted')

phase('Synthesize')

const synth = await agent(
  COMMON + '\n\n' + [
    'TASK — SYNTHESIZE. You are choosing the severity-ranked display slice a human reviewer reads first.',
    'Here is every kept finding, as JSON:',
    JSON.stringify(kept.map((f, i) => ({
      i,
      file: f.file, line: f.line, verdict: f.verdict, severity: f.severity, category: f.category,
      summary: f.summary, reproduced: f.reproduced, is_test: f.is_test,
      pre_existing: f.pre_existing,
    })), null, 1),
    '',
    'Produce:',
    '1. `order` — the indices of ALL findings, ranked most-severe first. Rank by severity (blocking, should-fix, nit), then CONFIRMED above PLAUSIBLE; within a band put source files above test files; within that, rank a defect a user would hit above one only a maintainer would. A finding with pre_existing "yes" ranks BELOW an equally severe one this PR introduced, because it is not something the author did.',
    '2. `reported` — the indices of the top 15 (or fewer if there are fewer), the slice worth surfacing first.',
    '3. `merge_notes` — for any group of indices that argue the SAME defect at the same location, list them together with the index of the best-argued one first. Do not merge two genuinely distinct defects that happen to share a line.',
    '4. `blocking` — the indices of anything the reviewer would have to act on IMMEDIATELY: a build-breaker (a CI check that genuinely fails because of this PR), data loss, a security hole, or something that would embarrass the team in production. This list should usually be EMPTY. A CONFIRMED-but-cosmetic finding is not blocking, and neither is anything with pre_existing "yes".',
    '5. `verdict_summary` — 4 to 8 sentences a reviewer could read instead of the list: what this PR gets right, what the sharpest real problem is, and whether it is safe to merge as-is. Be honest and specific; if the strongest finding is minor, say that plainly rather than inflating it.',
    'Do not invent findings that are not in the list. Do not drop any index from `order`.',
  ].join('\n'),
  {
    label: 'synthesize',
    phase: 'Synthesize',
    effort: 'high',
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['order', 'reported', 'merge_notes', 'blocking', 'verdict_summary'],
      properties: {
        order: { type: 'array', items: { type: 'integer' } },
        reported: { type: 'array', items: { type: 'integer' } },
        blocking: { type: 'array', items: { type: 'integer' } },
        merge_notes: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['indices', 'note'],
            properties: {
              indices: { type: 'array', items: { type: 'integer' } },
              note: { type: 'string' },
            },
          },
        },
        verdict_summary: { type: 'string' },
      },
    },
  }
)

return {
  pr: PR,
  spec: SPEC,
  scope: scope,
  counts: {
    candidates_round1: round1.length,
    candidates_sweep: round2raw.length,
    candidates_sweep_new_locations: round2.length,
    locations_verified: locations1.length + locations2.length,
    kept: kept.length,
    confirmed: confirmed.length,
    plausible: plausible.length,
    refuted: refuted.length,
  },
  findings: kept,
  refuted: refuted,
  synthesis: synth,
}
