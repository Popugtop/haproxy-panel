// Администрирование из контейнера: docker compose exec panel node dist/cli.js <команда>
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import { loadConfig } from './config.js';
import { connect, schema } from './db/index.js';
import { audit, SYSTEM } from './lib/audit.js';
import { destroyUserSessions, hashPassword, validatePasswordStrength } from './lib/auth.js';

const USAGE = `Использование:
  cli.js create-admin <логин> [--password <пароль>]   создать администратора (пароль, если не задан, сгенерируется)
  cli.js reset-password <логин> [--password <пароль>] сменить пароль и завершить все сессии
  cli.js reset-totp <логин>                           сбросить TOTP: при следующем входе нужно настроить заново
  cli.js list-users`;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

const generatePassword = () => randomBytes(18).toString('base64url');

async function main(): Promise<number> {
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd || cmd === '--help' || cmd === '-h') {
    console.log(USAGE);
    return cmd ? 0 : 2;
  }
  const config = loadConfig();
  const migrations = resolve(process.env.MIGRATIONS_DIR ?? new URL('../drizzle', import.meta.url).pathname);
  const { db, close } = await connect(config.DATABASE_URL, migrations);
  try {
    const login = args[0]?.toLowerCase();
    switch (cmd) {
      case 'create-admin': {
        if (!login || login.startsWith('--')) throw new Error('Укажите логин');
        const given = flag(args, '--password');
        const password = given ?? generatePassword();
        const weak = validatePasswordStrength(password);
        if (weak) throw new Error(weak);
        const [exists] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.login, login));
        if (exists) throw new Error(`Пользователь ${login} уже существует`);
        const [u] = await db.insert(schema.users).values({ login, passwordHash: await hashPassword(password) }).returning();
        await audit(db, SYSTEM, 'user.create', { type: 'user', id: u!.id }, { login }, null);
        console.log(`Администратор создан: ${login}`);
        if (!given) console.log(`Пароль (показывается один раз): ${password}`);
        console.log('При первом входе панель попросит настроить TOTP.');
        return 0;
      }
      case 'reset-password': {
        if (!login) throw new Error('Укажите логин');
        const given = flag(args, '--password');
        const password = given ?? generatePassword();
        const weak = validatePasswordStrength(password);
        if (weak) throw new Error(weak);
        const [u] = await db.update(schema.users).set({ passwordHash: await hashPassword(password), failedLogins: 0, lockedUntil: null }).where(eq(schema.users.login, login)).returning();
        if (!u) throw new Error(`Пользователь ${login} не найден`);
        await destroyUserSessions(db, u.id);
        await audit(db, SYSTEM, 'user.reset_password', { type: 'user', id: u.id }, { login }, null);
        console.log(`Пароль изменён, сессии завершены.${given ? '' : ` Новый пароль: ${password}`}`);
        return 0;
      }
      case 'reset-totp': {
        if (!login) throw new Error('Укажите логин');
        const [u] = await db.update(schema.users).set({ totpEnabled: false, totpSecretEnc: null, totpPendingEnc: null, totpLastStep: null }).where(eq(schema.users.login, login)).returning();
        if (!u) throw new Error(`Пользователь ${login} не найден`);
        await destroyUserSessions(db, u.id);
        await audit(db, SYSTEM, 'user.reset_totp', { type: 'user', id: u.id }, { login }, null);
        console.log('TOTP сброшен. При следующем входе его нужно настроить заново.');
        return 0;
      }
      case 'list-users': {
        for (const u of await db.select().from(schema.users)) console.log(`${u.login}\t${u.role}\ttotp=${u.totpEnabled ? 'да' : 'нет'}${u.disabled ? '\tотключён' : ''}`);
        return 0;
      }
      default:
        console.error(USAGE);
        return 2;
    }
  } finally {
    await close();
  }
}

main().then(
  (code) => process.exit(code),
  (err: Error) => {
    console.error(`Ошибка: ${err.message}`);
    process.exit(1);
  },
);
