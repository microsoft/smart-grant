'use client';

/**
 * WriterStudio — Human-In-The-Loop v2 grant studio.
 *
 * State machine:
 *
 *   idle
 *     │  ▸ user picks school + grant type → click "Find best grants"
 *     ▼
 *   discovering            ── streams the Discovery agent only
 *     │  ▸ backend emits ``discovery_ranking_ready`` with the top-5
 *     ▼
 *   awaiting_selection     ── RankedGrantPicker is visible
 *     │  ▸ user confirms a grant
 *     ▼
 *   generating             ── streams Narrative → Writer (agents 1–5)
 *     │  ▸ backend emits ``workflow_complete``
 *     ▼
 *   done
 *
 * Anywhere → ``error`` if the upstream stream fails. ``reset`` returns
 * the studio to ``idle`` and aborts any in-flight fetch.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { Play, RotateCcw, AlertTriangle, Search, Sparkles } from 'lucide-react';
import { Card, CardTitle, CardDescription } from './Card';
import { Button } from './Button';
import { Badge } from './Badge';
import { Field } from './Field';
import { SchoolPicker } from './SchoolPicker';
import { GrantPicker, GRANTS } from './GrantPicker';
import { AgentStream, AGENTS, type AgentStatus } from './AgentStream';
import { ProgressRail } from './ProgressRail';
import { MetricsStrip } from './MetricsStrip';
import { ResultsPanel } from './ResultsPanel';
import { RankedGrantPicker, type DiscoveryRanking, type FoundationProspect, type RankedGrant } from './RankedGrantPicker';
import type { SchoolData } from '@/components/v2/school';

type RunState =
  | 'idle'
  | 'discovering'
  | 'awaiting_selection'
  | 'generating'
  | 'done'
  | 'error';

interface JsonEvent {
  type:
    | 'workflow_start'
    | 'agent_start'
    | 'token'
    | 'agent_complete'
    | 'workflow_complete'
    | 'error'
    | 'discovery_ranking_ready'
    | 'discovery_ranking_failed';
  agentIndex: number;
  agentName: string;
  // Payload is variable per type: string for tokens/agent_complete, dict for
  // workflow_start and discovery_ranking_ready.
  payload: unknown;
  timestamp: string;
}

const STATE_COPY: Record<RunState, string> = {
  idle: 'Ready when you are',
  discovering: 'Discovery agent ranking your matches',
  awaiting_selection: 'Choose the grant to apply for',
  generating: 'Five specialists writing your application',
  done: 'Application ready',
  error: 'Something went wrong',
};

/**
 * MirrorEvent — normalised pulse the WriterStudio emits when an optional
 * `onMirror` callback is supplied. Used by /v2/office to drive the 3D
 * scene with the SAME live data the user sees in the form. The default
 * (no callback) is zero-overhead and zero-impact on /v2.
 */
export type MirrorEvent =
  | { type: 'reset' }
  | { type: 'inputs'; schoolName: string | null; grantLabel: string | null }
  | { type: 'scene'; scene: RunState }
  | { type: 'agent_active'; index: number; name: string }
  | { type: 'agent_done'; index: number }
  /** `text` is the raw delta — the office renders it on the agent's monitor. */
  | { type: 'token'; index: number; text: string }
  /** Real ranked grant titles — the office prints them on the folders. */
  | { type: 'grants'; titles: string[] };

export interface WriterStudioProps {
  /** Optional live mirror for the /v2/office 3D scene. */
  onMirror?: (e: MirrorEvent) => void;
}

