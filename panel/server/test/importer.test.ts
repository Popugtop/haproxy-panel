import { describe, expect, it } from 'vitest';
import { parseHandConfig } from '../src/lib/importer.js';

// Конфиг в стиле ручного: несколько use_backend … if { req_ssl_sni -i … }, комментарии, метрики и мусор рядом.
const HAND = `
global
    log /dev/log local0
    chroot /var/lib/haproxy
    stats socket /run/haproxy/admin.sock mode 660 level admin
    user haproxy
    group haproxy
    daemon

defaults
    log     global
    mode    tcp
    timeout connect 5s
    timeout client  1h
    timeout server  1h

userlist metrics_users
    user prom password $6$abc$def

# ----- учёт клиентов -----
backend st_clients
    stick-table type ipv6 size 200k expire 24h store conn_cur,conn_cnt,bytes_in_cnt,bytes_out_cnt

frontend fe_sni
    bind :443
    mode tcp
    tcp-request inspect-delay 5s
    tcp-request content accept if { req_ssl_hello_type 1 }
    tcp-request connection track-sc2 src table st_clients
    use_backend be_se if { req_ssl_sni -i se.popug.cloud }
    use_backend be_de if { req_ssl_sni -i de.popug.cloud www.de.popug.cloud }   # Германия
    use_backend be_nl if { req.ssl_sni -i NL.popug.cloud }
    use_backend be_sg if sni_sg
    acl sni_sg req_ssl_sni -i sg.popug.cloud
    acl sni_sg req_ssl_sni -i sg2.popug.cloud
    use_backend be_ee if { req_ssl_sni -m end .ee.popug.cloud }
    default_backend be_de

backend be_se
    server se1 203.0.113.11:443 check inter 10s fall 3 rise 2
backend be_de
    server de1 203.0.113.21:443 check inter 10s fall 3 rise 2 send-proxy-v2
    server de2 203.0.113.22:8443 check
backend be_nl
    server nl1 203.0.113.31:443
backend be_sg
    server sg1 [2001:db8::5]:443 check send-proxy
backend be_ee
    server ee1 203.0.113.41:443 check

backend be_unused
    server x 203.0.113.99:443

frontend fe_metrics
    mode http
    bind :9443 ssl crt /etc/haproxy/certs/metrics.pem
    http-request use-service prometheus-exporter if { path /metrics }

backend be_node_exporter
    mode http
    server node 127.0.0.1:9100
`;

describe('импорт ручного конфига', () => {
  const p = parseHandConfig(HAND);
  const by = (slug: string) => p.routes.find((r) => r.slug === slug)!;

  it('находит маршруты и SNI, в том числе через acl и req.ssl_sni', () => {
    expect(p.routes.map((r) => r.slug)).toEqual(['de', 'ee', 'nl', 'se', 'sg']);
    expect(by('se').snis).toEqual(['se.popug.cloud']);
    expect(by('de').snis).toEqual(['de.popug.cloud', 'www.de.popug.cloud']);
    expect(by('nl').snis).toEqual(['nl.popug.cloud']); // нижний регистр
    expect(by('sg').snis).toEqual(['sg.popug.cloud', 'sg2.popug.cloud']); // два acl с одним именем
  });

  it('берёт server-строки: несколько выходов, IPv6, порты и флаги', () => {
    expect(by('de').exits).toEqual([
      { serverName: 'de1', host: '203.0.113.21', port: 443 },
      { serverName: 'de2', host: '203.0.113.22', port: 8443 },
    ]);
    expect(by('sg').exits[0]).toMatchObject({ host: '2001:db8::5', port: 443 });
    expect(by('de')).toMatchObject({ proxyProtocol: true, healthCheck: true });
    expect(by('nl')).toMatchObject({ proxyProtocol: false, healthCheck: false });
  });

  it('угадывает страну по имени backend и default_backend', () => {
    expect(by('de').country).toBe('DE');
    expect(by('se').country).toBe('SE');
    expect(p.defaultBackend).toBe('be_de');
  });

  it('предупреждает о том, что не может перенести точно', () => {
    const w = p.warnings.join('\n');
    expect(w).toMatch(/-m end/); // wildcard
    expect(w).toMatch(/send-proxy \(v1\)/);
    expect(w).not.toMatch(/be_unused.*пропущен/); // он просто не используется
  });

  it('перечисляет секции, которые исчезнут при применении', () => {
    const names = p.ignoredSections.map((s) => `${s.kind}:${s.name}`);
    expect(names).toContain('userlist:metrics_users');
    expect(names).toContain('frontend:fe_metrics');
    expect(names).toContain('backend:be_node_exporter');
    expect(names).toContain('backend:be_unused');
    expect(names).not.toContain('frontend:fe_sni');
    expect(names).not.toContain('backend:be_de');
    expect(names).not.toContain('backend:st_clients');
    expect(p.ignoredSections.find((s) => s.name === 'be_unused')!.note).toMatch(/не участвует/);
  });

  it('map-файл вместо use_backend if: предупреждение, а не молчаливая потеря', () => {
    const r = parseHandConfig(`frontend fe\n    bind :443\n    use_backend %[req.ssl_sni,lower,map(/etc/haproxy/maps/sni.map)]\nbackend be_de\n    server de1 1.2.3.4:443\n`);
    expect(r.routes).toEqual([]);
    expect(r.warnings.join()).toMatch(/агент её не прислал/);
  });

  it('читает SNI из map-файла, который прислал агент', () => {
    const cfg = `frontend fe\n    bind :443\n    use_backend %[req.ssl_sni,lower,map(/etc/haproxy/sni.map,be_de)]\nbackend be_de\n    server de1 1.2.3.4:443 check\nbackend be_ee01\n    server e1 5.6.7.8:443 send-proxy-v2\n`;
    const r = parseHandConfig(cfg, [{ path: '/etc/haproxy/sni.map', content: '# комментарий\nDE.example.com be_de\nee.example.com be_ee01\nwww.ee.example.com be_ee01\n' }]);
    expect(r.routes.map((x) => [x.slug, x.snis, x.proxyProtocol])).toEqual([['de', ['de.example.com'], false], ['ee01', ['ee.example.com', 'www.ee.example.com'], true]]);
    expect(r.defaultBackend).toBe('be_de');
  });

  it('пустой и мусорный ввод не падает', () => {
    expect(parseHandConfig('').routes).toEqual([]);
    expect(parseHandConfig('это вообще не конфиг\n\x00\x01').routes).toEqual([]);
  });

  it('use_backend на несуществующий backend пропускается с предупреждением', () => {
    const r = parseHandConfig(`frontend fe\n    bind :443\n    use_backend be_xx if { req_ssl_sni -i xx.example.com }\n`);
    expect(r.routes).toEqual([]);
    expect(r.warnings.join()).toMatch(/be_xx/);
  });
});
