/** Страны для выходов: код ISO 3166-1 alpha-2 → название по-русски. Флаг строится из кода. */
export const COUNTRIES: Record<string, string> = {
  AE: 'ОАЭ', AM: 'Армения', AT: 'Австрия', AU: 'Австралия', AZ: 'Азербайджан', BE: 'Бельгия', BG: 'Болгария', BR: 'Бразилия', BY: 'Беларусь',
  CA: 'Канада', CH: 'Швейцария', CY: 'Кипр', CZ: 'Чехия', DE: 'Германия', DK: 'Дания', EE: 'Эстония', ES: 'Испания', FI: 'Финляндия',
  FR: 'Франция', GB: 'Великобритания', GE: 'Грузия', GR: 'Греция', HK: 'Гонконг', HR: 'Хорватия', HU: 'Венгрия', ID: 'Индонезия',
  IE: 'Ирландия', IL: 'Израиль', IN: 'Индия', IS: 'Исландия', IT: 'Италия', JP: 'Япония', KG: 'Киргизия', KR: 'Южная Корея',
  KZ: 'Казахстан', LT: 'Литва', LU: 'Люксембург', LV: 'Латвия', MD: 'Молдова', NL: 'Нидерланды', NO: 'Норвегия', PL: 'Польша',
  PT: 'Португалия', RO: 'Румыния', RS: 'Сербия', SE: 'Швеция', SG: 'Сингапур', SI: 'Словения', SK: 'Словакия', TH: 'Таиланд',
  TR: 'Турция', UA: 'Украина', US: 'США', UZ: 'Узбекистан', VN: 'Вьетнам', ZA: 'ЮАР',
};

export const isCountryCode = (c: string): boolean => /^[A-Z]{2}$/.test(c);

/** Флаг-эмодзи из кода страны. Для неизвестного кода — пустая строка. */
export function flag(code: string | null | undefined): string {
  if (!code || !isCountryCode(code.toUpperCase())) return '';
  return String.fromCodePoint(...[...code.toUpperCase()].map((ch) => 0x1f1a5 + ch.charCodeAt(0)));
}

export const countryName = (code: string | null | undefined): string => (code ? (COUNTRIES[code.toUpperCase()] ?? code.toUpperCase()) : '');

/** «Германия (🇷🇺 → 🇩🇪)» — имя маршрута по умолчанию. */
export function routeNameFor(code: string): string {
  return `${countryName(code)} (${flag('RU')} → ${flag(code)})`;
}
