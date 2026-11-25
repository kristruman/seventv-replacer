import { ArrowRight, Search, X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { isSeasonId, SEASONS, seasonLabel, type SeasonId } from '@shared/seasons';
import { searchSeasonalEmotes, type EmoteSet, type SeasonalCandidate, type SetEmote } from '@shared/seventv';
import type { MappingRow } from '@shared/types';
import { Keycap } from '../design/Keycap';
import styles from './EmoteInspector.module.css';

export interface SeasonalContext {
  season: SeasonId;
  preset: MappingRow[];
  saved: ReadonlyMap<string, string>;
  onSeasonChange(season: SeasonId): void;
}

export interface EmoteReplacement {
  id: string;
  label: string;
  defaultName?: string;
  creator?: string;
}

interface Props {
  set: EmoteSet;
  emote: SetEmote;
  seasonal: SeasonalContext;
  connected: boolean;
  onConnect(): void;
  onSwap(replacement: EmoteReplacement): Promise<void>;
  onDismiss(): void;
}

type SearchResult = { candidates: SeasonalCandidate[] } | { error: string };

export function EmoteInspector({ set, emote, seasonal, connected, onConnect, onSwap, onDismiss }: Props) {
  const { season, preset, saved, onSeasonChange } = seasonal;
  const modal = useRef<HTMLDialogElement>(null);
  const heading = useId();
  const [input, setInput] = useState<string>();
  const [request, setRequest] = useState<{ term: string }>();
  const [result, setResult] = useState<SearchResult>();
  const [choice, setChoice] = useState<EmoteReplacement>();
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{ message: string; error?: boolean }>();

  const label = seasonLabel(season);
  const originals = preset.filter((mapping) => mapping.replacementId === emote.id && mapping.originalId !== emote.id);
  const initialTerm = originals.length ? emote.alias : emote.defaultName ?? emote.alias;
  const term = request?.term ?? initialTerm;
  const related = new Map<string, string>();

  for (const original of originals) {
    related.set(original.originalId, originals.length === 1 ? 'Regular version' : 'Possible regular version');
  }
  const presetId = preset.find(({ originalId }) => originalId === emote.id)?.replacementId;
  if (presetId && presetId !== emote.id) related.set(presetId, `${label} preset`);
  const savedId = saved.get(emote.id);
  if (savedId && savedId !== emote.id) related.set(savedId, 'Your saved choice');

  useEffect(() => {
    if (modal.current && !modal.current.open) modal.current.showModal();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setResult(undefined);
    void searchSeasonalEmotes(term, season, controller.signal).then(
      (candidates) => {
        if (!controller.signal.aborted) setResult({ candidates });
      },
      (error: unknown) => {
        if (!controller.signal.aborted) {
          setResult({ error: error instanceof Error ? error.message : 'Couldn’t search 7TV.' });
        }
      },
    );
    return () => controller.abort();
  }, [term, season, request]);

  const shown = new Set([emote.id, ...related.keys()]);
  const candidates = result && 'candidates' in result ? result.candidates.filter(({ id }) => {
    if (shown.has(id)) return false;
    shown.add(id);
    return true;
  }) : [];
  const selectionControl = (candidate: EmoteReplacement) => {
    const aliases = set.emotes.filter(({ id }) => id === candidate.id).map(({ alias }) => alias).join(', ');
    if (aliases) return <small className={styles.used}>In this set as {aliases}</small>;
    return (
      <button
        type="button"
        className={styles.choose}
        aria-label={`Select ${candidate.label}${candidate.creator ? ` by ${candidate.creator}` : ''}`}
        aria-pressed={choice?.id === candidate.id}
        disabled={saving}
        onClick={() => {
          setChoice(candidate);
          setFeedback(undefined);
        }}
      >
        {choice?.id === candidate.id ? 'Selected' : 'Select'}
      </button>
    );
  };

  const confirm = async () => {
    if (!choice || saving) return;
    if (!connected) {
      modal.current?.close();
      onConnect();
      return;
    }
    setSaving(true);
    setFeedback(undefined);
    try {
      await onSwap(choice);
      setFeedback({ message: `Swapped artwork for “${emote.alias}”. Undo is available in Recent runs.` });
      setChoice(undefined);
    } catch (error) {
      setFeedback({ message: error instanceof Error ? error.message : '7TV couldn’t complete the swap.', error: true });
    } finally {
      setSaving(false);
    }
  };

  return (
    <dialog
      ref={modal}
      className={styles.dialog}
      aria-labelledby={heading}
      onClose={onDismiss}
      onCancel={(event) => { if (saving) event.preventDefault(); }}
    >
      <header className={styles.header}>
        <div>
          <p>{set.name}</p>
          <h2 id={heading}>{emote.alias}</h2>
        </div>
        <button type="button" className={styles.close} aria-label="Close emote details" disabled={saving} onClick={() => modal.current?.close()}>
          <X size={19} aria-hidden="true" />
        </button>
      </header>
      <div className={styles.body}>
        <div className={styles.current}>
          <Keycap emoteId={emote.id} alt={emote.alias} />
          <dl>
            <dt>Chat name in this set</dt>
            <dd>{emote.alias}</dd>
            {emote.defaultName && emote.defaultName !== emote.alias && (
              <>
                <dt>Emote name on 7TV</dt>
                <dd>{emote.defaultName}</dd>
              </>
            )}
          </dl>
        </div>

        <section className={styles.alternatives} aria-label="Potential replacements">
          <div className={styles.sectionHeading}>
            <h3>Potential replacements</h3>
            <select aria-label="Replacement season" value={season} disabled={saving} onChange={(event) => {
              if (isSeasonId(event.target.value)) onSeasonChange(event.target.value);
            }}>
              {SEASONS.map((option) => <option key={option} value={option}>{seasonLabel(option)}</option>)}
            </select>
          </div>
          {!!related.size && (
            <ul className={styles.rows} aria-label="Known versions">
              {Array.from(related, ([id, description]) => (
                <li key={id} data-selected={choice?.id === id || undefined}>
                  <Keycap emoteId={id} alt={`${description} of ${emote.alias}`} />
                  <strong>{description}</strong>
                  {selectionControl({ id, label: description })}
                </li>
              ))}
            </ul>
          )}
          <form className={styles.search} onSubmit={(event) => {
            event.preventDefault();
            const value = (input ?? initialTerm).trim();
            if (value) setRequest({ term: value });
          }}>
            <input
              type="search"
              aria-label="Search replacements"
              value={input ?? initialTerm}
              onChange={(event) => setInput(event.target.value)}
            />
            <button type="submit" aria-label="Search 7TV"><Search size={17} aria-hidden="true" /></button>
          </form>
          <p className={styles.status} role="status">
            {!result && 'Searching 7TV…'}
            {result && 'error' in result && result.error}
            {result && 'candidates' in result && (
              candidates.length === 0 ? 'No other matches. Try another search name.' :
                `${candidates.length} ${candidates.length === 1 ? 'match' : 'matches'} for “${term}”`
            )}
          </p>
          {candidates.length > 0 && (
            <ul className={styles.rows} aria-label="7TV replacement candidates">
              {candidates.map((candidate) => {
                const creator = candidate.owner?.mainConnection?.platformDisplayName;
                return (
                  <li key={candidate.id} data-selected={choice?.id === candidate.id || undefined}>
                    <Keycap emoteId={candidate.id} alt={candidate.defaultName} preferCdn />
                    <div>
                      <strong>{candidate.defaultName}</strong>
                      {creator && <p>{creator}</p>}
                    </div>
                    {selectionControl({ id: candidate.id, label: candidate.defaultName, defaultName: candidate.defaultName, creator })}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
      {(choice || feedback) && (
        <footer className={styles.confirm}>
          {feedback && (
            <p className={styles.feedback} data-error={feedback.error || undefined} role={feedback.error ? 'alert' : 'status'}>
              {feedback.message}
            </p>
          )}
          {choice && (
            <div className={styles.confirmRow}>
              <div className={styles.selectedChoice}>
                <strong>{choice.label}</strong>
                {choice.creator && <small>{choice.creator}</small>}
                <small>Chat name stays {emote.alias}</small>
              </div>
              <button type="button" className={styles.apply} disabled={saving} onClick={() => void confirm()}>
                {saving ? 'Swapping…' : connected ? 'Swap in this set' : 'Connect 7TV'}
                <ArrowRight size={15} aria-hidden="true" />
              </button>
            </div>
          )}
        </footer>
      )}
    </dialog>
  );
}
