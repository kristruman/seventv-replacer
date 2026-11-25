import { ArrowRight, ChevronDown, ExternalLink, Layers, ShieldCheck, SlidersHorizontal } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { Link, useSearchParams } from 'react-router';
import { currentSeason, isSeasonId, SEASONS, seasonLabel, type SeasonId } from '@shared/seasons';
import { fetchEmoteSet, fetchMySets, SevenTvError, seventvSetUrl, type EmoteSet, type SetSummary } from '@shared/seventv';
import type { MappingRow } from '@shared/types';
import { fetchPreset, reportBroken } from '../api';
import { ProblemList } from '../components/ProblemList';
import { SeasonalAlternatives } from '../components/SeasonalAlternatives';
import { SetDetails } from '../components/SetDetails';
import { SetPicker } from '../components/SetPicker';
import { DeckField } from '../design/DeckField';
import { GunmetalKey } from '../design/GunmetalKey';
import { Notice } from '../design/Notice';
import { SwapList } from '../design/SwapList';
import { fixProblem, recordFix } from '../lib/problems';
import { executeRun, planSwaps, swapKey, type RunMode, type RunProblem, type RunRecord, type RunReport } from '../lib/run';
import { createWriter, type SetWriter } from '../lib/seventv-write';
import {
  cleanToken,
  forgetProblem,
  forgetRun,
  forgetRunProblems,
  loadProblems,
  loadPersonalMappings,
  loadRuns,
  loadToken,
  rememberRun,
  saveToken,
  savePersonalMapping,
  updateProblems,
  updateRun,
} from '../lib/storage';
import { undoRun, type UndoReport } from '../lib/undo';
import styles from './Workbench.module.css';
import ui from './ReplaceWorkspace.module.css';

const SEASON_OPTIONS = SEASONS.map((s) => ({ value: s, label: seasonLabel(s) }));

const OPERATIONS = {
  'seasonal-copy': { label: 'Seasonal copy', action: 'Create seasonal copy' },
  copy: { label: 'Duplicate as-is', action: 'Copy set' },
  'in-place': { label: 'Replace in place', action: 'Apply swaps' },
  revert: { label: 'Revert seasonal swaps', action: 'Revert swaps' },
} as const;

type Operation = keyof typeof OPERATIONS;

const MODE_NAMES: Record<RunMode, string> = {
  duplicate: 'Duplicate + replace',
  'in-place': 'Replace in place',
  revert: 'Revert',
};

type Loaded<T> = T | 'loading' | 'failed';
type AccountSets = { token: string } & ({ sets: SetSummary[] } | { error: string; retryable: boolean });

type RunState =
  | { kind: 'idle' }
  | { kind: 'running'; done: number; total: number; msLeft?: number }
  | { kind: 'done'; report: RunReport }
  | { kind: 'failed'; message: string };

type UndoResult = { record: RunRecord; report?: UndoReport; error?: string };

/** A new name for a set-aside emote, waiting for the run's next break. */
type QueuedFix = { problem: RunProblem; name: string };

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const errorText = (error: unknown) => (error instanceof Error ? error.message : 'Something went wrong. Try again.');
/** Before this many emotes the pace isn't known well enough to estimate. */
const ETA_AFTER = 3;

function timeLeft(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  return minutes < 1 ? 'under 1 min left' : `~${minutes} min left`;
}

const when = (iso: string) => new Date(iso).toLocaleString('en', { dateStyle: 'medium', timeStyle: 'short' });

