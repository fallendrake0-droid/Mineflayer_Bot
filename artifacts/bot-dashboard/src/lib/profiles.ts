/** Saved server connection profiles, stored in localStorage. */

export interface ServerProfile {
  id: string;
  host: string;
  port: number;
  username: string;
  version: string;
  owner?: string;
  lastUsedAt: number;
}

const KEY = "minecontrol:profiles:v1";

export function loadProfiles(): ServerProfile[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as ServerProfile[];
    return Array.isArray(parsed)
      ? parsed.sort((a, b) => b.lastUsedAt - a.lastUsedAt)
      : [];
  } catch {
    return [];
  }
}

function save(profiles: ServerProfile[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(profiles.slice(0, 12)));
  } catch {
    // storage unavailable (private mode) — profiles are a convenience only
  }
}

export function upsertProfile(
  input: Omit<ServerProfile, "id" | "lastUsedAt">,
): ServerProfile[] {
  const profiles = loadProfiles();
  const id = `${input.username.toLowerCase()}@${input.host.toLowerCase()}:${input.port}`;
  const next = profiles.filter((p) => p.id !== id);
  next.unshift({ ...input, id, lastUsedAt: Date.now() });
  save(next);
  return next;
}

export function removeProfile(id: string): ServerProfile[] {
  const next = loadProfiles().filter((p) => p.id !== id);
  save(next);
  return next;
}
