import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { forbiddenDirectives, renderConfig, type RenderInput, type RenderRoute } from '../src/lib/render.js';

const route = (over: Partial<RenderRoute> & { slug: string }): RenderRoute => ({
  name: over.slug,
  snis: [],
  proxyProtocol: false,
  healthCheck: true,
  enabled: true,
  exits: [{ host: '198.51.100.10', port: 443 }],
  ...over,
});

const CASES: Record<string, RenderInput> = {
  'empty-node': { routes: [] },
  'three-routes': {
    routes: [
      route({ slug: 'se', name: 'Швеция (🇷🇺 → 🇸🇪)', snis: ['se.popug.cloud'], exits: [{ host: '203.0.113.11', port: 443 }] }),
      route({ slug: 'de', name: 'Германия (🇷🇺 → 🇩🇪)', snis: ['de.popug.cloud', 'www.de.popug.cloud'], exits: [{ host: '203.0.113.21', port: 443 }, { host: '203.0.113.22', port: 8443 }] }),
      route({ slug: 'nl', name: 'Нидерланды (🇷🇺 → 🇳🇱)', snis: ['nl.popug.cloud'], exits: [{ host: '203.0.113.31', port: 443 }] }),
    ],
  },
  'flags-and-disabled': {
    routes: [
      route({ slug: 'sg', name: 'Сингапур (🇷🇺 → 🇸🇬)', snis: ['sg.popug.cloud'], proxyProtocol: true, healthCheck: false, exits: [{ host: '2001:db8::5', port: 443 }] }),
      route({ slug: 'cz', name: 'Чехия', snis: ['cz.popug.cloud'], proxyProtocol: true, exits: [{ host: 'exit-cz.example.net', port: 443 }] }),
      route({ slug: 'ee', name: 'Эстония (выключен)', snis: ['ee.popug.cloud'], enabled: false }),
    ],
  },
  'bwlim-default-and-personal': {
    routes: [route({ slug: 'de', name: 'Германия', snis: ['de.popug.cloud'] })],
    bwlim: { defaultMbit: 100, limits: [{ ip: '198.51.100.9', mbit: 10 }, { ip: '198.51.100.7', mbit: 50 }, { ip: '2001:db8::5', mbit: 5 }] },
  },
  'bwlim-personal-only': {
    routes: [route({ slug: 'de', name: 'Германия', snis: ['de.popug.cloud'] })],
    bwlim: { defaultMbit: null, limits: [{ ip: '198.51.100.7', mbit: 25 }] },
  },
  'bwlim-route-cap-only': {
    routes: [route({ slug: 'de', name: 'Германия', snis: ['de.popug.cloud'], limitMbit: 8 }), route({ slug: 'se', name: 'Швеция', snis: ['se.popug.cloud'] })],
    bwlim: { defaultMbit: null, limits: [] },
  },
  'bwlim-route-ip-override': {
    routes: [
      route({ slug: 'de', name: 'Германия', snis: ['de.popug.cloud'], ipLimitMbit: 4 }),
      route({ slug: 'nl', name: 'Нидерланды', snis: ['nl.popug.cloud'], ipLimitMbit: 4, limitMbit: 200 }),
      route({ slug: 'se', name: 'Швеция', snis: ['se.popug.cloud'], ipLimitMbit: 20 }),
      route({ slug: 'cz', name: 'Чехия', snis: ['cz.popug.cloud'] }),
    ],
    bwlim: { defaultMbit: 40, limits: [{ ip: '198.51.100.9', mbit: 10 }] },
  },
  'default-route-and-extra': {
    routes: [route({ slug: 'de', name: 'Германия', snis: ['DE.Popug.Cloud'] }), route({ slug: 'nl', name: 'Нидерланды\nс переводом строки', snis: ['nl.popug.cloud'] })],
    defaultSlug: 'de',
    extraConfig: '\nlisten stats\n    bind 127.0.0.1:8404\n    mode http\n    stats enable\n',
  },
};

const golden = (name: string, ext: string) => join(import.meta.dirname, 'golden', `${name}.${ext}`);
const update = process.env.UPDATE_GOLDEN === '1';

