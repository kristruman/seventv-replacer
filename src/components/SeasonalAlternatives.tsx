import { useEffect, useRef, useState } from 'react';
import { seasonLabel, type SeasonId } from '@shared/seasons';
import { searchSeasonalEmotes, type SeasonalCandidate, type SetEmote } from '@shared/seventv';
import { DeckField } from '../design/DeckField';
import { GunmetalKey } from '../design/GunmetalKey';
import { Keycap } from '../design/Keycap';
import type { PlannedSwap } from '../lib/run';
import styles from './SeasonalAlternatives.module.css';

interface Props {
  emotes: SetEmote[];
  season: SeasonId;
  saved: ReadonlyMap<string, string>;
  swaps: PlannedSwap[];
  onChoose(originalId: string, replacementId: string | null): void;
}

export function SeasonalAlternatives({ emotes, season, saved, swaps, onChoose }: Props) {
  const [originalId, setOriginalId] = useState('');
  const original = emotes.find((emote) => emote.id === originalId);
  const unavailable = new Set(emotes.map((emote) => emote.id));
  for (const swap of swaps) {
    if (swap.fromId !== originalId) unavailable.add(swap.toId);
  }

  return (
    <details className={styles.panel}>
      <summary>Find a {seasonLabel(season)} alternative</summary>
      <p>Saved choices apply to future copies for this season in this browser.</p>
      <label className={styles.picker}>
        Emote to replace
        <select value={originalId} onChange={(event) => setOriginalId(event.target.value)}>
          <option value="">Choose an emote</option>
          {Array.from(new Map(emotes.map((emote) => [emote.id, emote])).values()).map((emote) => (
            <option key={emote.id} value={emote.id}>{emote.alias}</option>
          ))}
        </select>
      </label>
      {original && (
        <CandidateSearch
          key={original.id}
          original={original}
          season={season}
          unavailable={unavailable}
          savedId={saved.get(original.id)}
          onChoose={(replacementId) => onChoose(original.id, replacementId)}
        />
      )}
    </details>
  );
}

interface SearchProps {
  original: SetEmote;
  season: SeasonId;
  unavailable: ReadonlySet<string>;
  savedId?: string;
  onChoose(replacementId: string | null): void;
}

function CandidateSearch({ original, season, unavailable, savedId, onChoose }: SearchProps) {
  const [name, setName] = useState(original.defaultName ?? original.alias);
  const [results, setResults] = useState<SeasonalCandidate[]>();
  const [status, setStatus] = useState('');
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  const candidates = results?.filter((emote) => !unavailable.has(emote.id));

  const search = async () => {
    if (!name.trim()) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setResults(undefined);
    setStatus('Searching 7TV…');
    try {
      const found = await searchSeasonalEmotes(name.trim(), season, controller.signal);
      if (controller.signal.aborted) return;
      setResults(found);
      setStatus('');
    } catch (error) {
      if (!controller.signal.aborted) setStatus(error instanceof Error ? error.message : 'Couldn’t search 7TV.');
    }
  };

  return (
    <>
      <div className={styles.original}>
        <Keycap emoteId={original.id} alt={original.alias} />
        <span>{original.alias}</span>
        {savedId && (
          <>
            <Keycap emoteId={savedId} alt={`Saved alternative for ${original.alias}`} tone="putty" />
            <GunmetalKey size="small" onClick={() => onChoose(null)}>Remove saved alternative</GunmetalKey>
          </>
        )}
      </div>
      <form className={styles.search} onSubmit={(event) => { event.preventDefault(); void search(); }}>
        <DeckField label="Search emote names" value={name} onChange={setName} />
        <GunmetalKey size="small" type="submit">Search 7TV</GunmetalKey>
      </form>
      <p role="status" className={styles.status}>
        {status || (candidates?.length === 0 ? 'No alternatives found. Try another search name.' : '')}
      </p>
      {candidates && candidates.length > 0 && (
        <ul className={styles.results} aria-label="Seasonal alternatives">
          {candidates.map((candidate) => (
            <li key={candidate.id}>
              <Keycap emoteId={candidate.id} alt={candidate.defaultName} tone="putty" />
              <span>{candidate.defaultName}
                <small>{candidate.owner?.mainConnection?.platformDisplayName}</small>
              </span>
              <GunmetalKey
                size="small"
                label={`Use ${candidate.defaultName}${candidate.owner?.mainConnection?.platformDisplayName ? ` by ${candidate.owner.mainConnection.platformDisplayName}` : ''}`}
                busy={savedId === candidate.id}
                onClick={() => onChoose(candidate.id)}
              >
                {savedId === candidate.id ? 'Saved' : 'Use this emote'}
              </GunmetalKey>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
