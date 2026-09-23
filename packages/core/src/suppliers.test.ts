import { describe, expect, it } from 'vitest';
import { parseAmountText } from './money.js';
import {
  SUPPLIER_CSV_COLUMNS,
  SUPPLIER_SAMPLE_NAME,
  parseCsv,
  supplierCsvTemplate,
  suppliersToCsv,
  validateSupplierCsv,
} from './suppliers.js';

/**
 * ARB-200 acceptance: "CSV template downloadable; import validates every row with
 * line-numbered errors". The template is the first test; every error carries the line
 * it came from; nothing is returned for import unless every line is right.
 */
const CATEGORIES = new Set(['wordpress', 'shopify', 'seo']);
const HEADING = SUPPLIER_CSV_COLUMNS.join(',');

describe('parseAmountText', () => {
  it('reads amounts as text into minor units, with hand-worked values', () => {
    // R1 500,00 is 150 000 cents; 1500.5 is 150 050; 1,500 is 150 000; 12 is 1 200.
    expect(parseAmountText('1 500,00', 'ZAR')).toBe('150000');
    expect(parseAmountText('1500.5', 'ZAR')).toBe('150050');
    expect(parseAmountText('1,500', 'ZAR')).toBe('150000');
    expect(parseAmountText('R 12', 'ZAR')).toBe('1200');
    expect(parseAmountText('1.234.567,89', 'EUR')).toBe('123456789');
    // Yen has no minor unit: 1500 is 1 500.
    expect(parseAmountText('1500', 'JPY')).toBe('1500');
    expect(parseAmountText('1500.5', 'JPY')).toBeNull();
    expect(parseAmountText('abc', 'ZAR')).toBeNull();
    expect(parseAmountText('1.2.3', 'ZAR')).toBeNull();
    expect(parseAmountText('', 'ZAR')).toBeNull();
  });
});

describe('parseCsv', () => {
  it('reads quoted commas, doubled quotes, line breaks inside a field, and both line endings', () => {
    const parsed = parseCsv('a,b\r\n"x, y","say ""hi""\nthere"\n1,2');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.records).toEqual([
      { line: 1, fields: ['a', 'b'] },
      { line: 2, fields: ['x, y', 'say "hi"\nthere'] },
      { line: 4, fields: ['1', '2'] },
    ]);
  });

  it('names the line of a quote that never closes', () => {
    const parsed = parseCsv('a,b\n"open,1\n');
    expect(parsed).toEqual({
      ok: false,
      error: { line: 2, field: '', message: 'a quoted field is never closed' },
    });
  });
});

describe('the template', () => {
  it('has exactly the columns the import expects and one sample line the import refuses', () => {
    const template = supplierCsvTemplate();
    const parsed = parseCsv(template);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.records[0]?.fields).toEqual([...SUPPLIER_CSV_COLUMNS]);
    expect(parsed.records).toHaveLength(2);
    expect(parsed.records[1]?.fields[0]).toBe(SUPPLIER_SAMPLE_NAME);
    const result = validateSupplierCsv(template, { categories: CATEGORIES });
    expect(result).toEqual({
      ok: false,
      errors: [
        {
          line: 2,
          field: 'name',
          message: 'is the sample line from the template; replace it with a real supplier',
        },
      ],
    });
  });
});