export function WriterStudio({ onMirror }: WriterStudioProps = {}) {
  const emitRef = useRef(onMirror);
  useEffect(() => {
    emitRef.current = onMirror;
  }, [onMirror]);
  const emit = useCallback((e: MirrorEvent) => emitRef.current?.(e), []);
  // ---------------------------------------------------------- inputs
  const [school, setSchool] = useState<SchoolData | null>(null);
  const [grantKey, setGrantKey] = useState<string | null>(null);
  const [customPurpose, setCustomPurpose] = useState('');

  // ---------------------------------------------------------- run state
  const [state, setState] = useState<RunState>('idle');
  const [outputs, setOutputs] = useState<Record<number, string>>({});
  const [statuses, setStatuses] = useState<Record<number, AgentStatus>>({});
  const [errors, setErrors] = useState<Record<number, string | undefined>>({});
  const [current, setCurrent] = useState(-1);
  const [completed, setCompleted] = useState(0);
  const [topError, setTopError] = useState<string | null>(null);
  const [tokens, setTokens] = useState(0);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);

  // ---------------------------------------------------------- HITL state
  const [ranking, setRanking] = useState<DiscoveryRanking | null>(null);
  const [selectedGrant, setSelectedGrant] = useState<RankedGrant | null>(null);
  const [selectedFoundation, setSelectedFoundation] = useState<FoundationProspect | null>(null);

  const abortRef = useRef<AbortController | null>(null);

  // Tick elapsed-time while any stage is streaming.
  useEffect(() => {
    if ((state !== 'discovering' && state !== 'generating') || startedAt == null) return;
    const id = window.setInterval(() => {
      setElapsedMs(Date.now() - startedAt);
    }, 250);
    return () => window.clearInterval(id);
  }, [state, startedAt]);

  const grant = grantKey ? GRANTS.find((g) => g.key === grantKey) ?? null : null;
  const canDiscover =
    !!school &&
    !!grant &&
    state === 'idle' &&
    (grant.key !== 'other' || customPurpose.trim().length > 8);

  // ============================================================
  // reset — full clean slate (used by Reset button and new searches)
  // ============================================================
  const reset = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setOutputs({});
    setStatuses({});
    setErrors({});
    setCurrent(-1);
    setCompleted(0);
    setTopError(null);
    setTokens(0);
    setStartedAt(null);
    setElapsedMs(0);
    setRanking(null);
    setSelectedGrant(null);
    setState('idle');
    emit({ type: 'reset' });
    emit({ type: 'scene', scene: 'idle' });
  }, [emit]);

  // ============================================================
  // SSE stream parser — used by both stages
  //
  // Reads the response body, splits SSE records on the blank-line
  // separator, and dispatches events to the per-stage handler.
  // ============================================================
  const consumeStream = useCallback(
    async (
      res: Response,
      onEvent: (ev: JsonEvent) => void,
      signal: AbortSignal,
    ) => {
      if (!res.ok || !res.body) {
        throw new Error(`Backend returned ${res.status}`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      const handleRecord = (record: string) => {
        const lines = record.split('\n');
        const dataLines: string[] = [];
        let evName = '';
        for (const ln of lines) {
          if (ln.startsWith('event:')) evName = ln.slice(6).trim();
          else if (ln.startsWith('data:')) dataLines.push(ln.slice(5).trim());
        }
        const data = dataLines.join('\n');
        if (!data) return;
        if (evName === 'end') return;
        try {
          onEvent(JSON.parse(data) as JsonEvent);
        } catch {
          // Malformed record — keep stream alive.
        }
      };

      while (!signal.aborted) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let sep: number;
        while ((sep = buffer.indexOf('\n\n')) !== -1) {
          const record = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          handleRecord(record);
        }
      }
      if (buffer.trim()) handleRecord(buffer);
    },
    [],
  );

  // ============================================================
  // STAGE 1 — Discovery
  // ============================================================
  const startDiscovery = useCallback(async () => {
    if (!school || !grant) return;
    reset();
    setState('discovering');
    setStartedAt(Date.now());
    setCurrent(0);
    setStatuses({ 0: 'streaming' });
    emit({
      type: 'inputs',
      schoolName: school.name,
      grantLabel: grant.key === 'other' ? customPurpose.trim().slice(0, 80) : grant.name,
    });
    emit({ type: 'scene', scene: 'discovering' });
    emit({ type: 'agent_active', index: 0, name: AGENTS[0]?.name ?? 'Discovery' });

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch('/api/v2/agent-framework?stage=discover', {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grantType: grant.key,
          customPurpose: grant.key === 'other' ? customPurpose : undefined,
          schoolData: serialiseSchool(school),
        }),
      });

      await consumeStream(
        res,
        (ev) => {
          switch (ev.type) {
            case 'agent_start':
              setCurrent(0);
              setStatuses((p) => ({ ...p, 0: 'streaming' }));
              break;
            case 'token':
              // Discovery emits structured JSON — we don't surface raw
              // tokens to the user, but we do increment the counter so
              // the metrics strip shows live activity.
              setTokens((t) => t + 1);
              // Empty text: drives the office typing pulse without leaking
              // raw JSON onto the monitor.
              emit({ type: 'token', index: 0, text: '' });
              break;
            case 'agent_complete':
              setStatuses((p) => ({ ...p, 0: 'complete' }));
              setCompleted(1);
              emit({ type: 'agent_done', index: 0 });
              break;
            case 'discovery_ranking_ready': {
              const r = ev.payload as DiscoveryRanking;
              setRanking(r);
              setSelectedGrant(r.top_grants[0] ?? null);
              setState('awaiting_selection');
              emit({ type: 'grants', titles: r.top_grants.map((g) => g.title) });
              emit({ type: 'scene', scene: 'awaiting_selection' });
              break;
            }
            case 'discovery_ranking_failed': {
              const p = ev.payload as { reason?: string };
              setTopError(
                p?.reason
                  ? `Discovery could not produce a ranking: ${p.reason}`
                  : 'Discovery could not produce a ranking.',
              );
              setStatuses((s) => ({ ...s, 0: 'error' }));
              setState('error');
              break;
            }
            case 'workflow_complete':
              // Already handled by discovery_ranking_ready in practice;
              // safety net: if we got here without a ranking, surface it.
              setState((s) =>
                s === 'awaiting_selection' || s === 'error' ? s : 'error',
              );
              break;
            case 'error':
              setStatuses((p) => ({ ...p, 0: 'error' }));
              setErrors((p) => ({ ...p, 0: String(ev.payload) }));
              setTopError(String(ev.payload) || 'Discovery failed.');
              setState('error');
              break;
          }
        },
        controller.signal,
      );
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      setTopError(
        err instanceof Error ? err.message : 'Failed to reach the agent backend.',
      );
      setState('error');
    }
  }, [school, grant, customPurpose, reset, consumeStream, emit]);

  // ============================================================
  // STAGE 2 — Generation (after the user confirms a grant)
  // ============================================================
  const startGeneration = useCallback(
    async (chosen: RankedGrant | FoundationProspect) => {
      if (!school || !grant) return;
      // Uma fundacao nao tem rank nem notas de rubrica; e o que distingue as duas.
      const isFoundation = !('rank' in chosen && 'score_total' in chosen);
      setSelectedGrant(isFoundation ? null : (chosen as RankedGrant));
      setSelectedFoundation(isFoundation ? (chosen as FoundationProspect) : null);
      setState('generating');
      setStartedAt(Date.now());
      setElapsedMs(0);
      // Mark Discovery (slot 0) as complete, clear the rest.
      setStatuses({ 0: 'complete' });
      setErrors({});
      setOutputs({});
      setCurrent(-1);
      setCompleted(1);
      setTokens(0);
      emit({ type: 'scene', scene: 'generating' });

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const res = await fetch('/api/v2/agent-framework?stage=generate', {
          method: 'POST',
          signal: controller.signal,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            grantType: grant.key,
            customPurpose: grant.key === 'other' ? customPurpose : undefined,
            schoolData: serialiseSchool(school),
            selectedGrant: isFoundation ? undefined : chosen,
            selectedFoundation: isFoundation ? chosen : undefined,
          }),
        });

        await consumeStream(
          res,
          (ev) => {
            switch (ev.type) {
              case 'agent_start':
                setCurrent(ev.agentIndex);
                setStatuses((p) => ({ ...p, [ev.agentIndex]: 'streaming' }));
                setOutputs((p) => ({ ...p, [ev.agentIndex]: '' }));
                emit({ type: 'agent_active', index: ev.agentIndex, name: ev.agentName });
                break;
              case 'token':
                setOutputs((p) => ({
                  ...p,
                  [ev.agentIndex]:
                    (p[ev.agentIndex] ?? '') + String(ev.payload ?? ''),
                }));
                setTokens((t) => t + 1);
                emit({
                  type: 'token',
                  index: ev.agentIndex,
                  text: String(ev.payload ?? ''),
                });
                break;
              case 'agent_complete': {
                const text = typeof ev.payload === 'string' ? ev.payload : '';
                setStatuses((p) => ({ ...p, [ev.agentIndex]: 'complete' }));
                setOutputs((p) => ({
                  ...p,
                  [ev.agentIndex]: text || p[ev.agentIndex] || '',
                }));
                setCompleted((c) => Math.max(c, ev.agentIndex + 1));
                emit({ type: 'agent_done', index: ev.agentIndex });
                break;
              }
              case 'workflow_complete':
                setCompleted(AGENTS.length);
                setState('done');
                emit({ type: 'scene', scene: 'done' });
                break;
              case 'error':
                setStatuses((p) => ({ ...p, [ev.agentIndex]: 'error' }));
                setErrors((p) => ({ ...p, [ev.agentIndex]: String(ev.payload) }));
                setTopError(String(ev.payload) || 'Generation failed.');
                setState('error');
                break;
            }
          },
          controller.signal,
        );
      } catch (err) {
        if ((err as Error).name === 'AbortError') return;
        setTopError(
          err instanceof Error ? err.message : 'Failed to reach the agent backend.',
        );
        setState('error');
      }
    },
    [school, grant, customPurpose, consumeStream, emit],
  );

  // ============================================================
  // RENDER
  // ============================================================
  const isStreaming = state === 'discovering' || state === 'generating';
  const showInputs = state === 'idle' || state === 'error';

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[220px_1fr] gap-8">
      <ProgressRail current={current} completed={completed} />

      <div className="min-w-0 space-y-8">
        {/* ----------------------------------------------- inputs (idle/error) */}
        {showInputs && (
          <section className="space-y-6">
            <SchoolPicker selected={school} onSelect={setSchool} />
            <GrantPicker value={grantKey} onChange={setGrantKey} />
            {grant?.key === 'other' && (
              <Field
                label="Custom purpose"
                placeholder="Briefly describe the program you want funded…"
                value={customPurpose}
                onChange={(e) => setCustomPurpose(e.target.value)}
                helper="Used to guide the discovery and writer agents."
              />
            )}
          </section>
        )}

        {/* ----------------------------------------------- summary chip
            Once we leave idle, replace the heavy input pickers with a
            compact summary so the eye lands on the live work. */}
        {!showInputs && school && grant && (
          <Card density="compact" className="flex items-center justify-between">
            <div className="flex items-center gap-3 min-w-0">
              <Badge tone="primary" soft>
                {grant.name}
              </Badge>
              <span className="text-sm text-claude-text-muted truncate">
                for{' '}
                <span className="text-claude-text font-medium">{school.name}</span>
                {school.city && school.state && (
                  <span className="text-claude-text-subtle">
                    {' '}· {school.city}, {school.state}
                  </span>
                )}
              </span>
            </div>
            {(state === 'done' || state === 'awaiting_selection') && (
              <Button
                variant="ghost"
                leadingIcon={<RotateCcw className="h-4 w-4" />}
                onClick={reset}
                size="sm"
              >
                Start over
              </Button>
            )}
          </Card>
        )}

        {/* ----------------------------------------------- action bar (idle/error only) */}
        {showInputs && (
          <Card density="compact" className="flex items-center justify-between">
            <div className="min-w-0">
              <p className="text-xs text-claude-text-subtle uppercase tracking-wide font-medium">
                {STATE_COPY[state]}
              </p>
              <p className="text-sm text-claude-text-muted mt-1">
                {school && grant ? (
                  <>
                    <span className="text-claude-text font-medium">{grant.name}</span>{' '}
                    for{' '}
                    <span className="text-claude-text font-medium">{school.name}</span>
                  </>
                ) : (
                  'Select a school and grant type to begin.'
                )}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {state === 'error' && (
                <Button
                  variant="ghost"
                  leadingIcon={<RotateCcw className="h-4 w-4" />}
                  onClick={reset}
                >
                  Reset
                </Button>
              )}
              <Button
                onClick={startDiscovery}
                disabled={!canDiscover}
                leadingIcon={<Search className="h-4 w-4" />}
              >
                Find best grants
              </Button>
            </div>
          </Card>
        )}

        {/* ----------------------------------------------- error banner */}
        {topError && (
          <Card className="border-claude-danger/40 bg-claude-danger/5">
            <div className="flex items-start gap-3">
              <AlertTriangle className="h-5 w-5 text-claude-danger shrink-0 mt-0.5" />
              <div>
                <p className="font-medium text-claude-text">Workflow error</p>
                <p className="text-sm text-claude-text-muted mt-0.5">{topError}</p>
              </div>
            </div>
          </Card>
        )}

        {/* ----------------------------------------------- live metrics */}
        {isStreaming && (
          <MetricsStrip
            elapsedMs={elapsedMs}
            current={current}
            completed={completed}
            totalAgents={AGENTS.length}
            tokens={tokens}
            currentName={current >= 0 ? AGENTS[current]?.name ?? '' : ''}
          />
        )}

        {/* ----------------------------------------------- Discovery thinking state */}
        {state === 'discovering' && (
          <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3, ease: [0.2, 0.7, 0.2, 1] }}
          >
            <Card>
              <div className="flex items-start gap-4">
                <div className="relative h-10 w-10 shrink-0">
                  <div className="absolute inset-0 rounded-full bg-claude-primary/15 animate-ping" />
                  <div className="relative h-full w-full rounded-full bg-claude-primary/20 grid place-items-center">
                    <Sparkles className="h-5 w-5 text-claude-primary" />
                  </div>
                </div>
                <div className="min-w-0">
                  <CardTitle>Scoring candidates against an 8-dimension rubric…</CardTitle>
                  <CardDescription>
                    Eligibility, mission alignment, demographic resonance, award fit,
                    competition odds, timeline, sustainability and strategic upside.
                  </CardDescription>
                </div>
              </div>
            </Card>
          </motion.div>
        )}

        {/* ----------------------------------------------- HITL — grant picker */}
        {state === 'awaiting_selection' && ranking && (
          <RankedGrantPicker
            ranking={ranking}
            onConfirm={startGeneration}
            onRestart={reset}
          />
        )}

        {/* ----------------------------------------------- live agent stream */}
        {(state === 'generating' || (state === 'error' && completed > 1)) && (
          <motion.section
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3, ease: [0.2, 0.7, 0.2, 1] }}
            className="space-y-4"
          >
            <div className="flex items-center justify-between">
              <div>
                <CardTitle>Live agent stream</CardTitle>
                <CardDescription>
                  Writing against{' '}
                  <span className="text-claude-text font-medium">
                    {/* Uma fundacao nao tem `title`: quando o usuario escolhe
                        um prospecto, selectedGrant fica nulo por desenho. */}
                    {selectedGrant?.title ?? selectedFoundation?.name}
                  </span>{' '}
                  — five specialists collaborating in real time.
                </CardDescription>
              </div>
              <Badge tone="primary" soft dot>
                GPT-5.4
              </Badge>
            </div>
            <AgentStream
              agents={AGENTS}
              current={current}
              outputs={outputs}
              statuses={statuses}
              errors={errors}
            />
          </motion.section>
        )}

        {/* ----------------------------------------------- final results */}
        {state === 'done' && school && grant && (
          <motion.section
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, ease: [0.2, 0.7, 0.2, 1] }}
            className="space-y-4"
          >
            {selectedGrant && (
              <Card density="compact" className="bg-claude-accent-muted/30">
                <div className="flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <p className="text-xs uppercase tracking-wide text-claude-text-subtle font-medium">
                      Written for
                    </p>
                    <p className="text-claude-text font-medium truncate">
                      {selectedGrant.title}
                    </p>
                    <p className="text-xs text-claude-text-muted truncate">
                      {selectedGrant.funder} · {selectedGrant.amount_text} · Deadline{' '}
                      {selectedGrant.deadline_text}
                    </p>
                  </div>
                  <Badge tone="success" soft>
                    Score {selectedGrant.score_total}/100
                  </Badge>
                </div>
              </Card>
            )}
            <ResultsPanel
              schoolName={school.name}
              schoolLocation={[school.city, school.state].filter(Boolean).join(', ')}
              schoolProfile={{
                name: school.name,
                district: school.district,
                city: school.city,
                state: school.state,
                zip: school.zip,
                students: school.students,
                grades: school.grades,
                type: school.type,
                demographics: school.demographics,
                programs: school.programs,
                ncesId: school.id,
                website: school.contact?.website,
              }}
              grantName={grant.name}
              grantKey={grant.key}
              outputs={outputs}
            />
            <div className="flex justify-end pt-2">
              <Button
                variant="ghost"
                leadingIcon={<Play className="h-4 w-4" />}
                onClick={reset}
              >
                Write another
              </Button>
            </div>
          </motion.section>
        )}
      </div>
    </div>
  );
}

// ----------------------------------------------------------- helpers

function serialiseSchool(s: SchoolData) {
  return {
    id: s.id,
    name: s.name,
    district: s.district,
    city: s.city,
    state: s.state,
    zip: s.zip,
    students: s.students,
    grades: s.grades,
    type: s.type,
    demographics: s.demographics,
    programs: s.programs,
    contact: s.contact,
  };
}