describe('golden: рендер haproxy.cfg', () => {
  for (const [name, input] of Object.entries(CASES)) {
    it(name, () => {
      const r = renderConfig(input);
      if (update || !existsSync(golden(name, 'cfg'))) {
        writeFileSync(golden(name, 'cfg'), r.cfg);
        writeFileSync(golden(name, 'map'), r.sniMap);
      }
      expect(r.cfg).toBe(readFileSync(golden(name, 'cfg'), 'utf8'));
      expect(r.sniMap).toBe(readFileSync(golden(name, 'map'), 'utf8'));
    });
  }

  it('bwlim: нет лимитов — в конфиге нет следов; уровни группируются, у общего лимита исключения для персональных', () => {
    const plain = renderConfig(CASES['three-routes']!);
    expect(plain.cfg).not.toContain('bwlim');
    expect(plain.cfg).not.toContain('st_bwlim');
    expect(renderConfig({ routes: [], bwlim: { defaultMbit: null, limits: [] } }).cfg).not.toContain('bwlim');

    const r = renderConfig(CASES['bwlim-default-and-personal']!).cfg;
    expect(r).toContain('filter bwlim-out dl_default limit 12500000 key src table st_bwlim'); // 100 Мбит/с = 12 500 000 байт/с
    expect(r).toContain('filter bwlim-out dl_5m limit 625000 key src table st_bwlim');
    expect(r).toContain('tcp-request content set-bandwidth-limit dl_10m if { src 198.51.100.9 }');
    expect(r).toContain('tcp-request content set-bandwidth-limit dl_default unless { src 198.51.100.7 198.51.100.9 2001:db8::5 }');

    const only = renderConfig(CASES['bwlim-personal-only']!).cfg;
    expect(only).not.toContain('dl_default'); // общего лимита нет — персональные не нужно ни от чего исключать
    expect(only).toContain('set-bandwidth-limit dl_25m if { src 198.51.100.7 }');

    expect(() => renderConfig({ routes: [], bwlim: { defaultMbit: 1, limits: [{ ip: 'x; evil', mbit: 5 }] } })).toThrow(/IP лимита/);
    expect(() => renderConfig({ routes: [], bwlim: { defaultMbit: 1, limits: [{ ip: '1.2.3.4', mbit: 0 }] } })).toThrow(/лимит/);
  });

  it('рендер детерминирован: порядок маршрутов на входе не влияет', () => {
    const input = CASES['three-routes']!;
    const a = renderConfig(input);
    const b = renderConfig({ ...input, routes: [...input.routes].reverse() });
    expect(b).toEqual(a);
  });

  it('карта SNI: нижний регистр, сортировка, неизвестный SNI → reject', () => {
    const r = renderConfig(CASES['default-route-and-extra']!);
    expect(r.sniMap).toBe('de.popug.cloud be_de\nnl.popug.cloud be_nl\n');
    expect(renderConfig(CASES['three-routes']!).cfg).toContain('default_backend be_reject');
    expect(r.cfg).toContain('default_backend be_de');
  });

  it('выключенный маршрут и маршрут без выходов не попадают ни в конфиг, ни в карту', () => {
    const r = renderConfig({ routes: [route({ slug: 'ee', snis: ['ee.example.com'], enabled: false }), route({ slug: 'xx', snis: ['xx.example.com'], exits: [] })] });
    expect(r.cfg).not.toContain('be_ee');
    expect(r.cfg).not.toContain('be_xx');
    expect(r.sniMap).toBe('');
  });

  it('лимиты маршрутов: потолок маршрута, лимит на IP и приоритеты', () => {
    const r = renderConfig(CASES['bwlim-route-ip-override']!).cfg;
    // потолок маршрута: отдельная таблица по строковому ключу, лимит общий для всех клиентов маршрута
    expect(r).toContain('backend st_route_bw');
    expect(r).toContain('filter bwlim-out route_dl_nl limit 25000000 key str(be_nl) table st_route_bw');
    expect(r).toContain('set-bandwidth-limit route_dl_nl if { req.ssl_sni,lower,map(/etc/haproxy/maps/sni.map) -m str be_nl }');
    // лимит на IP внутри маршрута: маршруты с одинаковым значением делят фильтр
    expect(r).toContain('set-bandwidth-limit dl_r4m if { req.ssl_sni,lower,map(/etc/haproxy/maps/sni.map) -m str be_de be_nl } !{ src 198.51.100.9 }');
    // лимит ноды по умолчанию не действует там, где есть личный и маршрутный; личный сильнее всех
    expect(r).toContain('set-bandwidth-limit dl_default if !{ req.ssl_sni,lower,map(/etc/haproxy/maps/sni.map) -m str be_de be_nl be_se } !{ src 198.51.100.9 }');
    expect(r.indexOf('set-bandwidth-limit')).toBeLessThan(r.indexOf('tcp-request content accept'));
  });

  it('лимиты маршрутов без bwlim (HAProxy < 2.7) молча гасятся', () => {
    const withLimits = renderConfig({ routes: [route({ slug: 'de', snis: ['de.example.com'], limitMbit: 8, ipLimitMbit: 4 })], bwlim: null });
    const plain = renderConfig({ routes: [route({ slug: 'de', snis: ['de.example.com'] })] });
    expect(withLimits.cfg).toBe(plain.cfg);
  });

  it('некорректный лимит маршрута — ошибка', () => {
    expect(() => renderConfig({ routes: [route({ slug: 'de', snis: ['de.example.com'], limitMbit: 0 })], bwlim: { defaultMbit: null, limits: [] } })).not.toThrow(); // 0 = «нет лимита»
    expect(() => renderConfig({ routes: [route({ slug: 'de', snis: ['de.example.com'], limitMbit: 1.5 })], bwlim: { defaultMbit: null, limits: [] } })).toThrow(/лимит/);
    expect(() => renderConfig({ routes: [route({ slug: 'de', snis: ['de.example.com'], ipLimitMbit: 100001 })], bwlim: { defaultMbit: null, limits: [] } })).toThrow(/лимит/);
  });

  it('один SNI в двух маршрутах — ошибка, а не молчаливый выбор', () => {
    expect(() => renderConfig({ routes: [route({ slug: 'a', snis: ['x.example.com'] }), route({ slug: 'b', snis: ['X.example.com'] })] })).toThrow(/сразу в маршрутах/);
  });

  it('мусор в идентификаторах и адресах не доходит до конфига', () => {
    expect(() => renderConfig({ routes: [route({ slug: 'de\nserver evil 1.1.1.1:1' })] })).toThrow();
    expect(() => renderConfig({ routes: [route({ slug: 'de', snis: ['a b.example.com'] })] })).toThrow(/SNI/);
    expect(() => renderConfig({ routes: [route({ slug: 'de', exits: [{ host: '1.2.3.4 check', port: 443 }] })] })).toThrow(/выход/);
    expect(() => renderConfig({ routes: [route({ slug: 'de', exits: [{ host: '1.2.3.4', port: 70000 }] })] })).toThrow(/выход/);
  });

  it('хеш меняется при изменении карты, даже если cfg тот же', () => {
    const a = renderConfig({ routes: [route({ slug: 'de', snis: ['a.example.com'] })] });
    const b = renderConfig({ routes: [route({ slug: 'de', snis: ['b.example.com'] })] });
    expect(a.sha256).not.toBe(b.sha256);
  });
});

