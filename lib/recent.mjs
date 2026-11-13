// Recent activity: the newest push or merged PR per repo, from the public
// events API. The API only reaches back ~90 days / 300 events, so the result
// is merged with the last known list in data/recent.json.

const API = 'https://api.github.com';

async function gh(path, token) {
  const res = await fetch(API + path, {
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': 'profile-readme-generator',
      'x-github-api-version': '2022-11-28',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status} for ${path}`);
  return res.json();
}

async function toEntry(ev, token) {
  const repo = ev.repo?.name;
  if (!repo) return null;
  if (ev.type === 'PushEvent') {
    const sha = ev.payload?.head;
    if (!sha || /^0+$/.test(sha)) return null;
    return { repo, kind: 'push', ref: sha.slice(0, 7), url: `https://github.com/${repo}/commit/${sha}`, at: ev.created_at };
  }
  if (ev.type === 'PullRequestEvent') {
    const pr = ev.payload?.pull_request;
    const action = ev.payload?.action;
    const number = pr?.number ?? ev.payload?.number;
    if (!number || (action !== 'closed' && action !== 'merged')) return null;
    let merged = action === 'merged' || pr?.merged;
    if (merged === undefined) {
      // Newer event payloads leave `merged` out: ask the PR itself.
      try {
        merged = Boolean((await gh(`/repos/${repo}/pulls/${number}`, token)).merged_at);
      } catch {
        merged = false;
      }
    }
    if (!merged) return null;
    return { repo, kind: 'pr', ref: `#${number}`, url: `https://github.com/${repo}/pull/${number}`, at: ev.created_at };
  }
  return null;
}

// Newest entry per repo, newest first.
export function distinct(entries, count) {
  const seen = new Set();
  return [...entries]
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
    .filter((e) => !seen.has(e.repo.toLowerCase()) && seen.add(e.repo.toLowerCase()))
    .slice(0, count);
}

export async function fetchRecent({ user, token, exclude = [], count = 3 }) {
  const skip = new Set(exclude.map((r) => r.toLowerCase()));
  const entries = [];
  for (let page = 1; page <= 3; page++) {
    const events = await gh(`/users/${user}/events/public?per_page=100&page=${page}`, token);
    // Events do not arrive in strict time order, so sort before looking at them.
    events.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    const seen = new Set();
    for (const ev of events) {
      if (skip.has(ev.repo?.name?.toLowerCase()) || seen.has(ev.repo?.name)) continue;
      const entry = await toEntry(ev, token);
      if (entry) {
        entries.push(entry);
        seen.add(entry.repo);
      }
    }
    if (events.length < 100 || distinct(entries, count).length >= count) break;
  }
  return distinct(entries, count);
}

export function mergeRecent(fetched, stored, count) {
  return distinct([...(fetched ?? []), ...(stored ?? [])], count);
}

// Owner only when it is not me.
export function displayRepo(repo, user) {
  const [owner, name] = repo.split('/');
  return owner.toLowerCase() === user.toLowerCase() ? name : repo;
}