export function Replace() {
  const [params] = useSearchParams();
  const channel = params.get('channel') ?? '';
  const seasonParam = params.get('season');

  const [token, setToken] = useState(loadToken);
  const [connectionOpen, setConnectionOpen] = useState(false);
  const [tokenError, setTokenError] = useState<string>();
  const tokenInput = useRef<HTMLInputElement>(null);
  const connectionButton = useRef<HTMLButtonElement>(null);
  const [accountResult, setAccountResult] = useState<AccountSets>();
  const [accountAttempt, setAccountAttempt] = useState(0);

  const [set, setSet] = useState<EmoteSet | null>(null);
  const [setError, setSetError] = useState<string>();
  const setInput = useRef<HTMLInputElement>(null);

  const [season, setSeason] = useState<SeasonId>(() => (isSeasonId(seasonParam) ? seasonParam : currentSeason(new Date())));
  const [operation, setOperation] = useState<Operation>('seasonal-copy');
  const [personalEdits, setPersonalEdits] = useState<Partial<Record<SeasonId, Record<string, string | null>>>>({});
  const [presets, setPresets] = useState<Partial<Record<SeasonId, Loaded<MappingRow[]>>>>({});
  const [unticked, setUnticked] = useState<Set<string>>(() => new Set());

  const [targetKind, setTargetKind] = useState<'new' | 'existing'>('new');
  const [newName, setNewName] = useState<string>();
  const [existingTarget, setExistingTarget] = useState<EmoteSet | null>(null);
  const [targetError, setTargetError] = useState<string>();

  const [runState, setRunState] = useState<RunState>({ kind: 'idle' });
  const [runs, setRuns] = useState<RunRecord[]>(loadRuns);
  const [undoing, setUndoing] = useState<string>();
  const [undoResult, setUndoResult] = useState<UndoResult>();
  const started = useRef(0);

  const [problems, setProblems] = useState<RunProblem[]>(loadProblems);
  const [queued, setQueued] = useState<ReadonlySet<string>>(() => new Set());
  const [fixing, setFixing] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const clearNotice = useCallback(() => setNotice(null), []);
  // While a run goes, fixes wait for its next break, and those to its own emotes join its record when it saves.
  const activeRun = useRef<{ id: string; writer: SetWriter } | null>(null);
  const fixQueue = useRef<QueuedFix[]>([]);
  const runFixes = useRef<QueuedFix[]>([]);

  const label = seasonLabel(season);
  const running = runState.kind === 'running';
  const preset = presets[season];
  const copyOnly = operation === 'copy';
  const mode: RunMode = operation === 'seasonal-copy' || copyOnly ? 'duplicate' : operation;
  const account = accountResult?.token === token ? accountResult : undefined;
  const mySets = token && account && 'sets' in account ? account.sets : undefined;

  useEffect(() => {
    if (!token) return;
    const controller = new AbortController();
    // Wait for a paste or edit to settle before querying with the token.
    const timer = window.setTimeout(() => {
      void fetchMySets(token, controller.signal).then(
        (sets) => {
          if (!controller.signal.aborted) setAccountResult({ token, sets });
        },
        (error) => {
          if (!controller.signal.aborted) {
            setAccountResult({
              token,
              error: errorText(error),
              retryable: !(error instanceof SevenTvError && error.kind === 'no-account'),
            });
          }
        },
      );
    }, 350);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [token, accountAttempt]);

  useEffect(() => {
    if (preset !== undefined) return;
    setPresets((p) => ({ ...p, [season]: 'loading' }));
    fetchPreset(season).then(
      (body) => setPresets((p) => ({ ...p, [season]: body.mappings })),
      () => setPresets((p) => ({ ...p, [season]: 'failed' })),
    );
  }, [season, preset]);

  // A new set, season or mode is a new preview: everything starts ticked again.
  useEffect(() => setUnticked(new Set()), [set?.id, season, mode, copyOnly]);

  // The run lives in this tab: closing it stops the run half-way (Undo still has what was done).
  useEffect(() => {
    if (!running) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [running]);

  const personal = useMemo(() => {
    const ids = [...new Set(set?.emotes.map((emote) => emote.id))];
    const saved = loadPersonalMappings(season, ids);
    const mappings = new Map(saved.map(({ originalId, replacementId }) => [originalId, replacementId]));
    for (const [id, replacement] of Object.entries(personalEdits[season] ?? {})) {
      if (replacement === null) mappings.delete(id);
      else mappings.set(id, replacement);
    }
    return mappings;
  }, [set, season, personalEdits]);
  const plan = useMemo(() => {
    if (!set) return null;
    if (copyOnly) return { swaps: [], unmapped: 0, alreadyThere: 0 };
    if (!Array.isArray(preset)) return null;
    const mappings = mode !== 'duplicate' ? preset : [
      ...preset,
      ...Array.from(personal, ([originalId, replacementId]) => ({ originalId, replacementId })),
    ];
    return planSwaps(set, mappings, mode);
  }, [set, preset, mode, copyOnly, personal]);
  const ticked = plan ? plan.swaps.filter((s) => !unticked.has(swapKey(s.fromId, s.alias))) : [];
  const copyName = newName ?? (set ? `${set.name} (${copyOnly ? 'Copy' : label})` : '');

  const readout = (() => {
    if (runState.kind === 'running') {
      const progress = `${mode === 'duplicate' ? 'Copying' : 'Swapping'} · ${runState.done}/${runState.total}`;
      return runState.msLeft === undefined ? progress : `${progress} · ${timeLeft(runState.msLeft)}`;
    }
    if (runState.kind === 'done') {
      return runState.report.record.copyOnly
        ? `Done · ${runState.report.copied} copied`
        : `Done · ${runState.report.swapped} swapped`;
    }
    if (!set) return 'Pick a set';
    if (copyOnly) return `Copy · ${plural(set.emotes.length, 'emote', 'emotes')}`;
    if (preset === 'failed') return 'Preset unavailable';
    if (!plan) return `Loading ${label}`;
    return `${mode === 'revert' ? 'Revert' : label} · ${plural(ticked.length, 'swap', 'swaps')}`;
  })();

  const onToken = (value: string) => {
    const clean = cleanToken(value);
    if (clean !== token) setAccountResult(undefined);
    setToken(clean);
    saveToken(clean);
    setTokenError(undefined);
  };

  const openConnection = (error?: string) => {
    flushSync(() => {
      setConnectionOpen(true);
      setTokenError(error);
    });
    tokenInput.current?.focus();
  };

  const needToken = () => openConnection('Paste your 7TV token first.');

  const closeConnection = () => {
    setConnectionOpen(false);
    connectionButton.current?.focus();
  };

  const run = async () => {
    if (running) return;
    if (!token) return needToken();
    if (!set) {
      flushSync(() => setSetError('Pick a set first.'));
      setInput.current?.focus();
      return;
    }
    if (!plan) return;
    if (mode !== 'duplicate' && ticked.length === 0) {
      setRunState({ kind: 'failed', message: 'Tick at least one emote to swap.' });
      return;
    }
    if (mode === 'duplicate' && targetKind === 'existing' && !existingTarget) {
      setTargetError('Pick the set to fill, or switch back to a new set.');
      return;
    }
    if (mode === 'duplicate' && targetKind === 'new' && !copyName.trim()) {
      setTargetError('Give the new set a name.');
      return;
    }

    const source = set;
    const writer = createWriter(token);
    setUndoResult(undefined);
    setRunState({ kind: 'running', done: 0, total: mode === 'duplicate' ? source.emotes.length : ticked.length });
    started.current = Date.now();
    runFixes.current = [];

    const onProgress = (done: number, total: number) => {
      const perEmote = (Date.now() - started.current) / done;
      setRunState({ kind: 'running', done, total, msLeft: done >= ETA_AFTER ? perEmote * (total - done) : undefined });
    };

    // An emote 7TV won't take never stops the run: it is saved for the user, and a broken one goes to the admins.
    const onProblem = (problem: RunProblem) => {
      if (activeRun.current) activeRun.current.id = problem.runId;
      setProblems(updateProblems((list) => [...list, problem]));
      setNotice(`${problem.alias} was set aside. The run carries on.`);
      if (problem.kind === 'broken' && problem.pairing && Array.isArray(preset) &&
        preset.some((mapping) => mapping.originalId === problem.pairing?.originalId &&
          mapping.replacementId === problem.pairing?.replacementId)) {
        reportBroken({ season: problem.season, ...problem.pairing, brokenId: problem.emoteId, reason: problem.reason }).catch(
          () => {},
        );
      }
    };
    const withFixes = (record: RunRecord) =>
      runFixes.current.reduce((r, f) => recordFix(r, f.problem, f.name), record);
    const onRecord = (record: RunRecord) => {
      if (activeRun.current) activeRun.current.id = record.id;
      setRuns(rememberRun(withFixes(record)));
    };
    // The record's id is known from the run's first save or problem.
    activeRun.current = { id: '', writer };

    try {
      const report = await executeRun(
        {
          mode,
          season,
          copyOnly,
          source,
          swaps: ticked,
          target:
            mode !== 'duplicate'
              ? undefined
              : targetKind === 'existing' && existingTarget
                ? { kind: 'existing', set: existingTarget }
                : { kind: 'new', name: copyName.trim() },
        },
        writer,
        { onProgress, onRecord, onProblem, between: drainFixes },
      );
      // Fixes queued during the last batch go in before the run counts as done.
      await drainFixes();
      const record = withFixes(report.record);
      if (record.createdSet || record.swaps.length || record.added.length) setRuns(rememberRun(record));
      setRunState({ kind: 'done', report });
      // The set itself changed: show what it holds now.
      if (mode !== 'duplicate') fetchEmoteSet(source.id).then(setSet, () => {});
    } catch (error) {
      setRunState({ kind: 'failed', message: errorText(error) });
    } finally {
      activeRun.current = null;
      runFixes.current = [];
    }
  };

  /** Tries a set-aside emote again; on success the problem goes and Undo learns about the fix. */
  const applyFix = async ({ problem, name }: QueuedFix, writer: SetWriter) => {
    setFixing(problem.id);
    try {
      await fixProblem(problem, name, writer);
      setProblems(forgetProblem(problem.id));
      if (activeRun.current?.id === problem.runId) runFixes.current.push({ problem, name });
      else setRuns(updateRun(problem.runId, (r) => recordFix(r, problem, name)));
      setNotice(`${problem.alias} is in as “${name}”.`);
    } catch (error) {
      const reason = errorText(error);
      setProblems(updateProblems((list) => list.map((p) => (p.id === problem.id ? { ...p, reason } : p))));
      setNotice(`${problem.alias} still isn’t in: ${reason}`);
    } finally {
      setFixing(null);
    }
  };

  /** The run's break between batches: queued fixes go in one by one, with the run's own writer. */
  const drainFixes = async () => {
    const writer = activeRun.current?.writer;
    if (!writer) return;
    for (const fix of fixQueue.current.splice(0)) {
      await applyFix(fix, writer);
      setQueued((q) => new Set([...q].filter((id) => id !== fix.problem.id)));
    }
  };

  const fix = (problem: RunProblem, name: string) => {
    if (!token) return needToken();
    if (activeRun.current) {
      fixQueue.current.push({ problem, name });
      setQueued((q) => new Set(q).add(problem.id));
      return;
    }
    void applyFix({ problem, name }, createWriter(token));
  };

  const dismiss = (problem: RunProblem) => {
    fixQueue.current = fixQueue.current.filter((f) => f.problem.id !== problem.id);
    setQueued((q) => new Set([...q].filter((id) => id !== problem.id)));
    setProblems(forgetProblem(problem.id));
  };

  const undo = async (record: RunRecord) => {
    if (!token) return needToken();
    if (running || undoing) return;
    setUndoing(record.id);
    setUndoResult(undefined);
    try {
      const report = await undoRun(record, createWriter(token));
      // Keep a record whose undo partly failed: running it again skips what is already back.
      setRuns(report.failed.length ? loadRuns() : forgetRun(record.id));
      // The run's set-aside emotes went back with everything else.
      setProblems(forgetRunProblems(record.id));
      setUndoResult({ record, report });
      if (set?.id === record.setId) fetchEmoteSet(set.id).then(setSet, () => {});
    } catch (error) {
      setUndoResult({ record, error: errorText(error) });
    } finally {
      setUndoing(undefined);
    }
  };

  return (
    <div className={ui.shell}>
      <header className={ui.topbar}>
        <div className={ui.topbarInner}>
          <Link className={ui.brand} to="/" aria-label="7TV Manager home">
            <span className={ui.brandIcon}><Layers size={19} aria-hidden="true" /></span>
            7TV Manager
          </Link>
          <nav className={ui.nav} aria-label="Main">
            <Link to="/compare">Compare sets</Link>
            <button
              type="button"
              className={ui.connection}
              aria-expanded={connectionOpen}
              aria-controls={connectionOpen ? 'connection-settings' : undefined}
              ref={connectionButton}
              onClick={() => connectionOpen ? closeConnection() : openConnection()}
            >
              <span className={ui.connectionDot} data-connected={Boolean(mySets)} aria-hidden="true" />
              {mySets ? '7TV connected' : token ? '7TV connection' : 'Connect 7TV'}
              <ChevronDown size={14} aria-hidden="true" />
            </button>
          </nav>
          {connectionOpen && (
            <section
              id="connection-settings"
              className={ui.connectionPanel}
              aria-label="7TV connection settings"
              onKeyDown={(event) => {
                if (event.key === 'Escape') closeConnection();
              }}
            >
              <div className={ui.connectionHeading}><ShieldCheck size={17} aria-hidden="true" /> 7TV connection</div>
              <DeckField
                label="7TV token"
                type="password"
                placeholder="Paste your token"
                value={token}
                onChange={onToken}
                error={tokenError}
                hint="Stored in this browser and sent directly to 7TV."
                inputRef={tokenInput}
              />
              <div className={ui.connectionActions}>
                <Link to="/guide/token">Find your token <ExternalLink size={13} aria-hidden="true" /></Link>
                {token && <button type="button" className={ui.secondaryButton} onClick={() => onToken('')}>Forget token</button>}
              </div>
            </section>
          )}
        </div>
      </header>

      <main className={ui.main}>
        <h1>Emote sets</h1>

        <div className={ui.workspace}>
          <aside className={ui.sidebar} aria-labelledby="set-heading">
            <h2 id="set-heading"><Layers size={17} aria-hidden="true" /> Source set</h2>
            <fieldset className={ui.fieldset} disabled={running}>
              <SetPicker
                workspace
                label="Find a set"
                selected={set}
                onSelect={(next) => {
                  if (activeRun.current) return;
                  setSet(next);
                  setSetError(undefined);
                  setNewName(undefined);
                  setRunState({ kind: 'idle' });
                }}
                initialQuery={channel}
                mySets={mySets}
                error={setError}
                inputRef={setInput}
              />
            </fieldset>
            <div className={ui.accountStatus} aria-live="polite">
              {!token && (
                <button type="button" className={ui.inlineButton} onClick={() => openConnection()}>
                  Connect to see your sets
                </button>
              )}
              {token && !account && 'Loading your 7TV sets…'}
              {account && 'error' in account && (
                <>
                  {account.error}{' '}
                  {account.retryable && (
                    <button
                      type="button"
                      className={ui.inlineButton}
                      onClick={() => {
                        setAccountResult(undefined);
                        setAccountAttempt((attempt) => attempt + 1);
                      }}
                    >
                      Retry
                    </button>
                  )}
                </>
              )}
              {mySets?.length === 0 && 'Your account has no channel emote sets yet.'}
            </div>
          </aside>

          <div className={ui.editor}>
            {set ? (
              <>
                <header className={ui.selection}>
                  <span className={ui.selectionIcon}><Layers size={22} aria-hidden="true" /></span>
                  <div className={ui.selectionText}>
                    <h2>{set.name}</h2>
                    <p>{plural(set.emotes.length, 'emote', 'emotes')}</p>
                  </div>
                  <a className={ui.viewSet} href={seventvSetUrl(set.id)} target="_blank" rel="noreferrer">
                    View on 7TV <ExternalLink size={14} aria-hidden="true" />
                  </a>
                </header>

                <SetDetails
                  key={set.id}
                  set={set}
                  seasonal={{ season, preset: Array.isArray(preset) ? preset : [], saved: personal, onSeasonChange: setSeason }}
                >
                  <fieldset className={ui.options} disabled={running}>
                    <legend><SlidersHorizontal size={16} aria-hidden="true" /> Set options</legend>
                    <div className={ui.selectGrid}>
                      <label>
                        Operation
                        <select value={operation} onChange={(event) => {
                          setOperation(event.target.value as Operation);
                          setRunState({ kind: 'idle' });
                        }}>
                          {Object.entries(OPERATIONS).map(([value, option]) => (
                            <option key={value} value={value}>{option.label}</option>
                          ))}
                        </select>
                      </label>
                      {!copyOnly && (
                        <label>
                          Season
                          <select value={season} onChange={(event) => setSeason(event.target.value as SeasonId)}>
                            {SEASON_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                          </select>
                        </label>
                      )}
                      {mode === 'duplicate' && (
                        <label>
                          Destination
                          <select value={targetKind} onChange={(event) => {
                            setTargetKind(event.target.value as 'new' | 'existing');
                            setTargetError(undefined);
                          }}>
                            <option value="new">New set</option>
                            <option value="existing">Existing set</option>
                          </select>
                        </label>
                      )}
                    </div>

                    {mode !== 'duplicate' && (
                      <p className={ui.callout}>
                        This edits the source set. Recent runs can be undone from this browser.
                      </p>
                    )}

                    {mode === 'duplicate' && (targetKind === 'new' ? (
                      <DeckField
                        label="Name of the new set"
                        value={copyName}
                        onChange={(value) => {
                          setNewName(value);
                          setTargetError(undefined);
                        }}
                        error={targetError}
                      />
                    ) : (
                      <>
                        <SetPicker
                          label="Set to fill"
                          selected={existingTarget}
                          onSelect={(next) => {
                            setExistingTarget(next);
                            setTargetError(undefined);
                          }}
                          mySets={mySets?.filter((choice) => choice.id !== set.id)}
                          error={targetError}
                        />
                        {existingTarget && existingTarget.emotes.length > 0 && (
                          <p className={ui.callout}>
                            “{existingTarget.name}” already has {plural(existingTarget.emotes.length, 'emote', 'emotes')}. Only new entries will be added.
                          </p>
                        )}
                      </>
                    ))}
                  </fieldset>
                  <section className={ui.preview} aria-labelledby="preview-heading">
                    <h2 id="preview-heading">{copyOnly ? 'Copy preview' : 'Swap preview'}</h2>
                    {copyOnly && (
                      <p className={ui.previewNote}>
                        Copy {plural(set.emotes.length, 'emote', 'emotes')} with their current chat names.
                      </p>
                    )}
                    {!copyOnly && preset === 'failed' && (
                      <p className={ui.callout}>
                        <strong>The {label} preset didn’t load.</strong> Reload the page to try again.
                      </p>
                    )}
                    {!copyOnly && preset === 'loading' && <p className={ui.previewNote}>Loading the {label} preset…</p>}
                    {plan && !copyOnly && (
                      <>
                        <p className={ui.previewNote}>
                          {plan.unmapped > 0 &&
                            (mode === 'revert'
                              ? `${plural(plan.unmapped, 'emote has', 'emotes have')} no normal version in the ${label} preset. `
                              : `${plural(plan.unmapped, 'emote has', 'emotes have')} no ${label} version yet. `)}
                          {plan.alreadyThere > 0 &&
                            `${plural(plan.alreadyThere, 'swap is', 'swaps are')} left out because the other version is already in the set. `}
                          {mode === 'duplicate' && plan.swaps.length > 0 && 'Unselected emotes are copied as-is.'}
                        </p>
                        {plan.swaps.length > 0 ? (
                          <SwapList
                            workspace
                            label="Swaps"
                            items={plan.swaps.map((s) => ({ key: swapKey(s.fromId, s.alias), alias: s.alias, fromId: s.fromId, toId: s.toId }))}
                            unticked={unticked}
                            onChange={setUnticked}
                          />
                        ) : (
                          <p className={ui.callout}>
                            <strong>Nothing to swap in this set.</strong>{' '}
                            {mode === 'revert'
                              ? `None of its emotes are ${label} versions the preset knows.`
                              : `None of its emotes have a ${label} version in the preset yet.`}
                          </p>
                        )}
                      </>
                    )}
                    {plan && mode === 'duplicate' && !copyOnly && !running && set.emotes.length > 0 && (
                      <SeasonalAlternatives
                        key={`${set.id}:${season}`}
                        emotes={set.emotes}
                        season={season}
                        saved={personal}
                        swaps={plan.swaps}
                        onChoose={(originalId, replacementId) => {
                          savePersonalMapping(season, originalId, replacementId);
                          setPersonalEdits((current) => ({
                            ...current,
                            [season]: { ...current[season], [originalId]: replacementId },
                          }));
                          setUnticked((current) => {
                            const next = new Set(current);
                            for (const emote of set.emotes) {
                              if (emote.id === originalId) next.delete(swapKey(emote.id, emote.alias));
                            }
                            return next;
                          });
                        }}
                      />
                    )}
                  </section>

                  <section className={ui.runBar} aria-label="Run">
                    <span role="status" className={ui.runStatus}>{readout}</span>
                    <button type="button" className={ui.primaryButton} disabled={running || !plan} onClick={() => void run()}>
                      {running ? (mode === 'duplicate' ? 'Copying…' : 'Applying…') : OPERATIONS[operation].action}
                      <ArrowRight size={16} aria-hidden="true" />
                    </button>
                  </section>
                </SetDetails>
              </>
            ) : (
              <section className={ui.emptyPreview} aria-labelledby="preview-heading">
                <span className={ui.emptyIcon}><Layers size={30} strokeWidth={1.5} aria-hidden="true" /></span>
                <h2 id="preview-heading">Choose a source set</h2>
                <p>Select one of your sets or paste a link to view its emotes.</p>
              </section>
            )}
          </div>
        </div>

        {runState.kind === 'failed' && (
          <p className={styles.plate} role="alert">
            {runState.message}
          </p>
        )}
        {runState.kind === 'done' && <RunSummary report={runState.report} />}

        {problems.length > 0 && (
          <ProblemList problems={problems} queued={queued} fixing={fixing} onFix={fix} onDismiss={dismiss} />
        )}

        {(runs.length > 0 || undoResult) && (
          <section className={styles.step} aria-labelledby="runs-heading">
            <h2 id="runs-heading" className={styles.sectionHeading}>
              Recent runs
            </h2>
            <p className={styles.stepLede}>
              Undo reverses exactly what a run did and leaves alone anything you’ve changed since. It works from this
              browser, for your last 10 runs.
            </p>
            {undoResult && <UndoSummary result={undoResult} />}
            <ul className={styles.runs}>
              {runs.map((record) => (
                <li key={record.id} className={styles.runRow}>
                  <div className={styles.runText}>
                    <p className={styles.runName}>{record.setName}</p>
                    <p className={styles.runMeta}>
                      {record.copyOnly ? 'Copy only' : `${MODE_NAMES[record.mode]} · ${seasonLabel(record.season)}`} · {when(record.at)}
                    </p>
                  </div>
                  <GunmetalKey size="small" busy={running || undoing === record.id} onClick={() => void undo(record)}>
                    {undoing === record.id ? 'Undoing…' : 'Undo'}
                  </GunmetalKey>
                </li>
              ))}
            </ul>
          </section>
        )}
      </main>
      <Notice message={notice} onDone={clearNotice} />
      <footer className={ui.footer}>
        <a href="https://github.com/kristruman/seventv-replacer">Source on GitHub</a>
        <a href="https://twitch.tv/niena">Originally made by niena</a>
        <p>Independent of 7TV</p>
      </footer>
    </div>
  );
}

function RunSummary({ report }: { report: RunReport }) {
  const { record } = report;
  return (
    <section className={styles.report} aria-labelledby="report-heading">
      <h2 id="report-heading" className={styles.sectionHeading}>
        {report.stopped ? 'Run stopped' : 'Run finished'}
      </h2>
      {report.stopped && (
        <p className={styles.plate} role="alert">
          <strong>{report.stopped}</strong> What was done so far is listed below and can be undone.
        </p>
      )}
      <p className={styles.stepLede}>
        {record.copyOnly
          ? `${plural(report.copied, 'emote', 'emotes')} copied to “${record.setName}”.`
          : record.mode === 'duplicate'
          ? `“${record.setName}” now has ${plural(report.swapped, 'seasonal emote', 'seasonal emotes')}${
              report.copied ? ` and ${report.copied} unchanged` : ''
            }. Switch to it on 7TV when you go live.`
          : `${plural(report.swapped, 'emote', 'emotes')} swapped in “${record.setName}”.`}{' '}
        <a href={seventvSetUrl(record.setId)} target="_blank" rel="noreferrer">
          Open it on 7TV
        </a>
      </p>
      {report.lost.length > 0 && (
        <p className={styles.plate}>
          <strong>
            {plural(report.lost.length, 'emote is', 'emotes are')} missing from the set now: {report.lost.join(', ')}.
          </strong>{' '}
          7TV refused both the swap and putting the original back. {report.lost.length === 1 ? 'It’s' : 'They’re'} under
          Problems below: a name 7TV accepts brings {report.lost.length === 1 ? 'it' : 'them'} back.
        </p>
      )}
      {report.failed.length > 0 && (
        <div className={styles.listBlock}>
          <p className={styles.listHeading}>{plural(report.failed.length, 'emote', 'emotes')} {record.copyOnly ? 'not copied' : 'not swapped'}</p>
          <ul className={styles.facts}>
            {report.failed.map((f, i) => (
              <li key={`${f.alias}-${i}`}>
                {f.alias}: {f.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function UndoSummary({ result }: { result: UndoResult }) {
  const { record, report, error } = result;
  if (error) {
    return (
      <p className={styles.plate} role="alert">
        <strong>Undo didn’t finish:</strong> {error}
      </p>
    );
  }
  if (!report) return null;
  if (record.createdSet) {
    return report.deletedSet ? (
      <p className={styles.note} role="status">
        Deleted “{record.setName}” from 7TV.
      </p>
    ) : (
      <p className={styles.plate} role="status">
        <strong>7TV wouldn’t let this tool delete “{record.setName}”.</strong>{' '}
        <a href={seventvSetUrl(record.setId)} target="_blank" rel="noreferrer">
          Delete it on 7TV
        </a>{' '}
        yourself.
      </p>
    );
  }
  return (
    <div className={styles.note} role="status">
      <p>
        Put back {plural(report.restored, 'emote', 'emotes')} in “{record.setName}”.
      </p>
      {report.skipped.length > 0 && (
        <p>
          Left {plural(report.skipped.length, 'emote', 'emotes')} alone because{' '}
          {report.skipped.length === 1 ? 'it' : 'they'} changed since the run: {report.skipped.join(', ')}.
        </p>
      )}
      {report.failed.length > 0 && (
        <p>
          7TV refused {report.failed.map((f) => f.alias).join(', ')}. The run stays in the list so you can try again.
        </p>
      )}
    </div>
  );
}
