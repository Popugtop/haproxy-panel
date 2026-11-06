import { SegmentedRadioGroup, TextInput } from '@gravity-ui/uikit';
import type { PublicNode } from '../lib/api';
import { Field } from './ui';

export interface NodeFormValues {
  name: string;
  ip: string;
  domain: string;
  hoster: string;
  quotaTb: string;
  billingDay: string;
  quotaCounts: 'tx' | 'txrx';
  defaultIpLimitMbit: string;
}

export const emptyForm: NodeFormValues = { name: '', ip: '', domain: '', hoster: '', quotaTb: '', billingDay: '1', quotaCounts: 'tx', defaultIpLimitMbit: '' };

export const formFromNode = (n: PublicNode): NodeFormValues => ({
  name: n.name,
  ip: n.ip ?? '',
  domain: n.domain ?? '',
  hoster: n.hoster ?? '',
  quotaTb: n.quotaTb === null ? '' : String(n.quotaTb),
  billingDay: String(n.billingDay),
  quotaCounts: n.quotaCounts,
  defaultIpLimitMbit: n.defaultIpLimitMbit === null ? '' : String(n.defaultIpLimitMbit),
});

/** Тело запроса: пустые строки → null, числа → числа. */
export function formToBody(v: NodeFormValues) {
  const num = (s: string) => (s.trim() === '' ? null : Number(s.replace(',', '.')));
  return {
    name: v.name.trim(),
    ip: v.ip.trim() || null,
    domain: v.domain.trim() || null,
    hoster: v.hoster.trim() || null,
    quotaTb: num(v.quotaTb),
    billingDay: Number(v.billingDay) || 1,
    quotaCounts: v.quotaCounts,
    defaultIpLimitMbit: num(v.defaultIpLimitMbit),
  };
}

export function NodeFields({ value, onChange }: { value: NodeFormValues; onChange: (v: NodeFormValues) => void }) {
  const set = <K extends keyof NodeFormValues>(k: K, v: NodeFormValues[K]) => onChange({ ...value, [k]: v });
  return (
    <div className="form-grid">
      <Field label="Имя" wide>
        <TextInput value={value.name} onUpdate={(v) => set('name', v)} placeholder="Aeza · Стокгольм" autoFocus />
      </Field>
      <Field label="IP-адрес" help="Можно оставить пустым: подставится после подключения агента.">
        <TextInput value={value.ip} onUpdate={(v) => set('ip', v)} placeholder="203.0.113.10" controlProps={{ className: 'mono' }} />
      </Field>
      <Field label="Домен" help="Только для отображения.">
        <TextInput value={value.domain} onUpdate={(v) => set('domain', v)} placeholder="branch.popug.cloud" controlProps={{ className: 'mono' }} />
      </Field>
      <Field label="Хостер">
        <TextInput value={value.hoster} onUpdate={(v) => set('hoster', v)} placeholder="Aeza" />
      </Field>
      <Field label="Лимит скорости на IP, Мбит/с" help="По умолчанию для нод с HAProxy 2.7+. За одним IP бывает много людей (CGNAT у мобильных), лимит они делят.">
        <TextInput value={value.defaultIpLimitMbit} onUpdate={(v) => set('defaultIpLimitMbit', v)} placeholder="без лимита" />
      </Field>
      <Field label="Квота трафика, ТБ" help="Десятичные терабайты, как у хостера.">
        <TextInput value={value.quotaTb} onUpdate={(v) => set('quotaTb', v)} placeholder="не задана" />
      </Field>
      <Field label="День биллинга" help="С какого числа начинается расчётный месяц (по UTC).">
        <TextInput value={value.billingDay} onUpdate={(v) => set('billingDay', v)} />
      </Field>
      <Field label="Что считает хостер" wide>
        <SegmentedRadioGroup
          value={value.quotaCounts}
          onUpdate={(v) => set('quotaCounts', v as 'tx' | 'txrx')}
          options={[{ value: 'tx', content: 'Только исходящий (tx)' }, { value: 'txrx', content: 'Входящий + исходящий' }]}
        />
      </Field>
    </div>
  );
}
