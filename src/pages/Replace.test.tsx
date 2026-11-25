import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { json, mockFetch, renderAt } from '../test/render';
import { emoteId, SEASONAL_ID, SET_ID, sevenTvRead, type Mutation } from '../test/seventv-mock';

const A = emoteId(1, 'A');
const B = emoteId(2, 'B');
const X = emoteId(3, 'X');
const A2 = emoteId(1, 'R');
const B2 = emoteId(2, 'R');

const preset = (season: string) => json({ season, mappings: [{ originalId: A, replacementId: A2 }, { originalId: B, replacementId: B2 }] });

let sets: Record<string, { name: string; emotes: Array<[string, string]> }>;
let mutations: Mutation[];

function setUp() {
  sets = { [SET_ID]: { name: 'Main', emotes: [['peepoHappy', A], ['Sadge', B], ['KEKW', X]] } };
  mutations = [];
  return mockFetch({
    ...sevenTvRead(sets, (change) => void mutations.push(change)),
    '/api/presets/': (url) => preset(url.split('/').pop()!),
  });
}

async function pickMain() {
  await userEvent.click(await screen.findByRole('button', { name: /Main/ }));
  await openActions();
  await screen.findByRole('list', { name: 'Swaps' });
}

async function openActions() {
  await userEvent.click(await screen.findByRole('tab', { name: 'Actions' }));
}

async function openTokenField() {
  await userEvent.click(screen.getByRole('button', { name: /^(Connect 7TV|7TV connect)/i }));
  return screen.getByLabelText('7TV token', { exact: true });
}

