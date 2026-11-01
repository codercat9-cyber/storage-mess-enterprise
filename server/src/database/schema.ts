// SQL схема базы данных KoteX Messenger

export const schema = `
-- Пользователи
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  email TEXT UNIQUE,
  password_hash TEXT NOT NULL,
  display_name TEXT,
  avatar_url TEXT,
  public_key TEXT,
  recovery_hash TEXT,
  status TEXT DEFAULT 'offline',
  last_seen DATETIME,
  push_token TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Контакты
CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  status TEXT DEFAULT 'pending', -- pending, accepted, blocked
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (contact_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE(user_id, contact_id)
);

-- Чаты
CREATE TABLE IF NOT EXISTS chats (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL DEFAULT 'private', -- private, group
  name TEXT,
  avatar_url TEXT,
  created_by TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (created_by) REFERENCES users(id)
);

-- Участники чатов
CREATE TABLE IF NOT EXISTS chat_members (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT DEFAULT 'member', -- admin, moderator, member
  joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_read_at DATETIME,
  notifications_enabled INTEGER DEFAULT 1,
  FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE(chat_id, user_id)
);

-- Сообщения
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  reply_to_id TEXT,
  content TEXT,
  encrypted_content TEXT,
  type TEXT DEFAULT 'text', -- text, image, video, audio, file, voice, system
  metadata TEXT, -- JSON с дополнительными данными
  edited_at DATETIME,
  deleted_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE,
  FOREIGN KEY (sender_id) REFERENCES users(id),
  FOREIGN KEY (reply_to_id) REFERENCES messages(id)
);

-- Статусы прочтения
CREATE TABLE IF NOT EXISTS message_reads (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  read_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE(message_id, user_id)
);

-- Файлы
CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  uploader_id TEXT NOT NULL,
  original_name TEXT NOT NULL,
  stored_name TEXT NOT NULL,
  mime_type TEXT,
  size INTEGER NOT NULL,
  storage_path TEXT NOT NULL,
  thumbnail_path TEXT,
  checksum TEXT,
  is_public INTEGER DEFAULT 0,
  download_count INTEGER DEFAULT 0,
  source TEXT DEFAULT 'storage',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (uploader_id) REFERENCES users(id)
);

-- Сессии звонков
CREATE TABLE IF NOT EXISTS calls (
  id TEXT PRIMARY KEY,
  chat_id TEXT,
  caller_id TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'audio', -- audio, video
  status TEXT DEFAULT 'pending', -- pending, active, ended, missed
  started_at DATETIME,
  ended_at DATETIME,
  duration INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (chat_id) REFERENCES chats(id),
  FOREIGN KEY (caller_id) REFERENCES users(id)
);

-- Участники звонков
CREATE TABLE IF NOT EXISTS call_participants (
  id TEXT PRIMARY KEY,
  call_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  status TEXT DEFAULT 'invited', -- invited, ringing, connected, left
  joined_at DATETIME,
  left_at DATETIME,
  FOREIGN KEY (call_id) REFERENCES calls(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id),
  UNIQUE(call_id, user_id)
);

-- Токены обновления (refresh tokens)
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token TEXT UNIQUE NOT NULL,
  device_info TEXT,
  ip_address TEXT,
  expires_at DATETIME NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Настройки пользователей
CREATE TABLE IF NOT EXISTS user_settings (
  id TEXT PRIMARY KEY,
  user_id TEXT UNIQUE NOT NULL,
  theme TEXT DEFAULT 'system',
  language TEXT DEFAULT 'ru',
  notifications_enabled INTEGER DEFAULT 1,
  sound_enabled INTEGER DEFAULT 1,
  two_factor_enabled INTEGER DEFAULT 0,
  two_factor_secret TEXT,
  settings_json TEXT, -- дополнительные настройки в JSON
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Реакции на сообщения
CREATE TABLE IF NOT EXISTS message_reactions (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  emoji TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE(message_id, user_id, emoji)
);

-- Удаления сообщений "для себя" (per-user)
CREATE TABLE IF NOT EXISTS message_deletions (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  deleted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE(message_id, user_id)
);

-- E2EE: Публичные ключи пользователей (аналог Mimir Tracker)
-- Сервер хранит только публичные ключи, приватные — только на клиенте
CREATE TABLE IF NOT EXISTS user_public_keys (
  id TEXT PRIMARY KEY,
  user_id TEXT UNIQUE NOT NULL,
  signing_key TEXT NOT NULL,        -- JWK JSON — ECDSA P-256 public key (подпись)
  exchange_key TEXT NOT NULL,       -- JWK JSON — ECDH P-256 public key (обмен ключами)
  signing_fingerprint TEXT NOT NULL,
  exchange_fingerprint TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- E2EE: ключи ПО УСТРОЙСТВАМ.
--
-- В user_public_keys выше на человека приходится ровно одна пара ключей
-- (user_id объявлен UNIQUE), а создаётся она на устройстве. Значит вход с
-- компьютера затирал ключи телефона: телефон оставался с приватным ключом,
-- которому больше ничего не соответствует, и переписка рвалась у всех, у
-- кого больше одного устройства. Из-за этого шифрование и нельзя было
-- включить.
--
-- Теперь у каждого устройства своя пара, а отправитель шифрует копию для
-- каждого устройства получателя. Старая таблица не удаляется: она нужна
-- для отката и хранит исходные ключи, перенесённые сюда как «legacy».
CREATE TABLE IF NOT EXISTS user_device_keys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  device_id TEXT NOT NULL,          -- своё у каждой установки приложения
  device_label TEXT,                -- «Телефон», «Компьютер» — для списка устройств
  signing_key TEXT NOT NULL,        -- JWK JSON — ECDSA P-256 (подпись)
  exchange_key TEXT NOT NULL,       -- JWK JSON — ECDH P-256 (обмен ключами)
  signing_fingerprint TEXT NOT NULL,
  exchange_fingerprint TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_seen_at DATETIME,
  UNIQUE(user_id, device_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_user_device_keys_user ON user_device_keys(user_id);

-- Индексы для оптимизации
CREATE INDEX IF NOT EXISTS idx_messages_chat_id ON messages(chat_id);
CREATE INDEX IF NOT EXISTS idx_messages_sender_id ON messages(sender_id);
CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
CREATE INDEX IF NOT EXISTS idx_message_deletions_user ON message_deletions(user_id);
CREATE INDEX IF NOT EXISTS idx_message_deletions_message ON message_deletions(message_id);
CREATE INDEX IF NOT EXISTS idx_chat_members_user_id ON chat_members(user_id);
CREATE INDEX IF NOT EXISTS idx_chat_members_chat_id ON chat_members(chat_id);
CREATE INDEX IF NOT EXISTS idx_contacts_user_id ON contacts(user_id);
CREATE INDEX IF NOT EXISTS idx_files_uploader_id ON files(uploader_id);
CREATE INDEX IF NOT EXISTS idx_calls_caller_id ON calls(caller_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_id ON refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_user_public_keys_user_id ON user_public_keys(user_id);
CREATE INDEX IF NOT EXISTS idx_message_reactions_message ON message_reactions(message_id);
CREATE INDEX IF NOT EXISTS idx_message_reactions_user ON message_reactions(user_id);

-- Токены сброса пароля через email
CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token TEXT UNIQUE NOT NULL,
  expires_at DATETIME NOT NULL,
  used INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_token ON password_reset_tokens(token);

-- Пользовательские перезаписи контактов (локальные ники и аватары, синхронизируемые на сервер)
CREATE TABLE IF NOT EXISTS user_contact_overrides (
  user_id TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  local_nickname TEXT,
  local_avatar_url TEXT,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, contact_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (contact_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_contact_overrides_user ON user_contact_overrides(user_id);
-- Отключение уведомлений от конкретного человека.
--
-- Живёт здесь же, где прозвище и своя аватарка контакта: это личная
-- настройка ОДНОГО человека про ДРУГОГО, и у каждого она своя. Сообщения
-- при этом приходят и лежат в переписке как обычно — беззвучно.
`;

