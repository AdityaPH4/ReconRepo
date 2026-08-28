/**
 * Square-off pairing.
 * Ported from `reconciliation (68).html` lines 3926–3960
 * (`toggleSquareOff`/`getSquareOffNet`).
 *
 * Pairs two unreconciled items so their diffs net to ~0 without requiring a
 * remark — used by both the Pinelabs and HDFC-UPI transaction-level buckets
 * (the only two domains with per-transaction `globalId`s). `globalId`s are
 * unique across both domains, so one map serves both.
 */

import { AMOUNT_EPSILON } from '../constants.js';
import type { ResolvableItem, SquareOffMap } from './types.js';

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

/** Net diff of an item plus every item it's paired with. `null` if `id` isn't a known item. */
export function squareOffNet(
  map: SquareOffMap,
  id: string,
  items: readonly ResolvableItem[],
): number | null {
  const byId = new Map(items.map((x) => [x.globalId, x]));
  const self = byId.get(id);
  if (!self) return null;
  return squareOffPartners(map, id).reduce((sum, partnerId) => {
    const partner = byId.get(partnerId);
    return partner ? sum + partner.diff : sum;
  }, self.diff);
}

/** A pair is only offered as partners if they carry opposite signs — mirrors legacy `mkCell`. */
export function isEligibleSquareOffPartner(a: ResolvableItem, b: ResolvableItem): boolean {
  return Math.sign(a.diff) !== 0 && Math.sign(b.diff) !== 0 && Math.sign(a.diff) !== Math.sign(b.diff);
}

/** Whether a squared-off pair is fully resolved (their combined net is within tolerance). */
export function isSquareOffResolved(
  map: SquareOffMap,
  id: string,
  items: readonly ResolvableItem[],
): boolean {
  if (!isSquaredOff(map, id)) return false;
  const net = squareOffNet(map, id, items);
  return net !== null && Math.abs(net) < AMOUNT_EPSILON;
}

/** Flattens the map to the `{from, to}` pair list the snapshot persists. */
export function squareOffPairList(map: SquareOffMap): Array<{ from: string; to: string[] }> {
  return Object.entries(map)
    .filter(([, partners]) => partners.length > 0)
    .map(([from, to]) => ({ from, to }));
}