describe('Replace', () => {
  beforeEach(() => {
    localStorage.clear();
    setUp();
  });

  it('picks up the channel and season from the landing page', async () => {
    renderAt('/replace?channel=niena&season=winter');
    await pickMain();
    expect(screen.getByRole('combobox', { name: 'Season' })).toHaveValue('winter');
    expect(screen.getByText('niena’s sets on 7TV')).toBeInTheDocument();
  });

  it('opens a searchable gallery first and keeps editing under Actions', async () => {
    sets[SET_ID]!.emotes = Array.from({ length: 61 }, (_, i) => [`Emote ${i + 1}`, emoteId(i + 1, 'E')]);
    renderAt('/replace?channel=niena&season=winter');
    await userEvent.click(await screen.findByRole('button', { name: /Main/ }));
    const gallery = await screen.findByRole('list', { name: 'Emotes in this set' });
    expect(within(gallery).getAllByRole('listitem')).toHaveLength(60);
    expect(screen.queryByRole('combobox', { name: 'Operation' })).not.toBeInTheDocument();
    const search = screen.getByRole('searchbox', { name: 'Search emotes' });
    await userEvent.type(search, '61');
    expect(within(gallery).getByRole('button', { name: 'Emote 61' })).toBeInTheDocument();
    expect(within(gallery).getAllByRole('listitem')).toHaveLength(1);
    await userEvent.clear(search);
    await userEvent.click(screen.getByRole('button', { name: 'Show 1 more' }));
    expect(within(gallery).getAllByRole('listitem')).toHaveLength(61);

    const emotesTab = screen.getByRole('tab', { name: 'Emotes' });
    emotesTab.focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Actions' })).toHaveFocus();
    expect(screen.getByRole('combobox', { name: 'Operation' })).toHaveValue('seasonal-copy');
    expect(screen.queryByRole('searchbox', { name: 'Search emotes' })).not.toBeInTheDocument();
    expect(mutations).toEqual([]);
  });

  it('inspects a seasonal emote in its set and shows its regular artwork and read-only suggestions', async () => {
    const dialogPrototype = HTMLDialogElement.prototype;
    const originalShowModal = Object.getOwnPropertyDescriptor(dialogPrototype, 'showModal');
    Object.defineProperty(dialogPrototype, 'showModal', {
      configurable: true,
      value(this: HTMLDialogElement) { this.open = true; },
    });
    try {
      sets[SET_ID] = { name: 'Main', emotes: [['peepoHappy', A2], ['Sadge', B]] };
      const read = sevenTvRead(sets, (change) => void mutations.push(change));
      mockFetch({
        ...read,
        'https://7tv.io/v4/gql': (url, init) => {
          const body = JSON.parse(String(init?.body));
          if (!body.query?.includes('SeasonalEmotes')) return read['https://7tv.io/v4/gql'](url, init);
          expect(body.variables).toMatchObject({ name: 'peepoHappy', tags: expect.arrayContaining(['Christmas']) });
          expect(new Headers(init?.headers).has('Authorization')).toBe(false);
          return json({ data: { emotes: { search: { items: [
            { id: A2, defaultName: 'CurrentPeepo', owner: null },
            { id: A, defaultName: 'OriginalPeepo', owner: null },
            { id: B, defaultName: 'AnotherPeepo', owner: null },
          ] } } } });
        },
        '/api/presets/': () => preset('winter'),
      });
      renderAt('/replace?channel=niena&season=winter');
      await userEvent.click(await screen.findByRole('button', { name: /Main/ }));
      await userEvent.click(await screen.findByRole('button', { name: 'peepoHappy' }));
      const dialog = screen.getByRole('dialog', { name: 'peepoHappy' });
      expect(within(dialog).getByText('Main')).toBeInTheDocument();
      expect(within(dialog).getByText('Chat name in this set')).toBeInTheDocument();
      expect(within(dialog).getByRole('link', { name: /regular version of peepoHappy/i }))
        .toHaveAttribute('href', `https://7tv.app/emotes/${A}`);
      const candidates = await within(dialog).findByRole('list', { name: '7TV replacement candidates' });
      expect(within(candidates).getAllByRole('listitem')).toHaveLength(1);
      expect(within(candidates).getByText('In this set as Sadge')).toBeInTheDocument();
      expect(mutations).toEqual([]);
    } finally {
      if (originalShowModal) Object.defineProperty(dialogPrototype, 'showModal', originalShowModal);
      else Reflect.deleteProperty(dialogPrototype, 'showModal');
    }
  });

  it('automatically lists the saved token account’s sets with its active set first', async () => {
    localStorage.setItem('ser.7tv-token', 'saved-token');
    const read = sevenTvRead(sets, (change) => void mutations.push(change));
    const mock = mockFetch({
      ...read,
      'https://7tv.io/v4/gql': (url, init) => {
        if (!JSON.parse(String(init?.body)).query?.includes('MyEmoteSets')) return read['https://7tv.io/v4/gql'](url, init);
        expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer saved-token');
        return json({ data: { users: { me: {
          ownedEmoteSets: [
            { id: SEASONAL_ID, name: 'Winter', kind: 'NORMAL' },
            { id: SET_ID, name: 'Main', kind: 'NORMAL' },
            { id: 'P', name: 'Personal', kind: 'PERSONAL' },
          ],
          style: { activeEmoteSet: { id: SET_ID, name: 'Main', kind: 'NORMAL' } },
        } } } });
      },
      '/api/presets/': () => preset('winter'),
    });
    renderAt('/replace?season=winter');
    const list = await screen.findByRole('list', { name: 'Your 7TV sets' });
    const choices = within(list).getAllByRole('button');
    expect(choices).toHaveLength(2);
    expect(choices[0]).toHaveTextContent(/Main\s*active/i);
    expect(choices[1]).toHaveTextContent('Winter');
    expect(mock.mock.calls.some(([url]) => String(url).includes('api.ivr.fi'))).toBe(false);
    await userEvent.click(choices[0]!);
    await screen.findByRole('list', { name: 'Emotes in this set' });
    expect(mutations).toEqual([]);
    expect(choices[0]).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('list', { name: 'Your 7TV sets' })).toBeInTheDocument();
    await openTokenField();
    await userEvent.click(screen.getByRole('button', { name: 'Forget token' }));
    expect(screen.queryByRole('list', { name: 'Your 7TV sets' })).not.toBeInTheDocument();
  });

  it('loads account sets after a token is pasted, including a set owned by someone else that is active', async () => {
    const requests: string[] = [];
    mockFetch({
      'https://7tv.io/v4/gql': (_url, init) => {
        requests.push(new Headers(init?.headers).get('Authorization') ?? '');
        return json({ data: { users: { me: {
          ownedEmoteSets: [],
          style: { activeEmoteSet: { id: SET_ID, name: 'Editor set', kind: 'NORMAL' } },
        } } } });
      },
      '/api/presets/': () => preset('winter'),
    });
    renderAt('/replace?season=winter');
    await userEvent.click(await openTokenField());
    await userEvent.paste('Bearer pasted-token');
    const list = await screen.findByRole('list', { name: 'Your 7TV sets' });
    expect(within(list).getByRole('button', { name: 'Editor set, active' })).toBeInTheDocument();
    expect(requests).toEqual(['Bearer pasted-token']);
  });

  it('shows a token error and still loads a pasted public set link', async () => {
    localStorage.setItem('ser.7tv-token', 'expired');
    mockFetch({
      ...sevenTvRead(sets),
      'https://7tv.io/v4/gql': () => json({ error: 'invalid session', error_code: 1000 }, 401),
      '/api/presets/': () => preset('winter'),
    });
    renderAt('/replace?season=winter');
    expect(await screen.findByText(/paste a fresh token/i)).toBeInTheDocument();
    const setInput = screen.getByLabelText('Find a set');
    await userEvent.click(setInput);
    await userEvent.paste(`https://7tv.app/emote-sets/${SET_ID}`);
    await userEvent.click(screen.getByRole('button', { name: 'Find' }));
    expect(await screen.findByRole('list', { name: 'Emotes in this set' })).toBeInTheDocument();
  });

  it('previews every swap, all ticked, and sums up emotes without a seasonal version', async () => {
    renderAt('/replace?channel=niena&season=halloween');
    await pickMain();
    const rows = within(screen.getByRole('list', { name: 'Swaps' })).getAllByRole('checkbox');
    expect(rows).toHaveLength(2);
    rows.forEach((box) => expect(box).toBeChecked());
    expect(screen.getByText(/1 emote has no Halloween version yet/)).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Halloween · 2 swaps');
    await userEvent.click(screen.getByRole('checkbox', { name: 'Sadge' }));
    expect(screen.getByRole('status')).toHaveTextContent('Halloween · 1 swap');
  });

  it('asks for the token before running', async () => {
    renderAt('/replace?channel=niena');
    await pickMain();
    await userEvent.click(screen.getByRole('button', { name: /create seasonal copy|apply swaps/i }));
    expect(screen.getByLabelText('7TV token', { exact: true })).toHaveFocus();
    expect(screen.getByText('Paste your 7TV token first.')).toBeInTheDocument();
    expect(mutations).toEqual([]);
  });

  it('suggests a name for the copy', async () => {
    renderAt('/replace?channel=niena&season=winter');
    await pickMain();
    expect(screen.getByLabelText('Name of the new set')).toHaveValue('Main (Winter)');
  });

  it('copies the original emotes and aliases even when the seasonal preset is unavailable', async () => {
    mockFetch({
      ...sevenTvRead(sets, (change) => void mutations.push(change)),
      '/api/presets/': () => json({}, 503),
    });
    localStorage.setItem('ser.7tv-token', 'tok');
    renderAt('/replace?channel=niena&season=winter');
    await userEvent.click(await screen.findByRole('button', { name: /Main/ }));
    await openActions();
    await screen.findByText(/Winter preset didn’t load/);
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Operation' }), 'copy');
    expect(screen.getByLabelText('Name of the new set')).toHaveValue('Main (Copy)');
    await userEvent.click(screen.getByRole('button', { name: 'Copy set' }));
    expect(await screen.findByText(/3 emotes copied to “Main \(Copy\)”/)).toBeInTheDocument();
    expect(mutations).toEqual([
      { id: 'NEW', action: 'ADD', emote_id: A, name: 'peepoHappy' },
      { id: 'NEW', action: 'ADD', emote_id: B, name: 'Sadge' },
      { id: 'NEW', action: 'ADD', emote_id: X, name: 'KEKW' },
    ]);
  });

  it('only swaps a search result after selection and remembers it for the same season', async () => {
    const winterKekw = emoteId(4, 'Z');
    const read = sevenTvRead(sets, (change) => void mutations.push(change));
    mockFetch({
      ...read,
      'https://7tv.io/v4/gql': (url, init) => {
        const body = JSON.parse(String(init?.body));
        if (!body.query?.includes('SeasonalEmotes')) return read['https://7tv.io/v4/gql'](url, init);
        expect(body.variables).toMatchObject({ name: 'KEKW', tags: expect.arrayContaining(['Christmas']) });
        expect(new Headers(init?.headers).has('Authorization')).toBe(false);
        return json({ data: { emotes: { search: {
          items: [{ id: winterKekw, defaultName: 'SantaKEKW', owner: null }],
        } } } });
      },
      '/api/presets/': (url) => preset(url.split('/').pop()!),
    });

    localStorage.setItem('ser.7tv-token', 'tok');
    const page = renderAt('/replace?channel=niena&season=winter');
    await pickMain();
    await userEvent.click(screen.getByText('Find a Winter alternative'));
    await userEvent.selectOptions(screen.getByLabelText('Emote to replace'), X);
    await userEvent.click(screen.getByRole('button', { name: 'Search 7TV' }));
    const useCandidate = await screen.findByRole('button', { name: 'Use SantaKEKW' });
    expect(screen.queryByRole('checkbox', { name: 'KEKW' })).not.toBeInTheDocument();
    await userEvent.click(useCandidate);
    expect(screen.getByRole('checkbox', { name: 'KEKW' })).toBeChecked();
    expect(mutations).toEqual([]);
    page.unmount();

    renderAt('/replace?channel=niena&season=winter');
    await pickMain();
    expect(screen.getByRole('checkbox', { name: 'KEKW' })).toBeChecked();
    await userEvent.click(screen.getByRole('button', { name: /create seasonal copy|apply swaps/i }));
    await screen.findByRole('heading', { name: 'Run finished' });
    expect(mutations).toContainEqual({ id: 'NEW', action: 'ADD', emote_id: winterKekw, name: 'KEKW' });
  });

  it('warns before replacing in place', async () => {
    renderAt('/replace?channel=niena&season=halloween');
    await pickMain();
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Operation' }), 'in-place');
    expect(screen.getByText(/this edits the source set/i)).toBeInTheDocument();
  });

  it('swaps in place keeping aliases, then offers Undo for the run', async () => {
    renderAt('/replace?channel=niena&season=halloween');
    await userEvent.type(await openTokenField(), 'tok');
    await pickMain();
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Operation' }), 'in-place');
    await userEvent.click(screen.getByRole('checkbox', { name: 'Sadge' }));
    await userEvent.click(screen.getByRole('button', { name: /create seasonal copy|apply swaps/i }));

    await screen.findByRole('heading', { name: 'Run finished' }, { timeout: 4000 });
    expect(mutations).toEqual([
      { id: SET_ID, action: 'REMOVE', emote_id: A, name: 'peepoHappy' },
      { id: SET_ID, action: 'ADD', emote_id: A2, name: 'peepoHappy' },
    ]);
    expect(screen.getByText(/1 emote swapped in “Main”/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem('ser.runs')!)).toHaveLength(1);
    expect(localStorage.getItem('ser.7tv-token')).toBe('tok');
  });

  it('undoes a run, skipping nothing when the set is as the run left it', async () => {
    renderAt('/replace?channel=niena&season=halloween');
    await userEvent.type(await openTokenField(), 'tok');
    await pickMain();
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Operation' }), 'in-place');
    await userEvent.click(screen.getByRole('checkbox', { name: 'Sadge' }));
    await userEvent.click(screen.getByRole('button', { name: /create seasonal copy|apply swaps/i }));
    await screen.findByRole('heading', { name: 'Run finished' }, { timeout: 4000 });

    sets[SET_ID]!.emotes = [['peepoHappy', A2], ['Sadge', B], ['KEKW', X]];
    mutations.length = 0;
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await screen.findByText('Put back 1 emote in “Main”.', {}, { timeout: 4000 });
    expect(mutations).toEqual([
      { id: SET_ID, action: 'REMOVE', emote_id: A2, name: 'peepoHappy' },
      { id: SET_ID, action: 'ADD', emote_id: A, name: 'peepoHappy' },
    ]);
    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
  });

  it('tells the user to log in to 7TV again when the token is rejected', async () => {
    setUp();
    const rejected = () => json({ status: 'Unauthorized', error_code: 1000, error: 'invalid session' }, 401);
    const read = sevenTvRead(sets);
    mockFetch({
      ...read,
      'https://7tv.io/v3/gql': rejected,
      'https://7tv.io/v4/gql': (url, init) =>
        Array.isArray(JSON.parse(String(init?.body))) ? rejected() : read['https://7tv.io/v4/gql'](url, init),
      '/api/presets/': (url) => preset(url.split('/').pop()!),
    });
    renderAt('/replace?channel=niena&season=halloween');
    await userEvent.type(await openTokenField(), 'old');
    await pickMain();
    await userEvent.click(screen.getByRole('button', { name: /create seasonal copy|apply swaps/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Log out of 7tv.app and log back in');
  });

  it('carries on past a refused name, lists it under Problems, and retries it with a new name', async () => {
    sets[SET_ID]!.emotes = [['a,b', A], ['KEKW', X]];
    mockFetch({
      ...sevenTvRead(sets, (change) => {
        mutations.push(change);
        return change.name?.includes(',') ? 'Invalid emote name' : undefined;
      }),
      '/api/presets/': (url) => preset(url.split('/').pop()!),
    });
    renderAt('/replace?channel=niena&season=halloween');
    await userEvent.type(await openTokenField(), 'tok');
    await pickMain();
    await userEvent.click(screen.getByRole('button', { name: /create seasonal copy|apply swaps/i }));

    await screen.findByRole('heading', { name: 'Run finished' }, { timeout: 4000 });
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(screen.getByText('a,b was set aside. The run carries on.')).toBeInTheDocument();
    const problems = screen.getByRole('region', { name: 'Problems' });
    expect(within(problems).getByText(/Invalid emote name/)).toBeInTheDocument();
    expect(within(problems).getByLabelText('New name for a,b')).toHaveValue('ab');
    expect(JSON.parse(localStorage.getItem('ser.problems')!)).toHaveLength(1);

    sets.NEW = { name: 'Main (Halloween)', emotes: [['KEKW', X]] };
    mutations.length = 0;
    await userEvent.click(within(problems).getByRole('button', { name: 'Retry a,b' }));
    await screen.findByText('a,b is in as “ab”.', {}, { timeout: 4000 });
    expect(mutations).toEqual([{ id: 'NEW', action: 'ADD', emote_id: A2, name: 'ab' }]);
    expect(screen.queryByRole('region', { name: 'Problems' })).not.toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem('ser.problems')!)).toEqual([]);
  });

  it('takes a fix made during the run, and Undo knows about it', async () => {
    sets[SET_ID]!.emotes = [['a,b', A], ['Sadge', B]];
    mockFetch({
      ...sevenTvRead(sets, (change) => {
        mutations.push(change);
        // Taking "a,b" out works; putting anything in under it doesn't.
        return change.action === 'ADD' && change.name?.includes(',') ? 'Invalid emote name' : undefined;
      }),
      '/api/presets/': (url) => preset(url.split('/').pop()!),
    });
    renderAt('/replace?channel=niena&season=halloween');
    await userEvent.type(await openTokenField(), 'tok');
    await pickMain();
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Operation' }), 'in-place');
    await userEvent.click(screen.getByRole('button', { name: /create seasonal copy|apply swaps/i }));

    const problems = await screen.findByRole('region', { name: 'Problems' }, { timeout: 4000 });
    // 7TV took neither version under "a,b": the set is short it until the fix.
    sets[SET_ID]!.emotes = [['Sadge', B2]];
    await userEvent.click(within(problems).getByRole('button', { name: 'Retry a,b' }));
    await screen.findByRole('heading', { name: 'Run finished' }, { timeout: 4000 });
    await screen.findByText('a,b is in as “ab”.', {}, { timeout: 4000 });
    expect(mutations).toContainEqual({ id: SET_ID, action: 'ADD', emote_id: A2, name: 'ab' });
    expect(JSON.parse(localStorage.getItem('ser.runs')!)[0].swaps).toContainEqual({
      fromId: A,
      toId: A2,
      alias: 'ab',
      originalAlias: 'a,b',
    });
  });

  it('tells the admins about a broken seasonal emote, and lets the user dismiss it', async () => {
    const reports: unknown[] = [];
    mockFetch({
      ...sevenTvRead(sets, (change) => (change.emote_id === A2 ? 'Unknown Emote' : undefined)),
      'https://7tv.io/v3/emotes/': () => json({ error: 'emote not found' }, 404),
      '/api/broken-emotes': (_url, init) => {
        reports.push(JSON.parse(String(init?.body)));
        return new Response(null, { status: 202 });
      },
      '/api/presets/': (url) => preset(url.split('/').pop()!),
    });
    renderAt('/replace?channel=niena&season=halloween');
    await userEvent.type(await openTokenField(), 'tok');
    await pickMain();
    await userEvent.click(screen.getByRole('button', { name: /create seasonal copy|apply swaps/i }));
    await screen.findByRole('heading', { name: 'Run finished' }, { timeout: 4000 });

    expect(reports).toEqual([{ season: 'halloween', originalId: A, replacementId: A2, brokenId: A2, reason: 'Unknown Emote' }]);
    const problems = screen.getByRole('region', { name: 'Problems' });
    expect(within(problems).getByText(/gone or unusable on 7TV/)).toBeInTheDocument();
    expect(within(problems).queryByRole('button', { name: 'Retry peepoHappy' })).not.toBeInTheDocument();
    await userEvent.click(within(problems).getByRole('button', { name: 'Dismiss peepoHappy' }));
    expect(screen.queryByRole('region', { name: 'Problems' })).not.toBeInTheDocument();
  });

  it('keeps problems from an earlier visit until they are dealt with', async () => {
    localStorage.setItem(
      'ser.problems',
      JSON.stringify([
        {
          id: 'P1',
          runId: 'R1',
          kind: 'refused',
          mode: 'in-place',
          season: 'halloween',
          setId: SET_ID,
          setName: 'Main',
          alias: 'a,b',
          emoteId: A2,
          normalId: A,
          pairing: { originalId: A, replacementId: A2 },
          reason: 'Invalid emote name',
          at: '2026-10-28T12:00:00.000Z',
        },
      ]),
    );
    renderAt('/replace');
    const problems = screen.getByRole('region', { name: 'Problems' });
    expect(within(problems).getByText('Main')).toBeInTheDocument();
    expect(within(problems).getByLabelText('New name for a,b')).toBeInTheDocument();
  });

  it('keeps names with umlauts and accents as they are', async () => {
    sets[SET_ID]!.emotes = [['üäöéèà', A]];
    renderAt('/replace?channel=niena&season=halloween');
    await userEvent.type(await openTokenField(), 'tok');
    await pickMain();
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Operation' }), 'in-place');
    await userEvent.click(screen.getByRole('button', { name: /create seasonal copy|apply swaps/i }));
    await screen.findByRole('heading', { name: 'Run finished' }, { timeout: 4000 });
    expect(mutations).toContainEqual({ id: SET_ID, action: 'ADD', emote_id: A2, name: 'üäöéèà' });
  });

  it('estimates the time left once a few emotes are done', async () => {
    sets[SET_ID]!.emotes = Array.from({ length: 61 }, (_, i) => [`e${i}`, emoteId(i + 10, 'E')] as [string, string]);
    renderAt('/replace?channel=niena&season=halloween');
    await userEvent.type(await openTokenField(), 'tok');
    await userEvent.click(await screen.findByRole('button', { name: /Main/ }));
    await openActions();
    await screen.findByText(/no Halloween version yet/);
    await userEvent.click(screen.getByRole('button', { name: /create seasonal copy|apply swaps/i }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/Copying · \d+\/61 · under 1 min left/), {
      timeout: 4000,
    });
  });

  it('saves the run for Undo while it is still going', async () => {
    sets[SET_ID]!.emotes = Array.from({ length: 31 }, (_, i) => [`e${i}`, emoteId(i + 10, 'E')] as [string, string]);
    renderAt('/replace?channel=niena&season=halloween');
    await userEvent.type(await openTokenField(), 'tok');
    await userEvent.click(await screen.findByRole('button', { name: /Main/ }));
    await openActions();
    await screen.findByText(/no Halloween version yet/);
    await userEvent.click(screen.getByRole('button', { name: /create seasonal copy|apply swaps/i }));
    // 30 emotes per request: halfway through, the first batch is in and the second isn't.
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/Copying · 30\/31/), { timeout: 4000 });
    expect(JSON.parse(localStorage.getItem('ser.runs')!)[0]).toMatchObject({ createdSet: true });
    await screen.findByRole('heading', { name: 'Run finished' }, { timeout: 6000 });
  });
});
