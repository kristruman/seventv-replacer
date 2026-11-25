import { Grid2X2, Search, SlidersHorizontal } from 'lucide-react';
import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { EmoteSet, SetEmote } from '@shared/seventv';
import { Keycap } from '../design/Keycap';
import { EmoteInspector, type EmoteReplacement, type SeasonalContext } from './EmoteInspector';
import styles from './SetDetails.module.css';

const PAGE_SIZE = 60;
const TABS = [
  { id: 'emotes', label: 'Emotes', icon: Grid2X2 },
  { id: 'actions', label: 'Actions', icon: SlidersHorizontal },
] as const;

type SetTab = (typeof TABS)[number]['id'];

interface SetDetailsProps {
  set: EmoteSet;
  seasonal: SeasonalContext;
  connected: boolean;
  onConnect(): void;
  onSwap(emote: SetEmote, replacement: EmoteReplacement): Promise<SetEmote>;
  children: ReactNode;
}

export function SetDetails({ set, seasonal, connected, onConnect, onSwap, children }: SetDetailsProps) {
  const id = useId();
  const [tab, setTab] = useState<SetTab>('emotes');
  const [inspected, setInspected] = useState<SetEmote>();
  const buttons = useRef<Partial<Record<SetTab, HTMLButtonElement>>>({});

  const navigate = (event: KeyboardEvent<HTMLButtonElement>, current: SetTab) => {
    let next: SetTab;
    switch (event.key) {
      case 'ArrowLeft':
      case 'ArrowRight':
        next = current === 'emotes' ? 'actions' : 'emotes';
        break;
      case 'Home':
        next = 'emotes';
        break;
      case 'End':
        next = 'actions';
        break;
      default:
        return;
    }
    event.preventDefault();
    setTab(next);
    buttons.current[next]?.focus();
  };

  return (
    <>
      <div className={styles.tabs} role="tablist" aria-label="Set details">
        {TABS.map(({ id: value, label, icon: Icon }) => (
          <button
            key={value}
            ref={(button) => { buttons.current[value] = button ?? undefined; }}
            id={`${id}-${value}-tab`}
            type="button"
            role="tab"
            aria-selected={tab === value}
            aria-controls={`${id}-${value}-panel`}
            tabIndex={tab === value ? 0 : -1}
            onClick={() => setTab(value)}
            onKeyDown={(event) => navigate(event, value)}
          >
            <Icon size={16} aria-hidden="true" />
            {label}
          </button>
        ))}
      </div>
      <div id={`${id}-emotes-panel`} role="tabpanel" aria-labelledby={`${id}-emotes-tab`} hidden={tab !== 'emotes'}>
        <EmoteGallery emotes={set.emotes} onInspect={setInspected} />
      </div>
      <div id={`${id}-actions-panel`} role="tabpanel" aria-labelledby={`${id}-actions-tab`} hidden={tab !== 'actions'}>
        {children}
      </div>
      {inspected && (
        <EmoteInspector
          set={set}
          emote={inspected}
          seasonal={seasonal}
          connected={connected}
          onConnect={onConnect}
          onSwap={async (replacement) => setInspected(await onSwap(inspected, replacement))}
          onDismiss={() => setInspected(undefined)}
        />
      )}
    </>
  );
}

function EmoteGallery({ emotes, onInspect }: { emotes: SetEmote[]; onInspect(emote: SetEmote): void }) {
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(PAGE_SIZE);
  const term = query.trim().toLowerCase();
  const matches = term ? emotes.filter(({ alias, defaultName }) => (
    alias.toLowerCase().includes(term) || defaultName?.toLowerCase().includes(term)
  )) : emotes;
  const visible = matches.slice(0, limit);

  if (emotes.length === 0) {
    return <p className={styles.empty}>There are no emotes in this set yet.</p>;
  }

  return (
    <div className={styles.gallery}>
      <div className={styles.galleryToolbar}>
        <label className={styles.search}>
          <Search size={16} aria-hidden="true" />
          <input
            type="search"
            aria-label="Search emotes"
            placeholder="Search emotes"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setLimit(PAGE_SIZE);
            }}
          />
        </label>
        {(term || matches.length > PAGE_SIZE) && (
          <span className={styles.count} aria-live="polite">
            {matches.length > PAGE_SIZE
              ? `Showing ${visible.length} of ${matches.length}`
              : `${matches.length} ${matches.length === 1 ? 'match' : 'matches'}`}
          </span>
        )}
      </div>
      {visible.length > 0 ? (
        <ul className={styles.tiles} aria-label="Emotes in this set">
          {visible.map((emote) => (
            <li key={JSON.stringify([emote.id, emote.alias])}>
              <Keycap emoteId={emote.id} alt={emote.alias} caption={emote.alias} onInspect={() => onInspect(emote)} />
            </li>
          ))}
        </ul>
      ) : <p className={styles.empty}>No emotes match “{query.trim()}”.</p>}
      {matches.length > visible.length && (
        <button type="button" className={styles.more} onClick={() => setLimit(limit + PAGE_SIZE)}>
          Show {Math.min(PAGE_SIZE, matches.length - visible.length)} more
        </button>
      )}
    </div>
  );
}