describe('политика директив — общая с агентом', () => {
  const policy = JSON.parse(readFileSync(join(import.meta.dirname, '../../../protocol/fixtures/config_policy.json'), 'utf8')) as { bad: string[]; ok: string[] };
  it('запрещённое запрещено, разрешённое разрешено', () => {
    for (const c of policy.bad) expect(forbiddenDirectives(c).length, JSON.stringify(c)).toBeGreaterThan(0);
    for (const c of policy.ok) expect(forbiddenDirectives(c), JSON.stringify(c)).toEqual([]);
  });
});

// ───────── haproxy -c в Docker-образе haproxy:2.8 ─────────
const dockerOk = (() => {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
})();
if (!dockerOk && process.env.REQUIRE_DOCKER === '1') throw new Error('REQUIRE_DOCKER=1, но Docker недоступен');

describe.skipIf(!dockerOk)('каждый сгенерированный конфиг проходит haproxy -c (haproxy:2.8)', () => {
  for (const [name, input] of Object.entries(CASES)) {
    it(name, () => {
      const r = renderConfig(input);
      const dir = mkdtempSync(join(tmpdir(), 'popug-hap-'));
      mkdirSync(join(dir, 'maps'));
      writeFileSync(join(dir, 'haproxy.cfg'), r.cfg);
      writeFileSync(join(dir, 'maps', 'sni.map'), r.sniMap);
      const p = spawnSync(
        'docker',
        ['run', '--rm', '-v', `${dir}/haproxy.cfg:/tmp/haproxy.cfg:ro`, '-v', `${dir}/maps:/etc/haproxy/maps:ro`, 'haproxy:2.8', 'haproxy', '-c', '-f', '/tmp/haproxy.cfg'],
        { encoding: 'utf8', timeout: 120_000 },
      );
      expect(p.status, `${p.stdout}\n${p.stderr}`).toBe(0);
      expect(`${p.stdout}${p.stderr}`).toMatch(/Configuration file is valid/);
    }, 130_000);
  }

  it('проверка не «пропускает всё»: сломанный конфиг отклоняется', () => {
    const dir = mkdtempSync(join(tmpdir(), 'popug-hap-'));
    writeFileSync(join(dir, 'haproxy.cfg'), 'global\n    foo bar\n');
    const p = spawnSync('docker', ['run', '--rm', '-v', `${dir}/haproxy.cfg:/tmp/haproxy.cfg:ro`, 'haproxy:2.8', 'haproxy', '-c', '-f', '/tmp/haproxy.cfg'], { encoding: 'utf8', timeout: 120_000 });
    expect(p.status).not.toBe(0);
  }, 130_000);
});