// Миграции для существующих баз (ALTER TABLE не поддерживает IF NOT EXISTS в SQLite)
export const migrations = [
  `ALTER TABLE users ADD COLUMN recovery_hash TEXT`,
  `CREATE TABLE IF NOT EXISTS password_reset_tokens (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, token TEXT UNIQUE NOT NULL, expires_at DATETIME NOT NULL, used INTEGER DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE)`,
  `CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_token ON password_reset_tokens(token)`,
  `ALTER TABLE files ADD COLUMN source TEXT DEFAULT 'storage'`,
  `CREATE TABLE IF NOT EXISTS message_reactions (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, user_id TEXT NOT NULL, emoji TEXT NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE, FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE, UNIQUE(message_id, user_id, emoji))`,
  `CREATE INDEX IF NOT EXISTS idx_message_reactions_message ON message_reactions(message_id)`,
  `CREATE INDEX IF NOT EXISTS idx_message_reactions_user ON message_reactions(user_id)`,
  `CREATE TABLE IF NOT EXISTS user_contact_overrides (user_id TEXT NOT NULL, contact_id TEXT NOT NULL, local_nickname TEXT, local_avatar_url TEXT, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (user_id, contact_id), FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE, FOREIGN KEY (contact_id) REFERENCES users(id) ON DELETE CASCADE)`,
  // Отключение уведомлений от конкретного человека. Добавляем отдельной
  // строкой: у тех, кто обновляется, таблица уже создана без этой колонки.
  `ALTER TABLE user_contact_overrides ADD COLUMN muted INTEGER NOT NULL DEFAULT 0`,
  // Когда подписку на уведомления в последний раз подтверждали. Без этого
  // по базе не отличить живую подписку от заброшенной: дата создания
  // остаётся первой навсегда, сколько бы раз человек ни заходил.
  `ALTER TABLE push_subscriptions ADD COLUMN last_seen_at DATETIME`,
  `CREATE INDEX IF NOT EXISTS idx_contact_overrides_user ON user_contact_overrides(user_id)`,
  `ALTER TABLE users ADD COLUMN push_token TEXT`,

  // ── Админский аккаунт ──
  // Роль хранится в самой учётке, а не общим секретом в заголовке:
  // секрет один на всех, его нельзя отозвать у одного человека, он не
  // говорит КТО сделал действие и утекает целиком вместе с ярлыком.
  `ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'user'`,
  // Блокировка — отметка времени, а не флаг: сразу видно когда и,
  // вместе с журналом, кто и почему.
  `ALTER TABLE users ADD COLUMN blocked_at DATETIME`,
  `ALTER TABLE users ADD COLUMN blocked_reason TEXT`,
  // Когда менялся пароль. Нужен проверке старых токенов обновления: токен,
  // выданный до смены пароля, принимать нельзя (см. auth.routes, амнистия).
  // updated_at для этого не годится — он меняется при каждой смене статуса.
  `ALTER TABLE users ADD COLUMN password_changed_at DATETIME`,

  // Журнал действий администратора. Пишется ДО того, как действие
  // выполнено, и на просмотр чужого сообщения тоже: правило «смотрю
  // только когда позвали чинить» имеет смысл, только если каждый
  // просмотр оставляет след.
  `CREATE TABLE IF NOT EXISTS admin_audit (
     id TEXT PRIMARY KEY,
     admin_id TEXT NOT NULL,
     admin_name TEXT,
     action TEXT NOT NULL,
     target_type TEXT,
     target_id TEXT,
     details TEXT,
     ip TEXT,
     created_at DATETIME DEFAULT CURRENT_TIMESTAMP
   )`,
  `CREATE INDEX IF NOT EXISTS idx_admin_audit_created ON admin_audit(created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_users_role ON users(role)`,

  // Push-токены ПО УСТРОЙСТВАМ, а не один на человека.
  //
  // Раньше токен лежал одной колонкой в users, и регистрация со второго
  // устройства затирала токен первого: уведомления начинали приходить
  // только на то устройство, которое подключилось последним. Второе
  // выглядело мёртвым, пока его не откроешь руками — снаружи это читалось
  // как «сидишь с двух устройств, одно отваливается».
  //
  // Ключ — сам токен: FCM выдаёт его на связку приложение+устройство, так
  // что повторная регистрация того же устройства обновляет строку, а не
  // плодит дубли.
  `CREATE TABLE IF NOT EXISTS push_tokens (
     token TEXT PRIMARY KEY,
     user_id TEXT NOT NULL,
     platform TEXT,
     device_label TEXT,
     created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
     last_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
     FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
   )`,
  `CREATE INDEX IF NOT EXISTS idx_push_tokens_user ON push_tokens(user_id)`,

  // Переносим то, что уже накопилось в старой колонке, чтобы никто не
  // остался без уведомлений после обновления.
  `INSERT OR IGNORE INTO push_tokens (token, user_id, platform, device_label)
     SELECT push_token, id, 'android', 'перенесено со старой схемы'
     FROM users WHERE push_token IS NOT NULL AND push_token <> ''`,

  // Веб-подписки на уведомления (VAPID).
  //
  // Лежали в обычной Map в памяти процесса с комментарием «в проде можно
  // вынести в SQLite». В прод так и уехало: каждый перезапуск сервера
  // стирал подписки у всех сразу, и до следующего захода в приложение
  // человек не получал ничего. Вместе с выключенным FCM это означало, что
  // уведомления на боевом фактически не работали — а выглядело как
  // «второе устройство отвалилось».
  `CREATE TABLE IF NOT EXISTS push_subscriptions (
     endpoint TEXT PRIMARY KEY,
     user_id TEXT NOT NULL,
     p256dh TEXT NOT NULL,
     auth TEXT NOT NULL,
     created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
     FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
   )`,
  `CREATE INDEX IF NOT EXISTS idx_push_subs_user ON push_subscriptions(user_id)`,

  // Обращения «позвать админа».
  //
  // Это вторая половина правила «администратор смотрит переписку, только
  // когда позвали чинить». До сих пор была только половина: сам просмотр
  // писался в журнал, но позвать было нечем — человек жаловался в личку, и
  // формального «меня позвали» не существовало. Теперь у обращения есть
  // номер, и админ, открывая сообщение, ссылается на него.
  //
  // consent_scope — на что человек согласился: 'none' (просто проблема),
  // 'diagnostics' (счётчики без содержимого), 'messages' (можно смотреть
  // указанные сообщения в этом чате).
  `CREATE TABLE IF NOT EXISTS support_requests (
     id TEXT PRIMARY KEY,
     user_id TEXT NOT NULL,
     subject TEXT,
     details TEXT,
     chat_id TEXT,
     consent_scope TEXT NOT NULL DEFAULT 'none',
     app_version TEXT,
     device_label TEXT,
     status TEXT NOT NULL DEFAULT 'open',
     handled_by TEXT,
     resolution TEXT,
     created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
     closed_at DATETIME,
     FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
   )`,
  `CREATE INDEX IF NOT EXISTS idx_support_status ON support_requests(status, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_support_user ON support_requests(user_id)`,

  // Перенос ключей в схему по устройствам. Тем, кто публиковал ключи до
  // разделения, приписываем устройство «legacy»: чьё именно оно было,
  // сказать нельзя, но выбрасывать ключ нельзя тем более — пока человек не
  // зайдёт заново и не опубликует ключ уже под своим устройством, это
  // единственное, чем ему можно зашифровать.
  // OR IGNORE — чтобы повторный запуск ничего не задел.
  //
  // Сироты отсеиваются условием EXISTS, и это не перестраховка: в базе
  // нашёлся ключ от давно удалённой учётки, и на нём валился весь перенос
  // целиком — все 46 записей из-за одной. Ошибка при этом проглатывалась
  // молча (миграции идут в try/catch), так что снаружи это выглядело как
  // «таблица есть, а данных нет».
  `DELETE FROM user_public_keys
    WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = user_public_keys.user_id)`,

  // Токены обновления от удалённых учёток. Внешний ключ с каскадом у таблицы
  // объявлен, но срабатывает он только при включённых `foreign_keys`, а
  // когда-то записи удалялись без них — остались висеть. Сами по себе они
  // безвредны (пользователя нет, войти по ним некому), но проверка
  // целостности при каждом запуске честно ругается на нарушения, и в этом
  // шуме потом не разглядеть настоящую поломку.
  `DELETE FROM refresh_tokens
    WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = refresh_tokens.user_id)`,

  `DELETE FROM user_settings
    WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = user_settings.user_id)`,

  `DELETE FROM user_contact_overrides
    WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = user_contact_overrides.user_id)
       OR NOT EXISTS (SELECT 1 FROM users u WHERE u.id = user_contact_overrides.contact_id)`,

  `DELETE FROM push_tokens
    WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = push_tokens.user_id)`,

  `DELETE FROM chat_members
    WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = chat_members.user_id)`,

  `INSERT OR IGNORE INTO user_device_keys
     (id, user_id, device_id, device_label, signing_key, exchange_key,
      signing_fingerprint, exchange_fingerprint, created_at, updated_at)
   SELECT k.id, k.user_id, 'legacy', 'До разделения по устройствам',
          k.signing_key, k.exchange_key, k.signing_fingerprint, k.exchange_fingerprint,
          k.created_at, k.updated_at
     FROM user_public_keys k
    WHERE EXISTS (SELECT 1 FROM users u WHERE u.id = k.user_id)`,
  // Жалобы на содержимое. Модератор и админ видят ровно то сообщение, на
  // которое пожаловались, — не переписку целиком; каждый просмотр и каждое
  // решение пишутся в admin_audit.
  `CREATE TABLE IF NOT EXISTS content_reports (
     id TEXT PRIMARY KEY,
     reporter_id TEXT NOT NULL,
     message_id TEXT NOT NULL,
     chat_id TEXT NOT NULL,
     reported_user_id TEXT,
     reason TEXT NOT NULL,
     comment TEXT,
     status TEXT NOT NULL DEFAULT 'open',
     handled_by TEXT,
     resolution TEXT,
     created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
     closed_at DATETIME
   )`,
  `CREATE INDEX IF NOT EXISTS idx_reports_status ON content_reports(status, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_reports_message ON content_reports(message_id)`,

  // Какую редакцию правил человек принял и когда.
  // Сквозной номер сообщения от клиента (аварийная шина: сервер, mesh, LoRa)
  `ALTER TABLE messages ADD COLUMN client_id TEXT`,
  `CREATE INDEX IF NOT EXISTS idx_messages_client ON messages(sender_id, client_id)`,
  `ALTER TABLE users ADD COLUMN terms_version TEXT`,
  `ALTER TABLE users ADD COLUMN terms_accepted_at DATETIME`,

  // ── Корпоративный контур (src/enterprise) ──────────────────────────
  // Откуда учётка: 'local' — свой пароль в базе (в т. ч. аварийный админ),
  // 'directory' — создана из каталога, пароль проверяет домен/RADIUS.
  `ALTER TABLE users ADD COLUMN auth_source TEXT NOT NULL DEFAULT 'local'`,
  // objectGUID — единственное, что у сотрудника не меняется: DN меняется
  // при переводе в другое OU, логин — при смене фамилии.
  `ALTER TABLE users ADD COLUMN directory_guid TEXT`,
  `ALTER TABLE users ADD COLUMN directory_dn TEXT`,
  // active | disabled | locked | expired | not_in_group | removed
  `ALTER TABLE users ADD COLUMN directory_state TEXT`,
  `ALTER TABLE users ADD COLUMN directory_synced_at DATETIME`,
  // Блокировку поставил каталог — значит, каталог вправе её и снять.
  // Ручную блокировку администратора (0) каталог не трогает никогда.
  `ALTER TABLE users ADD COLUMN blocked_by_directory INTEGER NOT NULL DEFAULT 0`,
  // Роль admin выдана группой ENT_LDAP_ADMIN_GROUP_DN (и снимется вместе с ней).
  `ALTER TABLE users ADD COLUMN directory_admin INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE users ADD COLUMN department TEXT`,
  `ALTER TABLE users ADD COLUMN title TEXT`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_directory_guid ON users(directory_guid) WHERE directory_guid IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_users_auth_source ON users(auth_source)`,
  `CREATE TABLE IF NOT EXISTS enterprise_events (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     at DATETIME NOT NULL,
     kind TEXT NOT NULL,
     user_id TEXT,
     username TEXT,
     detail TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS idx_enterprise_events_at ON enterprise_events(at)`,
  // Сертификаты ключей устройств, подписанные корпоративным УЦ.
  // Отозванный ключ остаётся отозванным навсегда — повторно его не подпишем.
  `CREATE TABLE IF NOT EXISTS device_certs (
     id TEXT PRIMARY KEY,
     user_id TEXT NOT NULL,
     username TEXT NOT NULL,
     ed_pub TEXT NOT NULL UNIQUE,
     label TEXT,
     issued_at DATETIME NOT NULL,
     expires_at DATETIME NOT NULL,
     revoked_at DATETIME,
     revoke_reason TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS idx_device_certs_user ON device_certs(user_id, revoked_at)`,
  `CREATE INDEX IF NOT EXISTS idx_device_certs_revoked ON device_certs(revoked_at)`,
  `CREATE TABLE IF NOT EXISTS enterprise_state (
     key TEXT PRIMARY KEY,
     value TEXT,
     updated_at DATETIME
   )`,
];

export default schema;
