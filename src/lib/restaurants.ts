import type { CollectionEntry } from 'astro:content';
import { tiers } from './taxonomy';

type Restaurant = CollectionEntry<'restaurants'>;

const tierOrder = (id: string) => tiers.find((t) => t.id === id)?.order ?? 99;

/** 列表共用排序：分級 → 有封面照 → 最近複核日期 */
export function sortRestaurants(list: Restaurant[]): Restaurant[] {
  return list.slice().sort((a, b) => {
    const t = tierOrder(a.data.tierId) - tierOrder(b.data.tierId);
    if (t !== 0) return t;
    const p = Number(Boolean(b.data.coverImage)) - Number(Boolean(a.data.coverImage));
    if (p !== 0) return p;
    return (b.data.lastReviewedAt ?? '').localeCompare(a.data.lastReviewedAt ?? '');
  });
}
