import { describe, expect, it } from 'vitest'
import {
  agentComposerState,
  type AgentComposerInput,
  type AgentComposerState,
} from '@/lib/agentComposer'

const run = { harnessSessionId: 'run-1', startedAt: 1_000 }

const cases: { name: string; input: AgentComposerInput; expected: AgentComposerState }[] = [
  {
    name: 'never ran in this Session',
    input: { agentEdited: false, latestTurn: { ranBy: 'Flux Schnell' } },
    expected: { primary: 'run', sendEnabled: false, reason: 'never-run' },
  },
  {
    name: 'never ran in an empty Session',
    input: { agentEdited: false },
    expected: { primary: 'run', sendEnabled: false, reason: 'never-run' },
  },
  {
    name: 'its last Step is the latest turn',
    input: {
      agentEdited: false,
      latestRun: run,
      latestTurn: { harnessSessionId: 'run-1', ranBy: 'Summarizer' },
    },
    expected: { primary: 'send', sendEnabled: true },
  },
  {
    name: 'a Follow-up to it is the latest turn',
    input: {
      agentEdited: false,
      latestRun: run,
      latestTurn: { harnessSessionId: 'run-1', ranBy: 'Summarizer' },
    },
    expected: { primary: 'send', sendEnabled: true },
  },
  {
    name: 'another preset ran since',
    input: { agentEdited: false, latestRun: run, latestTurn: { ranBy: 'Flux Schnell' } },
    expected: { primary: 'run', sendEnabled: true, reason: 'other-turn', ranSince: 'Flux Schnell' },
  },
  {
    name: 'another Agent ran since',
    input: {
      agentEdited: false,
      latestRun: run,
      latestTurn: { harnessSessionId: 'run-2', ranBy: 'Translator' },
    },
    expected: { primary: 'run', sendEnabled: true, reason: 'other-turn', ranSince: 'Translator' },
  },
  {
    name: 'the Agent was edited since the run',
    input: {
      agentEdited: true,
      latestRun: run,
      latestTurn: { harnessSessionId: 'run-1', ranBy: 'Summarizer' },
    },
    expected: { primary: 'run', sendEnabled: true, reason: 'agent-edited' },
  },
]

describe('agentComposerState', () => {
  it.each(cases)('$name', ({ input, expected }) => {
    expect(agentComposerState(input)).toEqual(expected)
  })
})
