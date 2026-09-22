/**
 * Square-off pairing.
 * Ported from `reconciliation (68).html` lines 3926–3960
 * (`toggleSquareOff`/`getSquareOffNet`).
 *
 * Pairs two unreconciled items so their diffs net to ~0 without requiring a
 * remark — used by both the Pinelabs and HDFC-UPI transaction-level buckets
 * (the only two domains with per-transaction `globalId`s). `globalId`s are
 * unique across both domains, so one map serves both.
 *
 * A pairing whose net does NOT land within `AMOUNT_EPSILON` of zero is still
 * a valid pairing (`isEligibleSquareOffPartner` only requires opposite
 * signs) — it just isn't *resolved* on its own. It becomes resolved once a
 * single remark explains the group's leftover net, attached not to either
 * member row but to the group itself via a canonical, order-independent key
 * (`squareOffGroupKey`) — computed fresh from the live pairing every time,
 * never stored, the same "derive, don't persist" discipline `squareOffNet`
 * itself already follows.
 */

import { AMOUNT_EPSILON } from '../constants.js';
import { amountsEqual } from '../util/money.js';
import type { JustificationEntry, ResolvableItem, SquareOffMap } from './types.js';

/**
 * `JustificationEntry.targetKey` prefix reserved for a square-off group's
 * residual remark — never collides with any row-level `targetKey` scheme
 * (`pos-`/`term-`/`dup-`/`amexdup-`/`amexdupterm-`/`upos-`/`ustmt-`/`udup-`,
 * or a bare RRN), since none of those can start with this prefix.
 */
export const SQUARE_OFF_GROUP_KEY_PREFIX = 'sqoff:';

export function isSquareOffGroupKey(targetKey: string | null): targetKey is string {
  return targetKey !== null && targetKey.startsWith(SQUARE_OFF_GROUP_KEY_PREFIX);
}

export function toggleSquareOff(map: SquareOffMap, a: string, b: string, on: boolean): SquareOffMap {
  const next: SquareOffMap = { ...map };
  const partnersOf = (id: string) => next[id] ?? [];

  if (on) {
    next[a] = partnersOf(a).includes(b) ? partnersOf(a) : [...partnersOf(a), b];
    next[b] = partnersOf(b).includes(a) ? partnersOf(b) : [...partnersOf(b), a];
  } else {
    next[a] = partnersOf(a).filter((x) => x !== b);
    next[b] = partnersOf(b).filter((x) => x !== a);
  }
  return next;
}

export function squareOffPartners(map: SquareOffMap, id: string): string[] {
  return map[id] ?? [];
}

export function isSquaredOff(map: SquareOffMap, id: string): boolean {
  return squareOffPartners(map, id).length > 0;
}

/**
 * Every id reachable from `id` through the square-off graph, `id` included.
 * Sequential pairwise toggles that share a row build a star (hub lists every
 * partner, each partner only lists the hub) rather than a fully-connected
 * clique — the group is still one logical unit, so resolution has to walk
 * the whole connected component, not just `id`'s own direct entry.
 */
export function squareOffComponent(map: SquareOffMap, id: string): string[] {
  const seen = new Set<string>([id]);
  const queue = [id];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const next of map[cur] ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return [...seen];
}

/** Net diff of an item plus every item in its square-off group. `null` if `id` isn't a known item. */
export function squareOffNet(
  map: SquareOffMap,
  id: string,
  items: readonly ResolvableItem[],
): number | null {
  const byId = new Map(items.map((x) => [x.globalId, x]));
  if (!byId.has(id)) return null;
  return squareOffComponent(map, id).reduce((sum, memberId) => {
    const member = byId.get(memberId);
    return member ? sum + member.diff : sum;
  }, 0);
}

/** A pair is only offered as partners if they carry opposite signs — mirrors legacy `mkCell`. */
export function isEligibleSquareOffPartner(a: ResolvableItem, b: ResolvableItem): boolean {
  return Math.sign(a.diff) !== 0 && Math.sign(b.diff) !== 0 && Math.sign(a.diff) !== Math.sign(b.diff);
}

/**
 * Canonical, order-independent key for `id`'s current square-off group —
 * `sqoff:` plus every member's `globalId`, sorted. `null` if `id` isn't
 * squared off at all. Two ids in the same group always produce the same
 * key; the key changes the moment the group's membership does, which is
 * exactly what makes a stored residual remark detectably stale after a
 * later re-pairing (see `justificationService.ts`'s `setSquareOff`).
 */
export function squareOffGroupKey(map: SquareOffMap, id: string): string | null {
  if (!isSquaredOff(map, id)) return null;
  return SQUARE_OFF_GROUP_KEY_PREFIX + squareOffComponent(map, id).sort().join(',');
}

/**
 * Re-derives a group's net from a *stored* `targetKey`, after confirming the
 * key still matches the group's current membership. `null` for a stale key
 * (the group changed since the entry was created) or a malformed one — same
 * "null means not resolvable" contract as `squareOffNet`.
 */
export function squareOffNetByGroupKey(
  map: SquareOffMap,
  targetKey: string,
  items: readonly ResolvableItem[],
): number | null {
  if (!isSquareOffGroupKey(targetKey)) return null;
  const firstId = targetKey.slice(SQUARE_OFF_GROUP_KEY_PREFIX.length).split(',')[0];
  if (!firstId || squareOffGroupKey(map, firstId) !== targetKey) return null;
  return squareOffNet(map, firstId, items);
}

/**
 * Whether a squared-off pair is fully resolved: either their combined net is
 * within tolerance on its own, or a residual entry (a normal
 * `JustificationEntry` keyed by `squareOffGroupKey`) explains exactly the
 * leftover. Callers pass the full session entry list — same as any other
 * completeness check — not just this source's own subset, since a group's
 * residual entry is looked up by its group key, not by source.
 */
export function isSquareOffResolved(
  map: SquareOffMap,
  id: string,
  items: readonly ResolvableItem[],
  entries: readonly JustificationEntry[],
): boolean {
  if (!isSquaredOff(map, id)) return false;
  const net = squareOffNet(map, id, items);
  if (net === null) return false;
  if (Math.abs(net) < AMOUNT_EPSILON) return true;
  const key = squareOffGroupKey(map, id);
  const residual = key ? entries.find((e) => e.targetKey === key) : undefined;
  if (!residual) return false;
  const signed = residual.direction === 'excess' ? residual.amount : -residual.amount;
  return amountsEqual(net, signed);
}

/** Flattens the map to the `{from, to}` pair list the snapshot persists. */
export function squareOffPairList(map: SquareOffMap): Array<{ from: string; to: string[] }> {
  return Object.entries(map)
    .filter(([, partners]) => partners.length > 0)
    .map(([from, to]) => ({ from, to }));
}
