import regionsData from '../content/taxonomy/regions.json';
import categoriesData from '../content/taxonomy/categories.json';
import tiersData from '../content/taxonomy/tiers.json';

export type Region = (typeof regionsData.regions)[number];
export type Category = (typeof categoriesData.categories)[number];
export type Tier = (typeof tiersData.tiers)[number];

export const regions: Region[] = regionsData.regions;
export const categories: Category[] = categoriesData.categories;
export const tiers: Tier[] = tiersData.tiers;

export const popularRegions = regions.filter((r) => r.popular);
export const homeCategories = categories.filter((c) => c.showOnHome);
export const moreCategories = categories.filter((c) => !c.showOnHome);

export function getRegion(id: string) {
  return regions.find((r) => r.id === id);
}

export function getCategory(id: string) {
  return categories.find((c) => c.id === id);
}

export function getTier(id: string) {
  return tiers.find((t) => t.id === id);
}

// 分級色票對應 CDS 語意 token，供 TierBadge 元件使用
export const tierColorTokens: Record<string, { bg: string; text: string; border?: string }> = {
  danger: { bg: 'var(--bg-danger)', text: 'var(--text-danger)' },
  warning: { bg: 'var(--bg-warning)', text: 'var(--text-warning)' },
  neutral: { bg: 'var(--surface-1)', text: 'var(--text-secondary)', border: 'var(--border)' },
  muted: { bg: 'var(--surface-0)', text: 'var(--text-muted)', border: 'var(--border)' },
};
