import { Search, X } from 'lucide-react';
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

interface Props {
  set: EmoteSet;
  emote: SetEmote;
  seasonal: SeasonalContext;
  onDismiss(): void;
}

type SearchResult = { candidates: SeasonalCandidate[] } | { error: string };

export function EmoteInspector({ set, emote, seasonal, onDismiss }: Props) {
  const { season, preset, saved, onSeasonChange } = seasonal;
  const modal = useRef<HTMLDialogElement>(null);
  const heading = useId();
  const [input, setInput] = useState<string>();
  const [request, setRequest] = useState<{ term: string }>();
  const [result, setResult] = useState<SearchResult>();

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
  const setUsage = (id: string) => {
    const aliases = set.emotes.filter((entry) => entry.id === id).map((entry) => entry.alias).join(', ');
    return aliases ? <p>In this set as {aliases}</p> : null;
  };

  return (
    <dialog ref={modal} className={styles.dialog} aria-labelledby={heading} onClose={onDismiss}>
      <header className={styles.header}>
        <div>
          <p>{set.name}</p>
          <h2 id={heading}>{emote.alias}</h2>
        </div>
        <button type="button" className={styles.close} aria-label="Close emote details" onClick={() => modal.current?.close()}>
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
            <select aria-label="Replacement season" value={season} onChange={(event) => {
              if (isSeasonId(event.target.value)) onSeasonChange(event.target.value);
            }}>
              {SEASONS.map((option) => <option key={option} value={option}>{seasonLabel(option)}</option>)}
            </select>
          </div>
          {!!related.size && (
            <ul className={styles.rows} aria-label="Known versions">
              {Array.from(related, ([id, description]) => (
                <li key={id}>
                  <Keycap emoteId={id} alt={`${description} of ${emote.alias}`} />
                  <div>
                    <strong>{description}</strong>
                    {setUsage(id)}
                  </div>
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
              {candidates.map((candidate) => (
                <li key={candidate.id}>
                  <Keycap emoteId={candidate.id} alt={candidate.defaultName} preferCdn />
                  <div>
                    <strong>{candidate.defaultName}</strong>
                    {candidate.owner?.mainConnection && <p>{candidate.owner.mainConnection.platformDisplayName}</p>}
                    {setUsage(candidate.id)}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </dialog>
  );
}
