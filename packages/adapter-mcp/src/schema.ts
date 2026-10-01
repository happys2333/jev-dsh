/**
 * The MCP tool surface, in one place: the names, the naming map back to the handoff's
 * `adl_*`, and the JSON Schemas that are both published to clients *and* used to validate
 * what comes in. One source on purpose — a schema that describes an input the handler then
 * checks differently is the same "declared but not enforced" defect this repository keeps
 * having to root out elsewhere.
 *
 * Note what no input schema accepts: a session id, an agent id, a `hostAttested` flag, an
 * endpoint, a model, a header, a key reference, or a policy mode. Spec §12 lets a caller
 * define the *questions* and forbids it from disguising those as a host-attested tool call
 * or from steering the transport, and `additionalProperties: false` is what makes that
 * enforceable rather than aspirational.
 *
 * @module
 */

/** The three tools v1 ships. No `jey_execute`, no `jey_set_policy` (spec §12). */
export const MCP_TOOL_NAMES = ['jev_check', 'jev_choose', 'jev_rank'] as const

export type McpToolName = (typeof MCP_TOOL_NAMES)[number]

/** Handoff §12 names these `adl_*`; this repository ships the `jey_*` names (see README). */
export const LEGACY_TOOL_NAMES: Readonly<Record<McpToolName, string>> = {
  jev_check: 'adl_check',
  jev_choose: 'adl_choose',
  jev_rank: 'adl_rank',
}

export const DEFAULT_RANK_LEVELS: readonly string[] = ['none applicable', 'poor', 'fair', 'good', 'strong']

const boundedText = (max: number, description: string) => ({
  type: 'string', minLength: 1, maxLength: max, description,
})

const distribution = {
  type: 'object',
  description: 'Probability per option or level, keyed by the option id or the level index as a decimal string.',
  additionalProperties: { type: 'number' },
}

const probabilityMetadata = {
  type: 'object',
  additionalProperties: false,
  required: ['origin', 'calibration', 'calibrationId'],
  properties: {
    origin: { type: 'string', enum: ['native-logits', 'provider-distribution', 'synthetic'] },
    calibration: { type: 'string', enum: ['uncalibrated', 'provider-reported', 'held-out'] },
    calibrationId: { type: ['string', 'null'] },
  },
}

const providerIdentity = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'resolvedModel', 'synthetic'],
  properties: {
    kind: { type: 'string' },
    resolvedModel: boundedText(200, 'What the answering side says it is.'),
    synthetic: {
      type: 'boolean',
      description: 'True when the answer came from a synthetic stand-in. A synthetic answer is never a qualified judgement.',
    },
  },
}

const answerHeader = {
  requestId: { type: 'string' },
  provider: providerIdentity,
}

export const TOOL_INPUT_SCHEMAS: Readonly<Record<McpToolName, object>> = {
  jev_check: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    additionalProperties: false,
    required: ['claim', 'evidence'],
    properties: {
      claim: boundedText(4000, 'The one thing being judged, stated so evidence can bear on it.'),
      evidence: boundedText(200_000, 'The explicit evidence. An empty string is refused rather than guessed past.'),
    },
  },
  jev_choose: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    additionalProperties: false,
    required: ['instruction', 'options'],
    properties: {
      instruction: boundedText(4000, 'What is being decided between the options.'),
      context: { type: 'string', maxLength: 200_000, description: 'Optional facts the choice rests on.' },
      options: {
        type: 'array',
        minItems: 2,
        maxItems: 16,
        description: 'Mutually exclusive candidates. A choice needs at least two; one is not a choice.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'description'],
          properties: {
            id: boundedText(64, 'Stable identifier, echoed back in `selected`.'),
            description: boundedText(2000, 'What picking this option means.'),
          },
        },
      },
    },
  },
  jev_rank: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    additionalProperties: false,
    required: ['instruction', 'candidates'],
    properties: {
      instruction: boundedText(4000, 'What "better" means here, in one sentence.'),
      candidates: {
        type: 'array',
        // An empty candidate list is a legitimate answer, not a protocol error: the tool
        // reports `noneApplicable` instead of inventing something to rank.
        maxItems: 32,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'text'],
          properties: {
            id: boundedText(64, 'Stable identifier, used in `ordering`.'),
            text: boundedText(20_000, 'The thing being scored.'),
          },
        },
      },
      levels: {
        type: 'array',
        minItems: 2,
        maxItems: 8,
        description: 'Ordered labels, worst first. Defaults to a five-point ladder whose bottom rung is "none applicable".',
        items: boundedText(80, 'One level label.'),
      },
    },
  },
}

export const TOOL_OUTPUT_SCHEMAS: Readonly<Record<McpToolName, object>> = {
  jev_check: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    additionalProperties: false,
    required: ['kind', ...Object.keys(answerHeader), 'claim', 'pYes', 'probability', 'abstained'],
    properties: {
      ...answerHeader,
      kind: { const: 'boolean' },
      claim: { type: 'string' },
      pYes: { type: 'number', description: 'P(the claim holds given the evidence).' },
      calibratedPYes: { type: 'number' },
      probability: probabilityMetadata,
      abstained: {
        type: 'boolean',
        description: 'True when the answering side declined. Declining is never rewritten into a low score.',
      },
    },
  },
  jev_choose: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    additionalProperties: false,
    required: ['kind', ...Object.keys(answerHeader), 'instruction', 'selected', 'probabilities', 'probability', 'abstained'],
    properties: {
      ...answerHeader,
      kind: { const: 'choice' },
      instruction: { type: 'string' },
      selected: { type: 'string', description: 'Option id, or `none-applicable` when nothing fits.' },
      probabilities: distribution,
      calibratedProbabilities: distribution,
      probability: probabilityMetadata,
      abstained: { type: 'boolean' },
    },
  },
  jev_rank: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    additionalProperties: false,
    required: ['kind', ...Object.keys(answerHeader), 'instruction', 'levels', 'scores', 'ordering', 'noneApplicable', 'abstained'],
    properties: {
      ...answerHeader,
      kind: { const: 'score' },
      instruction: { type: 'string' },
      levels: { type: 'array', items: { type: 'string' } },
      scores: {
        type: 'array',
        description: 'One entry per candidate, in the order they were given.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'expectedIndex', 'probabilities'],
          properties: {
            id: { type: 'string' },
            expectedIndex: {
              type: ['number', 'null'],
              description: 'Σ(index × p) over the levels; fractional by design. Null when this candidate got no answer.',
            },
            probabilities: distribution,
          },
        },
      },
      ordering: { type: 'array', items: { type: 'string' }, description: 'Candidate ids, best first.' },
      noneApplicable: {
        type: 'boolean',
        description: 'True when there was nothing to rank, or every candidate scored on the bottom level.',
      },
      abstained: { type: 'boolean' },
    },
  },
}

/** One-line descriptions a client shows; they state the limit of each tool, not just its name. */
export const TOOL_DESCRIPTIONS: Readonly<Record<McpToolName, string>> = {
  jev_check: 'Judge one claim against evidence the caller supplies. Returns a probability and the answering model’s identity; it never executes or authorises anything.',
  jev_choose: 'Pick one of a mutually exclusive set of options, with the full distribution. Returns `none-applicable` rather than forcing a pick.',
  jev_rank: 'Score each candidate independently against an ordered level ladder and return them best-first. An empty candidate list answers honestly.',
}