describe('validateSupplierCsv', () => {
  it('reads a good file into suppliers with their rate cards, amounts as minor units', () => {
    const csv = [
      HEADING,
      'Thandi Web,ZA,Africa/Johannesburg,direct,en;zu,85,0.95,yes,https://example.com/thandi,"Fast, careful",yes,wordpress,ZAR,"1 500,00",,5',
      'Thandi Web,ZA,Africa/Johannesburg,direct,en;zu,85,0.95,yes,https://example.com/thandi,"Fast, careful",yes,seo,ZAR,,350.5,',
      'Studio Nord,NO,Europe/Oslo,upwork,en,,,no,,,no,,,,,',
    ].join('\n');
    const result = validateSupplierCsv(csv, { categories: CATEGORIES });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lines).toBe(3);
    expect(result.value).toHaveLength(2);
    expect(result.value[0]).toMatchObject({
      name: 'Thandi Web',
      countryCode: 'ZA',
      timeZone: 'Africa/Johannesburg',
      channel: 'direct',
      languages: ['en', 'zu'],
      qualityScore: '85.00',
      onTimeRate: '0.950',
      paysAfterDelivery: true,
      notes: 'Fast, careful',
      active: true,
      line: 2,
    });
    // Hand-worked: R1 500,00 is 150 000 cents; R350,50 an hour is 35 050 cents.
    expect(result.value[0]?.rateCards).toEqual([
      {
        categorySlug: 'wordpress',
        currency: 'ZAR',
        fixedPriceMinor: '150000',
        hourlyRateMinor: null,
        turnaroundDays: 5,
        line: 2,
      },
      {
        categorySlug: 'seo',
        currency: 'ZAR',
        fixedPriceMinor: null,
        hourlyRateMinor: '35050',
        turnaroundDays: null,
        line: 3,
      },
    ]);
    expect(result.value[1]).toMatchObject({
      name: 'Studio Nord',
      channel: 'upwork',
      paysAfterDelivery: false,
      active: false,
      qualityScore: null,
      rateCards: [],
      line: 4,
    });
  });

  it('reports every problem with its line number and returns nothing to import', () => {
    const csv = [
      HEADING,
      'Good One,ZA,,direct,,,,yes,,,yes,wordpress,ZAR,100,,',
      ',ZA,,direct,,,,yes,,,yes,,,,,',
      'Bad Channel,ZAF,Mars/Olympus,telepathy,,101,1.5,maybe,ftp://x,,perhaps,,,,,',
      'Bad Card,,,fiverr,,,,no,,,yes,plumbing,ZA,abc,,1.5',
      'Bad Card,,,fiverr,,,,no,,,yes,shopify,ZAR,,,',
      'Good One,ZA,,upwork,,,,yes,,,yes,wordpress,ZAR,200,,',
      'Short line,ZA',
    ].join('\r\n');
    const result = validateSupplierCsv(csv, { categories: CATEGORIES });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const byLine = (line: number) => result.errors.filter((e) => e.line === line);
    expect(byLine(2)).toEqual([]);
    expect(byLine(3)).toEqual([{ line: 3, field: 'name', message: 'must not be empty' }]);
    expect(byLine(4).map((e) => e.field)).toEqual([
      'country_code',
      'time_zone',
      'channel',
      'quality_score',
      'on_time_rate',
      'pays_after_delivery',
      'active',
      'external_profile_url',
    ]);
    expect(byLine(5).map((e) => [e.field, e.message])).toEqual([
      ['category_slug', 'is not a service category'],
      ['currency', 'must be a three-letter currency code such as ZAR'],
      ['fixed_price', 'must be an amount such as 1500.00'],
      ['turnaround_days', 'must be a whole number of days'],
    ]);
    expect(byLine(6)).toEqual([
      {
        line: 6,
        field: 'fixed_price',
        message: 'a rate card needs a fixed price or an hourly rate',
      },
    ]);
    expect(byLine(7).map((e) => e.message)).toEqual([
      'repeats the wordpress ZAR rate card from line 2',
      "describes Good One differently from line 2; a supplier's own fields must match on every line",
    ]);
    expect(byLine(8)).toEqual([{ line: 8, field: '', message: 'has 2 fields, not 16' }]);
    expect(result.errors).toHaveLength(1 + 8 + 4 + 1 + 2 + 1);
  });

  it('refuses a wrong heading, an empty file and a heading with no lines, each on line 1', () => {
    expect(validateSupplierCsv('', { categories: CATEGORIES })).toEqual({
      ok: false,
      errors: [{ line: 1, field: '', message: 'the file is empty' }],
    });
    expect(validateSupplierCsv(`${HEADING}\n`, { categories: CATEGORIES })).toEqual({
      ok: false,
      errors: [{ line: 1, field: '', message: 'the file has a heading and no supplier lines' }],
    });
    const wrong = validateSupplierCsv('name,channel,rate\nx,direct,1', { categories: CATEGORIES });
    expect(wrong.ok).toBe(false);
    if (wrong.ok) return;
    expect(wrong.errors[0]?.line).toBe(1);
    expect(wrong.errors[0]?.message).toContain('unexpected rate');
    expect(wrong.errors[0]?.message).toContain('missing country_code');
  });

  it('a supplier with a card and a line without one for the same name is one supplier', () => {
    const csv = [
      HEADING,
      'Solo,ZA,,direct,,,,no,,,yes,,,,,',
      'Solo,ZA,,direct,,,,no,,,yes,shopify,USD,"2,000.00",,10',
    ].join('\n');
    const result = validateSupplierCsv(csv, { categories: CATEGORIES });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(1);
    // Hand-worked: USD 2,000.00 is 200 000 cents.
    expect(result.value[0]?.rateCards).toEqual([
      {
        categorySlug: 'shopify',
        currency: 'USD',
        fixedPriceMinor: '200000',
        hourlyRateMinor: null,
        turnaroundDays: 10,
        line: 3,
      },
    ]);
  });
});

describe('suppliersToCsv', () => {
  it('exports the same columns, one line per rate card, and imports back unchanged', () => {
    const csv = suppliersToCsv([
      {
        name: 'Thandi Web',
        countryCode: 'ZA',
        timeZone: 'Africa/Johannesburg',
        channel: 'direct',
        languages: ['en', 'zu'],
        qualityScore: '85.00',
        onTimeRate: '0.950',
        paysAfterDelivery: true,
        externalProfileUrl: null,
        notes: '=SUM(A1)',
        active: true,
        rateCards: [
          {
            categorySlug: 'wordpress',
            currency: 'ZAR',
            fixedPriceMinor: '150000',
            hourlyRateMinor: null,
            turnaroundDays: 5,
          },
          {
            categorySlug: 'seo',
            currency: 'ZAR',
            fixedPriceMinor: null,
            hourlyRateMinor: '35050',
            turnaroundDays: null,
          },
        ],
      },
      {
        name: 'Studio Nord',
        countryCode: null,
        timeZone: null,
        channel: 'upwork',
        languages: [],
        qualityScore: null,
        onTimeRate: null,
        paysAfterDelivery: false,
        externalProfileUrl: null,
        notes: null,
        active: false,
        rateCards: [],
      },
    ]);
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe(HEADING);
    expect(lines[1]).toBe(
      "Thandi Web,ZA,Africa/Johannesburg,direct,en;zu,85.00,0.950,yes,,'=SUM(A1),yes,wordpress,ZAR,1500.00,,5",
    );
    expect(lines[2]).toBe(
      "Thandi Web,ZA,Africa/Johannesburg,direct,en;zu,85.00,0.950,yes,,'=SUM(A1),yes,seo,ZAR,,350.50,",
    );
    expect(lines[3]).toBe('Studio Nord,,,upwork,,,,no,,,no,,,,,');
    expect(lines[4]).toBe('');
    const back = validateSupplierCsv(csv, { categories: CATEGORIES });
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.value[0]?.rateCards.map((c) => c.fixedPriceMinor ?? c.hourlyRateMinor)).toEqual([
      '150000',
      '35050',
    ]);
    expect(back.value[1]?.rateCards).toEqual([]);
  });
});
