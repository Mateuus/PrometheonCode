import { LOCALE_BCP47, type Locale } from '@/i18n/config';

/**
 * Formatação sensível ao idioma.
 *
 * As datas trafegam em ISO 8601 UTC (regra do `Docs/03`) e só viram texto aqui.
 * O cálculo acontece no servidor, então servidor e cliente concordam sobre o que
 * a página diz — hidratação sem surpresa.
 */

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 24 * 60 * 60_000],
  ['month', 30 * 24 * 60 * 60_000],
  ['day', 24 * 60 * 60_000],
  ['hour', 60 * 60_000],
  ['minute', 60_000],
];

export function relativeTime(iso: string, locale: Locale, now: number = Date.now()): string {
  const target = new Date(iso).getTime();
  if (Number.isNaN(target)) {
    return iso;
  }

  const diff = target - now;
  const formatter = new Intl.RelativeTimeFormat(LOCALE_BCP47[locale], { numeric: 'auto' });

  for (const [unit, size] of UNITS) {
    if (Math.abs(diff) >= size) {
      return formatter.format(Math.round(diff / size), unit);
    }
  }
  return formatter.format(Math.round(diff / 1000), 'second');
}

export function absoluteDateTime(iso: string, locale: Locale): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return new Intl.DateTimeFormat(LOCALE_BCP47[locale], {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  }).format(date);
}

export function formatNumber(value: number, locale: Locale): string {
  return new Intl.NumberFormat(LOCALE_BCP47[locale]).format(value);
}

/** Dinheiro chega como inteiro na menor unidade (regra do `Docs/03`). */
export function formatMoney(cents: number, currency: string, locale: Locale): string {
  return new Intl.NumberFormat(LOCALE_BCP47[locale], { style: 'currency', currency }).format(
    cents / 100,
  );
}

export function formatMegabytes(value: number, locale: Locale): string {
  if (value >= 1024) {
    return `${new Intl.NumberFormat(LOCALE_BCP47[locale], { maximumFractionDigits: 1 }).format(value / 1024)} GB`;
  }
  return `${formatNumber(value, locale)} MB`;
}
