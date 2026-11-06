import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AgentMessageSchema,
  ApplyResultSchema,
  ChecksConfigSchema,
  CmdSchema,
  ConfigDataSchema,
  EnrollResponseSchema,
  PanelMessageSchema,
  PROTOCOL_VERSION,
  WelcomeSchema,
} from '../src/index.js';

const dir = join(import.meta.dirname, '../fixtures');
const fx = (n: string) => JSON.parse(readFileSync(join(dir, n), 'utf8'));

describe('фикстуры протокола', () => {
  it('hello / metrics / result проходят AgentMessageSchema', () => {
    for (const n of ['hello.json', 'metrics.json', 'result_get_config.json', 'checks.json', 'result_apply_config.json']) {
      const r = AgentMessageSchema.safeParse(fx(n));
      expect(r.success, n).toBe(true);
    }
  });

  it('welcome и cmd проходят PanelMessageSchema', () => {
    expect(PanelMessageSchema.safeParse(fx('welcome.json')).success).toBe(true);
    expect(PanelMessageSchema.safeParse(fx('cmd_get_config.json')).success).toBe(true);
    for (const n of ['cmd_apply_config.json', 'cmd_apply_bans.json', 'cmd_get_clients.json', 'cmd_update_agent.json', 'cmd_run_checks.json', 'checks_config.json']) expect(PanelMessageSchema.safeParse(fx(n)).success, n).toBe(true);
    expect(ChecksConfigSchema.parse(fx('checks_config.json')).targets[0]!.proxy).toBe(true);
    expect(ApplyResultSchema.parse(fx('result_apply_config.json').data).rolledBack).toBe(true);
    expect(WelcomeSchema.parse(fx('welcome.json')).protocol).toBe(PROTOCOL_VERSION);
  });

  it('данные get_config и ответ enroll валидны', () => {
    const cfg = ConfigDataSchema.safeParse(fx('result_get_config.json').data);
    expect(cfg.success).toBe(true);
    expect(cfg.success && cfg.data.maps).toEqual([{ path: '/etc/haproxy/sni.map', content: 'de.example.com be_de\n' }]);
    // агент без поддержки карт не присылает поле: оно становится пустым списком
    const { maps: _maps, ...old } = fx('result_get_config.json').data;
    const legacy = ConfigDataSchema.safeParse(old);
    expect(legacy.success && legacy.data.maps).toEqual([]);
    expect(EnrollResponseSchema.safeParse(fx('enroll_response.json')).success).toBe(true);
  });

  it('каждая фикстура лежит в одном из тестов (нет забытых файлов)', () => {
    const known = new Set([
      'hello.json', 'metrics.json', 'result_get_config.json', 'welcome.json', 'cmd_get_config.json', 'enroll_response.json',
      'cmd_apply_config.json', 'cmd_apply_bans.json', 'cmd_get_clients.json', 'cmd_update_agent.json', 'cmd_run_checks.json', 'checks.json', 'checks_config.json', 'result_apply_config.json',
      'config_policy.json', // политика директив: проверяется в тестах панели и агента
    ]);
    for (const f of readdirSync(dir)) expect(known.has(f), f).toBe(true);
  });
});

describe('защита от чужих операций', () => {
  it('панель не может отправить произвольную команду', () => {
    for (const op of ['exec', 'shell', 'apply_config_raw', 'sh -c id']) {
      expect(CmdSchema.safeParse({ t: 'cmd', id: '1', op }).success, op).toBe(false);
    }
  });

  it('apply_config без аргументов или с лишним путём не проходит как команда с путями', () => {
    expect(PanelMessageSchema.safeParse({ t: 'cmd', id: '1', op: 'apply_config' }).success).toBe(false);
    const ok = PanelMessageSchema.safeParse({ t: 'cmd', id: '1', op: 'apply_config', args: { version: 1, cfg: 'x', sniMap: '', path: '/etc/passwd' } });
    expect(ok.success).toBe(true);
    // схема отбрасывает неизвестные поля: пути из команды до агента не доезжают
    expect(JSON.stringify(ok.success && ok.data)).not.toContain('/etc/passwd');
  });

  it('баны: слишком большой срок или мусор вместо IP-списка не проходят схему', () => {
    const bad = { t: 'cmd', id: '1', op: 'apply_bans', args: { full: true, ban: [{ ip: '1.2.3.4', ttlSec: 0 }], unban: [] } };
    expect(PanelMessageSchema.safeParse(bad).success).toBe(false);
    expect(PanelMessageSchema.safeParse({ t: 'cmd', id: '1', op: 'update_agent', args: { version: '1', sha256: 'zz' } }).success).toBe(false);
  });

  it('метрики с отрицательными байтами отклоняются', () => {
    const m = fx('metrics.json');
    m.sys.net.rxBytes = -1;
    expect(AgentMessageSchema.safeParse(m).success).toBe(false);
  });
});
